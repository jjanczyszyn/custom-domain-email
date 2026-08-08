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

/**
 * How the per-tick draft scan is bounded. See premortem item 18 — every one of
 * these exists to keep a once-a-minute trigger inside Gmail's 20,000-call day.
 */

// Drafts touched inside this window are the ones that could have just gained a
// subject token. Gmail's granularity here is a day, which is the smallest this
// can usefully be.
var RECENT_DRAFT_WINDOW = 'newer_than:1d';

// How often an unchanged draft's subject is re-read anyway. Gmail replaces a
// draft's message id on every edit, so a change is normally noticed for free;
// this is the backstop for a marking that somehow leaves the id alone, and
// bounds that case to ten minutes rather than an hour.
var SUBJECT_RECHECK_MS = 10 * 60 * 1000;

// How often every draft in the mailbox is examined regardless. The narrow
// queries are an optimisation, and this is what makes them safe to be wrong:
// anything they miss still goes out, an hour late rather than never.
var FULL_SWEEP_MS = 60 * 60 * 1000;

// Enough to cover any plausible number of genuinely pending drafts without
// letting one tick walk an unbounded list.
var SCAN_LIMIT = 50;

// How long Gmail work stays suspended after a tick dies on the daily quota.
// Once that quota is gone every Gmail call fails identically until the day's
// window rolls over, which can be most of a day — retrying every minute is
// 1,440 doomed calls that all report the same thing. Probing twice an hour
// notices the reset within half an hour of it happening, which is nothing
// against an outage measured in hours, and keeps the execution log readable.
var QUOTA_PAUSE_MS = 30 * 60 * 1000;

