/**
 * relay.gs — the orchestration shell.
 *
 * Runs once a minute on a time-driven trigger. Finds marked drafts, hands them
 * to SES as one of our verified domains, and files the result in Sent.
 *
 * Every step here exists to close a specific item in docs/relay-premortem.md;
 * the item number is named at each one. The pure logic it leans on lives in
 * mime.gs and sigv4.gs and is unit-tested under Node.
 */

var PROP_INFLIGHT_PREFIX = 'inflight:';
var PROP_CONSUMED_PREFIX = 'consumed:';
var PROP_FAILED_PREFIX = 'failed:';
var CONSUMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    var cfg = getConfig();
    var props = PropertiesService.getScriptProperties();

    reconcileInflight(cfg, props);

    var sent = 0;
    var stale = 0;
    var unreadable = 0;
    var drafts = GmailApp.getDrafts();

    for (var i = 0; i < drafts.length; i++) {
      var decision;
      try {
        decision = classifyDraft(drafts[i], cfg, props);
      } catch (e) {
        // GmailApp.getDrafts() returns drafts it cannot then read — a scheduled
        // send, or one in some other state that rejects getMessage() with
        // "Gmail operation not allowed". Letting that propagate would abort the
        // whole run, so a single unrelated draft sitting in the mailbox would
        // silently stop all outbound mail. Skip it and keep going.
        unreadable++;
        console.warn('skipping unreadable draft: ' + (e.message || e));
        continue;
      }

      if (decision.action === 'send') {
        if (processDraft(drafts[i], decision, cfg, props)) sent++;
      } else if (decision.action === 'defer' && decision.stale) {
        stale++;
      }
    }

    if (unreadable > 0) {
      console.log('skipped ' + unreadable + ' unreadable draft(s) of ' + drafts.length);
    }

    if (stale > 0) reportStuckDrafts(cfg, stale);

    // Premortem 3: the heartbeat is what proves this ran at all.
    putRelayHeartbeat(cfg, sent, stale);
    pruneConsumed(props);
  } catch (err) {
    // A configuration or Gmail-level failure would otherwise be silent.
    console.error(err.stack || err.message);
    tryAlert('Relay run failed', String(err.stack || err.message));
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decide what to do with one draft.
 *
 * Premortem 9: two independent markers. A label works on the web; a subject
 * token works anywhere text can be typed, including mobile compose where
 * labelling a draft is awkward or unavailable. Either one sends.
 */
function classifyDraft(draft, cfg, props) {
  var id = draft.getId();

  // Already handled — or handled and then interrupted. Either way, not ours.
  if (props.getProperty(PROP_CONSUMED_PREFIX + id)) return { action: 'skip' };
  if (props.getProperty(PROP_INFLIGHT_PREFIX + id)) return { action: 'skip' };

  var message = draft.getMessage();
  var subject = message.getSubject() || '';
  var token = parseSubjectToken(subject, cfg.domains, cfg.defaultLocalpart, cfg.subjectToken);

  var thread = null;
  var labelNames = [];
  try {
    thread = message.getThread();
    var labels = thread.getLabels();
    for (var i = 0; i < labels.length; i++) labelNames.push(labels[i].getName());
  } catch (e) {
    // A draft with no thread context is still sendable via the subject token.
  }

  var labelled = labelNames.indexOf(LABEL_OUTBOX) !== -1;
  if (!labelled && !token.marked) return { action: 'skip' };

  // A draft that already failed is not retried on its own. Without this, a
  // permanent failure (bad recipient, oversize) retries every single minute and
  // emails on each attempt — three alerts in ninety seconds, forever. Retrying
  // is an explicit act: re-apply the outbox label, which clears the marker.
  if (props.getProperty(PROP_FAILED_PREFIX + id)) {
    if (!labelled) return { action: 'skip' };
    props.deleteProperty(PROP_FAILED_PREFIX + id);
  }

  // Premortem 5: never send a draft that is still being typed. This doubles as
  // the undo window — unmark within it and nothing goes out.
  var ageMs = new Date().getTime() - message.getDate().getTime();
  if (ageMs < cfg.settleSeconds * 1000) {
    return { action: 'defer', stale: false };
  }

  // Premortem 8: infer the alias, allow an explicit override, otherwise refuse.
  var alias = token.alias || aliasFromLabels(labelNames, cfg);
  if (!alias && thread) alias = inferAlias(threadRecipients(thread), cfg.domains, cfg.defaultLocalpart);

  if (!alias) {
    return {
      action: 'defer',
      stale: ageMs > cfg.staleMinutes * 60 * 1000,
      reason:
        'Could not tell which domain to send as. Add a "' + LABEL_FROM_PREFIX +
        '<domain>" label, or start the subject with ">><domain> ".',
    };
  }

  return {
    action: 'send',
    alias: alias,
    subject: token.marked ? token.subject : subject,
    thread: thread,
    labelled: labelled,
  };
}

/** An explicit SES/from:<domain> label wins over inference. */
function aliasFromLabels(labelNames, cfg) {
  for (var i = 0; i < labelNames.length; i++) {
    if (labelNames[i].indexOf(LABEL_FROM_PREFIX) === 0) {
      var candidate = labelNames[i].slice(LABEL_FROM_PREFIX.length);
      var alias = resolveAlias(candidate, cfg.domains, cfg.defaultLocalpart);
      if (alias) return alias;
    }
  }
  return null;
}

/** Every address the thread was delivered to, newest message first. */
function threadRecipients(thread) {
  var out = [];
  var messages = thread.getMessages();
  for (var i = messages.length - 1; i >= 0; i--) {
    var m = messages[i];

    // Skip the draft being sent. Its recipients are who we are writing TO, not
    // an address this thread was ever delivered to — and since it is the newest
    // message it would win the inference. Replying to someone at one of our own
    // domains then went out as *their* address rather than ours.
    try {
      if (m.isDraft()) continue;
    } catch (e) {
      // isDraft is unavailable on some message states; fall through and use it.
    }

    var fields = [m.getTo(), m.getCc(), m.getReplyTo()];
    for (var f = 0; f < fields.length; f++) {
      if (!fields[f]) continue;
      var parts = splitAddressList(fields[f]);
      for (var p = 0; p < parts.length; p++) out.push(parts[p]);
    }
  }
  return out;
}

/**
 * Send one draft. Returns true when SES accepted it.
 *
 * The ordering here is the single most important thing in this file. See
 * premortem item 1: the draft is marked consumed BEFORE the network call, so a
 * crash mid-send can never cause a resend, and the in-flight record is cleared
 * LAST, so a crash anywhere in between is detectable rather than silent.
 */
function processDraft(draft, decision, cfg, props) {
  var id = draft.getId();
  var messageId = '<' + Utilities.getUuid() + '@' + decision.alias.split('@')[1] + '>';

  try {
    var raw = fetchRawDraft(id);

    var built = buildOutbound(raw, {
      from: decision.alias,
      messageId: messageId,
      subject: decision.subject,
    });

    if (isOversize(built.transmit)) {
      throw new Error(
        'Message is ' + Math.round(utf8ByteLength(built.transmit) / 1048576) +
        ' MB; SES will not send anything over 10 MB. Shrink the attachments.'
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

    // Point of no return. Consumed first, in-flight second, then transmit.
    props.setProperty(PROP_CONSUMED_PREFIX + id, String(new Date().getTime()));
    props.setProperty(
      PROP_INFLIGHT_PREFIX + id,
      JSON.stringify({ messageId: messageId, subject: decision.subject, at: new Date().getTime() })
    );
    if (decision.labelled && decision.thread) removeLabel(decision.thread, LABEL_OUTBOX);

    sesSendRaw(cfg, decision.alias, checked.ok, built.transmit);

    archiveToSent(built.archive, decision.thread);
    draft.deleteDraft();

    // Cleared last: if we died before here, the next tick flags it for review
    // rather than guessing whether it went out.
    props.deleteProperty(PROP_INFLIGHT_PREFIX + id);
    console.log('sent ' + messageId + ' as ' + decision.alias);
    return true;
  } catch (err) {
    props.deleteProperty(PROP_INFLIGHT_PREFIX + id);
    props.deleteProperty(PROP_CONSUMED_PREFIX + id);
    handleFailure(draft, decision, cfg, err);
    return false;
  }
}

/**
 * The authoritative raw draft, via the advanced Gmail service.
 *
 * GmailApp's own getRawContent() does not reliably expose Bcc, and Bcc has to
 * be visible here so it can be stripped from the transmitted bytes and routed
 * as an API parameter instead (premortem item 2).
 */
function fetchRawDraft(draftId) {
  var res = Gmail.Users.Drafts.get('me', draftId, { format: 'raw' });

  // Be explicit about a missing payload. Feeding undefined to the decoder
  // produces a bare "Could not decode string", which says nothing about the
  // actual problem — that the API returned no raw content at all.
  if (!res || !res.message || !res.message.raw) {
    throw new Error(
      'Gmail returned no raw content for this draft. If it is a scheduled ' +
      'send or otherwise unusual, delete it and compose a fresh one.'
    );
  }

  var raw = res.message.raw;

  // Apps Script's advanced services decode protobuf `bytes` fields for you and
  // return a Byte[] — NOT the base64 string the REST API documents. So there is
  // nothing to decode: the array already holds the raw RFC822 message. Passing
  // it to a base64 decoder yields "Could not decode string", an error that
  // describes the decoder's disappointment rather than the actual shape.
  if (Object.prototype.toString.call(raw) === '[object Array]') {
    return Utilities.newBlob(raw).getDataAsString('UTF-8');
  }
  if (raw && typeof raw.getDataAsString === 'function') {
    return raw.getDataAsString('UTF-8');
  }
  if (raw && typeof raw.getBytes === 'function') {
    return Utilities.newBlob(raw.getBytes()).getDataAsString('UTF-8');
  }

  // Otherwise it is a base64url string. base64DecodeWebSafe rejects unpadded
  // input, which is what Gmail returns, so fall back to padded standard base64.
  var bytes = null;
  var attempts = [];
  try {
    bytes = Utilities.base64DecodeWebSafe(String(raw));
  } catch (e) {
    attempts.push('base64DecodeWebSafe: ' + (e.message || e));
  }
  if (bytes === null) {
    try {
      bytes = Utilities.base64Decode(normalizeBase64(raw));
    } catch (e) {
      attempts.push('base64Decode(normalised): ' + (e.message || e));
    }
  }
  if (bytes === null) {
    // Report what we were actually handed. A bare decoder message names the
    // symptom and says nothing about the input that caused it.
    throw new Error(
      'Could not decode the raw draft. typeof=' + typeof raw +
      ', constructor=' + (raw && raw.constructor ? raw.constructor.name : 'n/a') +
      ', length=' + (typeof raw === 'string' ? raw.length : 'n/a') +
      ', head=' + String(raw).slice(0, 40) +
      ' | attempts: ' + attempts.join(' ;; ')
    );
  }

  try {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch (e) {
    // Not every message body is valid UTF-8; fall back to the platform default
    // rather than losing the whole send over an encoding guess.
    return Utilities.newBlob(bytes).getDataAsString();
  }
}

/**
 * File the sent copy in Gmail.
 *
 * Gmail applies SENT when Gmail sends; SES sending means Gmail never knows, so
 * we insert the message ourselves. Pinning threadId keeps the conversation
 * intact rather than relying on Gmail's subject heuristics (premortem item 4).
 * A brand-new message has no surviving thread once its draft is deleted, so it
 * is inserted without one.
 */
function archiveToSent(rawMessage, thread) {
  var resource = { labelIds: ['SENT'] };
  if (thread) {
    try {
      if (thread.getMessageCount() > 1) resource.threadId = thread.getId();
    } catch (e) {
      // Thread vanished; fall back to a standalone insert.
    }
  }
  var blob = Utilities.newBlob(rawMessage, 'message/rfc822');
  Gmail.Users.Messages.insert(resource, 'me', blob, { internalDateSource: 'dateHeader' });
}

/**
 * Premortem 7: failure is always an email. The draft is left intact and
 * editable so nothing is lost — fix it and re-mark it.
 */
function handleFailure(draft, decision, cfg, err) {
  var subject = decision.subject || '(no subject)';
  console.error('relay failed for "' + subject + '": ' + (err.stack || err.message));

  // Stop the automatic retry loop. The marker is what actually prevents it —
  // removing the label alone would not, since a subject-token draft carries no
  // label to remove.
  try {
    PropertiesService.getScriptProperties().setProperty(
      PROP_FAILED_PREFIX + draft.getId(),
      String(new Date().getTime())
    );
  } catch (e) {
    console.error('could not record failure marker: ' + e.message);
  }

  try {
    if (decision.thread) {
      addLabel(decision.thread, LABEL_FAILED);
      removeLabel(decision.thread, LABEL_OUTBOX);
    }
  } catch (e) {
    // Labelling is best-effort; the email below is the real notification.
  }

  tryAlert(
    'Relay could not send: ' + subject,
    'The draft was NOT sent and is still in your Drafts folder.\n\n' +
      'Sending as: ' + (decision.alias || 'unresolved') + '\n' +
      'Subject:    ' + subject + '\n\n' +
      'Error:\n' + (err.message || String(err)) + '\n\n' +
      // The stack names the line. Without it a generic runtime message like
      // "Could not decode string" identifies the symptom and hides entirely
      // which call produced it, which costs a round trip per diagnosis.
      'Where:\n' + (err.stack || '(no stack available)') + '\n\n' +
      'Fix the draft and re-apply the "' + LABEL_OUTBOX + '" label to retry.'
  );
}

/**
 * Premortem 1: an in-flight record surviving a run means a send whose outcome
 * we cannot determine. We never auto-retry it — a duplicate to a client is
 * worse than a send you confirm by hand.
 */
function reconcileInflight(cfg, props) {
  var all = props.getProperties();
  for (var key in all) {
    if (!all.hasOwnProperty(key) || key.indexOf(PROP_INFLIGHT_PREFIX) !== 0) continue;

    var draftId = key.slice(PROP_INFLIGHT_PREFIX.length);
    var record = {};
    try {
      record = JSON.parse(all[key]);
    } catch (e) {
      record = {};
    }

    try {
      var draft = GmailApp.getDraft(draftId);
      if (draft) addLabel(draft.getMessage().getThread(), LABEL_REVIEW);
    } catch (e) {
      // The draft is gone, which means it almost certainly did send.
    }

    props.deleteProperty(key);
    tryAlert(
      'Relay needs review: ' + (record.subject || '(unknown subject)'),
      'A send was interrupted before it could be confirmed, so it may or may ' +
        'not have gone out.\n\n' +
        'Subject:    ' + (record.subject || '(unknown)') + '\n' +
        'Message-ID: ' + (record.messageId || '(unknown)') + '\n\n' +
        'Check your Sent folder. The draft has been labelled "' + LABEL_REVIEW +
        '" and was NOT sent again automatically — re-mark it only if you ' +
        'confirm it never left.'
    );
  }
}

/** Premortem 3: drafts marked but not moving are their own kind of failure. */
function reportStuckDrafts(cfg, count) {
  tryAlert(
    'Relay has ' + count + ' stuck draft(s)',
    count + ' draft(s) have been marked for sending for more than ' +
      cfg.staleMinutes + ' minutes without going out.\n\n' +
      'The usual cause is that the relay cannot tell which domain to send as. ' +
      'Add a "' + LABEL_FROM_PREFIX + '<domain>" label to the draft, or start ' +
      'the subject with ">><domain> ".'
  );
}

/** Consumed and failed markers only need to outlive a stuck draft. */
function pruneConsumed(props) {
  var all = props.getProperties();
  var cutoff = new Date().getTime() - CONSUMED_TTL_MS;
  for (var key in all) {
    if (!all.hasOwnProperty(key)) continue;
    var isMarker =
      key.indexOf(PROP_CONSUMED_PREFIX) === 0 || key.indexOf(PROP_FAILED_PREFIX) === 0;
    if (!isMarker) continue;
    var at = parseInt(all[key], 10);
    if (!at || at < cutoff) props.deleteProperty(key);
  }
}

// ── Small Gmail helpers ──────────────────────────────────────────────────────

function ensureLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function addLabel(thread, name) {
  if (thread) thread.addLabel(ensureLabel(name));
}

function removeLabel(thread, name) {
  var label = GmailApp.getUserLabelByName(name);
  if (thread && label) thread.removeLabel(label);
}

/** Alerts must never be the reason a run dies. */
function tryAlert(subject, body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var to = props.getProperty(PROP_ALERT_EMAIL);
    // Call sites already name the relay ("Relay could not send: ..."), so the
    // prefix is all that needs adding.
    if (to) MailApp.sendEmail(to, ALERT_SUBJECT_PREFIX + ' ' + subject, body);
  } catch (e) {
    console.error('could not send alert: ' + e.message);
  }
}
