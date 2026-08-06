/**
 * relay.gs — the orchestration.
 *
 * Runs once a minute on a time-driven trigger: find the drafts you marked, hand
 * them to SES as one of your verified domains, file the result in Sent.
 *
 * The supporting parts live next door — state.gs (what has already happened),
 * inference.gs (which domain to send as), gmail.gs (Gmail I/O), notify.gs (how
 * failures reach you), and the pure, Node-tested mime.gs and sigv4.gs. This
 * file holds only the decisions.
 *
 * Each step closes a numbered item in docs/relay-premortem.md, named inline.
 */

/** Trigger entry point. */
function relayTick() {
  // Premortem 6: overlapping runs would double-send. A second run exits rather
  // than queuing — the work is marker-driven and the next tick will pick it up.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('another run holds the lock; skipping this tick');
    return;
  }

  try {
    var props = PropertiesService.getScriptProperties();

    // One remote read serves both configuration and state.
    var snapshot = props.getProperties();
    var cfg = getConfig(snapshot);
    var state = loadState(snapshot);
    var before = snapshot[PROP_STATE] || '';

    reconcileInflight(props, state);

    var sent = 0;
    var unreadable = 0;
    var drafts = GmailApp.getDrafts();

    for (var i = 0; i < drafts.length; i++) {
      var decision;
      try {
        decision = classifyDraft(drafts[i], cfg, state);
      } catch (e) {
        // GmailApp.getDrafts() returns drafts it cannot then read — a scheduled
        // send, or one in some other state that rejects getMessage() with
        // "Gmail operation not allowed". Letting that propagate would abort the
        // whole run, so a single unrelated draft sitting in the mailbox would
        // silently stop all outbound mail. Skip it and keep going.
        unreadable++;
        console.warn('skipping unreadable draft: ' + errorText(e));
        continue;
      }

      if (decision.action === 'send') {
        if (processDraft(drafts[i], decision, cfg, props, state)) sent++;
      } else if (decision.action === 'fail') {
        reportNotSent(drafts[i], decision, new Error(decision.reason), state, props);
      }
    }

    if (unreadable > 0) {
      console.log('skipped ' + unreadable + ' unreadable draft(s) of ' + drafts.length);
    }

    // Premortem 3: the heartbeat is what proves this ran at all. A watchdog
    // outside Apps Script reads it, because one inside cannot report its death.
    putRelayHeartbeat(cfg, sent);

    pruneState(state);
    // Only write when something actually changed: an idle mailbox would
    // otherwise cost a remote write every minute, forever.
    var after = JSON.stringify(state);
    if (after !== before) props.setProperty(PROP_STATE, after);
  } catch (err) {
    // A configuration or Gmail-level failure would otherwise be silent.
    console.error(errorText(err, true));
    tryAlert('Relay run failed', errorText(err, true));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decide what to do with one draft: send it, refuse it, or leave it alone.
 *
 * Premortem 9: two independent markers. A label works on the web; a subject
 * token works anywhere text can be typed, including mobile compose where
 * labelling a draft is awkward or unavailable. Either one sends.
 */
function classifyDraft(draft, cfg, state) {
  var id = draft.getId();

  // Cheapest checks first, before any Gmail call. `consumed` is the resend
  // guard; `inflight` is cleared by reconcileInflight before we get here, so a
  // surviving entry means that reconciliation itself could not finish.
  if (state.consumed[id] || state.inflight[id]) return { action: 'skip' };

  var message = draft.getMessage();
  var subject = message.getSubject() || '';
  var token = parseSubjectToken(subject, cfg.domains, cfg.defaultLocalpart, cfg.subjectToken);

  var context = threadContext(message);
  var labelled = context.labelNames.indexOf(LABEL_OUTBOX) !== -1;
  if (!labelled && !token.marked) return { action: 'skip' };

  // A draft that already failed is not retried on its own — without this, a
  // permanent failure retries every minute and emails on each attempt.
  // Retrying is therefore a deliberate gesture, and either of the two available
  // ones counts, so a subject-token workflow is never forced to reach for a
  // label (which is awkward on mobile, the reason the token exists).
  var failed = state.failed[id];
  if (failed) {
    var editedSince = failed.draftDate && message.getDate().getTime() > failed.draftDate;
    if (!labelled && !editedSince) return { action: 'skip' };
    delete state.failed[id];
  }

  // Premortem 5: never send a draft that is still being typed. This doubles as
  // the undo window — unmark within it and nothing goes out.
  if (new Date().getTime() - message.getDate().getTime() < cfg.settleSeconds * 1000) {
    return { action: 'skip' };
  }

  // Premortem 8: work out which domain, and refuse rather than guess.
  var ctx = aliasContext(id, token, context.labelNames, context.thread, cfg);
  var alias = resolveSendAlias(ctx);

  var common = {
    subject: token.marked ? token.subject : subject,
    thread: context.thread,
    diagnostic: ctx.diag.join('\n  '),
  };

  if (!alias) {
    common.action = 'fail';
    common.reason =
      'Could not tell which domain to send as. This is a new message, or a ' +
      'reply in a thread with no address on your domains, so there is nothing ' +
      'to infer from.\n\nName the domain in the subject — ">>' +
      (cfg.domains[0] || 'yourdomain') + ' Your subject" — or add a "' +
      LABEL_FROM_PREFIX + '<domain>" label.';
    return common;
  }

  common.action = 'send';
  common.alias = alias;
  common.labelled = labelled;
  return common;
}

/**
 * Build and validate the outgoing message. Throws with a message written for
 * the person who has to fix the draft, since that is what reaches them.
 */
function prepareOutbound(draftId, decision, cfg, messageId) {
  var built = buildOutbound(fetchRawDraft(draftId), {
    from: decision.alias,
    messageId: messageId,
    subject: decision.subject,
    domainNames: cfg.domainNames,
  });

  var bytes = utf8ByteLength(built.transmit);
  if (bytes > SES_MAX_RAW_BYTES) {
    throw new Error(
      'Message is ' + Math.round(bytes / 1048576) + ' MB; SES will not send ' +
      'anything over 10 MB. Shrink the attachments.'
    );
  }

  var checked = validateRecipients(built.recipients);
  if (checked.bad.length) {
    throw new Error(
      'These recipients are not valid addresses: ' + checked.bad.join(', ') +
      '. Nothing was sent — fix them and re-mark the draft.'
    );
  }
  if (checked.total === 0) throw new Error('The draft has no recipients.');

  built.checked = checked;
  return built;
}

/**
 * Send one draft. Returns true when SES accepted it.
 *
 * The ordering here is the single most important thing in this file. Premortem
 * item 1: the draft is marked consumed and persisted BEFORE the network call,
 * so a crash mid-send can never cause a resend; the in-flight record is cleared
 * LAST, so a crash anywhere in between is detectable rather than silent.
 */
function processDraft(draft, decision, cfg, props, state) {
  var id = draft.getId();
  var messageId = newMessageId(decision.alias);
  var accepted = false;

  try {
    var built = prepareOutbound(id, decision, cfg, messageId);

    // Point of no return.
    var now = new Date().getTime();
    state.consumed[id] = { at: now };
    state.inflight[id] = { messageId: messageId, subject: decision.subject, at: now };
    saveState(props, state);
    if (decision.labelled && decision.thread) removeLabel(decision.thread, LABEL_OUTBOX);

    sesSendRaw(cfg, decision.alias, built.checked.ok, built.transmit);
    accepted = true;

    archiveToSent(built.archive, decision.thread);
    draft.deleteDraft();

    // Both cleared only once the draft is gone, so its id can never come round
    // again. The end-of-tick write persists this.
    delete state.inflight[id];
    delete state.consumed[id];
    console.log('sent ' + messageId + ' as ' + decision.alias);
    return true;
  } catch (err) {
    if (accepted) {
      // SES already has this message. Filing or deleting failed afterwards, so
      // the draft may still be sitting there — but clearing `consumed` would
      // make the next run send it a second time. Keep the marker, keep the
      // draft, ask for a human.
      reportNeedsReview(
        id,
        { messageId: messageId, subject: decision.subject },
        errorText(err),
        state,
        props
      );
      return true;
    }

    delete state.inflight[id];
    delete state.consumed[id];
    reportNotSent(draft, decision, err, state, props);
    return false;
  }
}