/** Trigger entry point. */
function relayTick() {
  // Premortem 6: overlapping runs would double-send. A second run exits rather
  // than queuing — the work is marker-driven and the next tick will pick it up.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('another run holds the lock; skipping this tick');
    return;
  }

  // Declared out here so the failure path can see them, but assigned INSIDE the
  // try: everything that can throw belongs under the catch, or the failure is
  // silent. They stay null until genuinely loaded, because a null state must
  // never be mistaken for an empty one — saveState would then write empty
  // buckets over the consumed markers, and consumed is what stops a resend.
  var props = null;
  var state = null;
  var cfg = null;

  try {
    props = PropertiesService.getScriptProperties();
    var snapshot = props.getProperties(); // one remote read serves config and state
    state = loadState(snapshot);
    cfg = getConfig(snapshot);

    // A quota pause set by an earlier tick. The trigger is alive and must say
    // so — the heartbeat is what stops the external watchdog reporting the
    // relay dead, and during a quota outage it is telling the truth: the
    // script runs, it just declines to spend Gmail calls it does not have.
    // The operator already has exactly one email about the episode.
    var pause = state.pauses['gmail'];
    if (pause && pause.until && new Date().getTime() < pause.until) {
      var wait = Math.ceil((pause.until - new Date().getTime()) / 60000);
      console.log('gmail quota pause active; next probe in ~' + wait + ' min');
      putRelayHeartbeat(cfg, 0);
      return;
    }

    reconcileInflight(props, state);

    var sent = 0;
    var unreadable = 0;
    var scan = collectDrafts(cfg, state, new Date().getTime());
    var drafts = scan.drafts;

    for (var i = 0; i < drafts.length; i++) {
      var decision;
      try {
        decision = classifyDraft(drafts[i], cfg, state);
      } catch (e) {
        // The daily quota is the exception to the skip below: it is not a
        // property of this draft, and every draft after it fails the same way
        // at a Gmail call per attempt. Surface it so the run-level handler
        // pauses Gmail work now, not one warning-filled tick from now.
        if (isServiceQuotaError(e)) throw e;

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
    console.log(scan.mode + ' scan examined ' + drafts.length + ' draft(s), sent ' + sent);

    // Premortem 3: the heartbeat is what proves this ran at all. A watchdog
    // outside Apps Script reads it, because one inside cannot report its death.
    putRelayHeartbeat(cfg, sent);

    pruneState(state);
    // saveState is a no-op when nothing changed, so an idle mailbox costs no
    // remote write. It must still be called: a send that added and removed an
    // in-flight entry ends the tick looking unchanged, yet the property holds
    // the intermediate write and needs correcting.
    saveState(props, state);
  } catch (err) {
    // A configuration or Gmail-level failure would otherwise be silent. It is
    // also, by nature, the kind of failure that repeats on every tick — so this
    // alert is throttled. Unthrottled it would send the same mail 1,440 times a
    // day, which both buries the mailbox and burns the 100-recipients-a-day
    // sending quota that the per-draft alerts actually need.
    // reportRunFailed persists its own throttle marker, and tolerates a null
    // state by alerting without throttling — which is the right way round: an
    // unthrottled alert is noisy, a missing one is invisible.
    //
    // A quota death additionally suspends Gmail work (see QUOTA_PAUSE_MS):
    // ticks inside the pause heartbeat and exit rather than repeating this
    // same failure once a minute for the rest of the day. reportRunFailed's
    // unconditional save is what persists the pause entry.
    if (state && isServiceQuotaError(err)) {
      var paused = new Date().getTime();
      state.pauses['gmail'] = { at: paused, until: paused + QUOTA_PAUSE_MS };
    }
    console.error(errorText(err, true));
    reportRunFailed(err, state, props);

    // A failing tick is not a silent one. The watchdog exists to catch true
    // silence — a disabled trigger, revoked auth — where nothing runs and
    // nothing can email; a tick that ran far enough to load its config is
    // loudly alive, and its failure is already reported (throttled) above.
    // Without this, any failure streak past an hour also draws the canary's
    // "relay silent" mail every hour on top of the run-failed alert.
    // Deliberately last: a crash inside the failure path itself skips the
    // heartbeat, which is then the watchdog's honest cue to fire.
    if (cfg) putRelayHeartbeat(cfg, 0);
  } finally {
    lock.releaseLock();
  }
}

/**
 * The drafts this tick will examine.
 *
 * Premortem 18: the obvious implementation — walk every draft, classify each —
 * costs a Gmail call or three per draft per minute, and a mailbox with a few
 * dozen abandoned drafts exhausts the daily quota before lunch. It did.
 *
 * So most ticks ask two narrow questions instead, neither of which scales with
 * the mailbox: which drafts carry the Outbox label, and which were touched
 * recently enough to have just gained a subject token. Once an hour the old
 * exhaustive walk still runs, so the narrow queries are an optimisation whose
 * failure mode is lateness rather than silence.
 */
function collectDrafts(cfg, state, now) {
  if (dueAgain(state, 'sweeps', 'full', FULL_SWEEP_MS, now)) {
    return { mode: 'full', drafts: GmailApp.getDrafts() };
  }

  var ids = selectMarkedDrafts(
    labelledDrafts(SCAN_LIMIT),
    listDrafts(RECENT_DRAFT_WINDOW, SCAN_LIMIT),
    state,
    cfg,
    now,
    draftSubjectByMessageId
  );

  var drafts = [];
  for (var i = 0; i < ids.length; i++) {
    var draft = draftById(ids[i]);
    if (draft) drafts.push(draft);
  }
  return { mode: 'targeted', drafts: drafts };
}

/**
 * Decide which of the candidate drafts are worth a full classification.
 *
 * A labelled draft is marked by definition and needs no further reading. A
 * recently-touched one might have gained a subject token, so its subject is
 * read — but only when the draft has actually changed since we last looked,
 * which Gmail reveals for free by replacing the message id on every edit.
 *
 * The memo remembers the ANSWER, not just the visit. A draft found marked
 * stays picked on every tick without re-reading anything — necessary because
 * classification can decline to send it yet (the settle window), and a memo
 * that only said "seen recently" would then hide the draft for the whole
 * ten-minute recheck. That is how the very first token-marked send went out
 * ten minutes late: seen at 34 seconds old, skipped as settling, and not
 * looked at again until the recheck. Unmarking still works: editing the
 * subject replaces the message id, which invalidates the memo.
 *
 * `readSubject` is injected so this stays testable without Gmail, and returns
 * null for a draft it cannot read.
 */
function selectMarkedDrafts(labelled, recent, state, cfg, now, readSubject) {
  var picked = {};
  var i;
  for (i = 0; i < labelled.length; i++) picked[labelled[i].id] = true;

  for (i = 0; i < recent.length; i++) {
    var draft = recent[i];
    if (picked[draft.id]) continue;

    // Already handed to SES: no reading of any kind can make it sendable again,
    // and that is the whole point of the consumed marker. `failed` is
    // deliberately NOT skipped — editing a failed draft is one of the two ways
    // to retry it, and noticing the edit is exactly what this loop does.
    if (state.consumed[draft.id] || state.inflight[draft.id]) continue;

    var memo = state.seen[draft.id];
    var unchanged = memo && memo.messageId === draft.messageId;
    if (unchanged && memo.marked) {
      picked[draft.id] = true;
      continue;
    }
    var checkedRecently = memo && memo.at && now - memo.at < SUBJECT_RECHECK_MS;
    if (unchanged && checkedRecently) continue;

    var subject = readSubject(draft.messageId);
    if (subject === null) {
      state.seen[draft.id] = { messageId: draft.messageId, at: now };
      continue;
    }

    var token = parseSubjectToken(subject, cfg.domains, cfg.defaultLocalpart, cfg.subjectToken);
    state.seen[draft.id] = { messageId: draft.messageId, at: now, marked: token.marked };
    if (token.marked) picked[draft.id] = true;
  }

  var ids = [];
  for (var id in picked) {
    if (picked.hasOwnProperty(id)) ids.push(id);
  }
  return ids;
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

    // built.from, not decision.alias: SES's FromEmailAddress overrides the
    // From header in the raw message, so the bare address would erase the
    // display name we just put there.
    sesSendRaw(cfg, built.from, built.checked.ok, built.transmit);
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

    // The daily quota is a relay-wide outage, not a defect in this draft.
    // reportNotSent would email about every pending draft and mark each
    // `failed` — gating them all behind a manual retry for an outage that was
    // never their fault. Surfacing it instead pauses Gmail work, and the
    // untouched drafts go out by themselves once the quota returns. Safe to
    // rethrow here because SES has NOT accepted (that branch returned above):
    // the deletes just performed make the next attempt a clean first attempt.
    if (isServiceQuotaError(err)) throw err;

    reportNotSent(draft, decision, err, state, props);
    return false;
  }
}

// Exported for the Node test harness; ignored by Apps Script, where `module`
// is undefined and every top-level function is already global.
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    RECENT_DRAFT_WINDOW: RECENT_DRAFT_WINDOW,
    SUBJECT_RECHECK_MS: SUBJECT_RECHECK_MS,
    FULL_SWEEP_MS: FULL_SWEEP_MS,
    SCAN_LIMIT: SCAN_LIMIT,
    QUOTA_PAUSE_MS: QUOTA_PAUSE_MS,
    relayTick: relayTick,
    selectMarkedDrafts: selectMarkedDrafts,
  });
}
