/**
 * notify.gs — how the relay tells you something went wrong.
 *
 * This prose is the product's failure UX, so it lives together where drift
 * between the messages is visible. Matching the project's philosophy: no
 * alarms, no dashboards — every failure arrives as a plain email.
 *
 * There are exactly two outcomes worth distinguishing, and confusing them is
 * how you send a client the same email twice:
 *
 *   NOT SENT     — SES never accepted it. The draft is intact and retryable.
 *   NEEDS REVIEW — SES may or may not have accepted it. Hands off; the consumed
 *                  marker stays so nothing retries it automatically.
 */

/** How to ask the relay to try again. Stated once so it cannot drift. */
var RETRY_INSTRUCTIONS =
  'To retry: edit the draft, or re-apply the "' + LABEL_OUTBOX + '" label. ' +
  'Either is enough; it will not retry on its own.';

/**
 * Alerts must never be the reason a run dies, and must work even when config
 * loading is what failed — relayTick's top-level catch calls this after
 * getConfig() may have thrown, so the address is read directly rather than
 * taken from cfg.
 */
function tryAlert(subject, body) {
  try {
    var props = PropertiesService.getScriptProperties();
    var to = props.getProperty(PROP_ALERT_EMAIL);
    if (!to) return;

    var budget = claimAlertBudget(props);
    if (!budget.allowed) {
      console.warn('alert suppressed by the volume cap: ' + subject);
      return;
    }

    // Call sites already name the relay, so the prefix is all that is added.
    MailApp.sendEmail(
      to,
      ALERT_SUBJECT_PREFIX + ' ' + subject,
      body + (budget.suppressed
        ? '\n\n---\n' + budget.suppressed + ' further alert(s) were suppressed by the ' +
          'volume cap since the last one got through. Check the Apps Script ' +
          'execution log for what they were.'
        : '')
    );
  } catch (e) {
    console.error('could not send alert: ' + errorText(e));
  }
}

/**
 * A hard ceiling on alert mail, independent of every other guard.
 *
 * The per-fault throttle below stops the *same* failure repeating. This stops
 * everything else: any number of call sites, any mix of faults, any future code
 * that decides to email. Alerts are the one thing that must never become the
 * problem — Apps Script allows 100 recipients a day, so a storm both buries the
 * mailbox and destroys the ability to report the next, different failure.
 *
 * Kept in its own property rather than the state bundle deliberately: it has to
 * work on the paths where the bundle could not be read, which are exactly the
 * paths most likely to be failing repeatedly.
 */
var PROP_ALERT_BUDGET = '_relayAlertBudget';
var ALERT_BUDGET_WINDOWS = [
  { key: 'hour', ms: 60 * 60 * 1000, max: 4 },
  { key: 'day', ms: 24 * 60 * 60 * 1000, max: 20 },
];

function claimAlertBudget(props) {
  var now = new Date().getTime();
  var stored = {};
  try {
    var raw = props.getProperty(PROP_ALERT_BUDGET);
    if (raw) stored = JSON.parse(raw) || {};
  } catch (e) {
    // An unreadable budget must never be the reason an alert is not sent.
    stored = {};
  }

  var i;
  var allowed = true;
  for (i = 0; i < ALERT_BUDGET_WINDOWS.length; i++) {
    var span = ALERT_BUDGET_WINDOWS[i];
    var seen = stored[span.key];
    if (!seen || typeof seen.start !== 'number' || now - seen.start >= span.ms) {
      seen = { start: now, sent: 0 };
      stored[span.key] = seen;
    }
    if (seen.sent >= span.max) allowed = false;
  }

  // Count what was held back, so the next alert that does get through says so.
  // A cap that silently drops mail is worse than no cap: it turns "nothing is
  // wrong" and "everything is wrong" into the same empty inbox.
  var suppressed = stored.suppressed || 0;
  if (allowed) {
    for (i = 0; i < ALERT_BUDGET_WINDOWS.length; i++) stored[ALERT_BUDGET_WINDOWS[i].key].sent++;
    stored.suppressed = 0;
  } else {
    stored.suppressed = suppressed + 1;
    suppressed = 0;
  }

  try {
    props.setProperty(PROP_ALERT_BUDGET, JSON.stringify(stored));
  } catch (e) {
    console.error('could not record the alert budget: ' + errorText(e));
  }
  return { allowed: allowed, suppressed: suppressed };
}

/**
 * How long the same run-level failure stays quiet after being reported once.
 *
 * Long enough that a fault lasting all day sends a handful of mails rather than
 * hundreds, short enough that a recurring problem is still raised more than
 * once. Per-draft failures are not throttled by this — they are already
 * one-per-draft, and each one is a different message you are waiting on.
 */
var ALERT_THROTTLE_MS = 4 * 60 * 60 * 1000;

/**
 * The quota case gets a day, not four hours: an exhausted daily quota IS a
 * day-long condition, and it announces its own end by the relay simply
 * resuming. Re-raising it mid-episode tells the operator nothing they were
 * not told the first time. A quota problem that genuinely recurs still
 * surfaces — once per day, which is exactly as often as it can recur.
 */
var QUOTA_ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Is this Apps Script's daily-quota refusal? Shared by the alert throttle and
 * relayTick's pause logic, so the two cannot disagree about what counts.
 * Matched on the message — "Service invoked too many times for one day" — so
 * the same cause thrown from a different call site is still recognised.
 *
 * The short-term rate limit ("too many times in a short time") shares most of
 * that wording and none of its meaning: it clears in seconds, so treating it as
 * the day-long condition would suspend Gmail work for half an hour and email a
 * paragraph about a quota that is not the one that ran out. It is transient
 * instead — see below.
 */
function isServiceQuotaError(err) {
  var message = errorText(err);
  return /too many times/i.test(message) && !/in a short time/i.test(message);
}

/**
 * Is this Gmail declining for a moment, rather than something being wrong?
 *
 * Gmail's backend intermittently refuses a call that is perfectly valid — most
 * often as "Gmail operation not allowed", which it also uses for the genuinely
 * unreadable draft in premortem item 13. Thrown at a draft it means "not this
 * draft"; thrown at `GmailApp.getUserLabelByName()`, as it was at 00:10 UTC on
 * 17 Aug 2026, it means nothing at all — the next tick, a minute later, ran
 * normally. The relay cannot tell the two apart from the message, and does not
 * need to: what distinguishes a real outage is that it is still there a minute
 * later, which is what the streak in relay.gs measures.
 *
 * Breadth is cheap here. Misreading a persistent fault as transient costs the
 * few minutes the streak takes to fire; misreading a blip as a fault costs an
 * email about nothing, which is the failure this exists to stop.
 */
var TRANSIENT_GMAIL_PATTERNS = [
  /operation not allowed/i,
  /too many times in a short time/i,
  /service (unavailable|error|timed out)/i,
  /temporarily unavailable/i,
  /try again later/i,
  /internal error/i,
  /backend error/i,
];

function isTransientGmailError(err) {
  if (isServiceQuotaError(err)) return false;
  var message = errorText(err);
  for (var i = 0; i < TRANSIENT_GMAIL_PATTERNS.length; i++) {
    if (TRANSIENT_GMAIL_PATTERNS[i].test(message)) return true;
  }
  return false;
}

/**
 * The whole run failed — bad configuration, or Gmail refusing to talk to us.
 *
 * Throttled, because this class of failure repeats on every tick by nature.
 * The relay once ran into Gmail's daily call quota; unthrottled, that single
 * fault would have sent this mail on all 1,440 ticks, exhausting the separate
 * 100-recipients-a-day quota that genuine per-draft alerts depend on.
 */
function reportRunFailed(err, state, props, note) {
  var message = errorText(err);

  // Fingerprint on the message rather than the stack, so the same cause
  // recurring from a slightly different line is still recognised as a repeat.
  var quota = isServiceQuotaError(err);
  var key = quota ? 'gmail-quota' : message.slice(0, 120);
  var throttleMs = quota ? QUOTA_ALERT_THROTTLE_MS : ALERT_THROTTLE_MS;

  var due = true;
  if (state && state.notices) {
    due = dueAgain(state, 'notices', key, throttleMs, new Date().getTime());

    // Persist unconditionally, and BEFORE the throttled early return. A failing
    // tick has usually already recorded something that must outlive it — the
    // throttle marker itself, and the hourly-sweep marker set at the top of the
    // run. Returning without this write loses the sweep marker, so every
    // failing tick would attempt the expensive full scan again: the exact
    // behaviour that exhausted the quota in the first place.
    try {
      saveState(props, state);
    } catch (e) {
      console.error('could not record the alert marker: ' + errorText(e));
    }
  }

  if (!due) {
    console.log('alert suppressed; already reported "' + key + '" within the throttle window');
    return;
  }

  tryAlert(
    'Relay run failed',
    'The relay could not complete a run. No draft was sent by it.\n\n' +
      errorText(err, true) + '\n\n' +
      (note ? note + '\n\n' : '') +
      (quota
        ? 'This is Gmail\'s daily quota for Apps Script calls (20,000 a day on a\n' +
          'consumer account), not an SES or AWS problem. It resets 24 hours after\n' +
          'the first call of the day.\n\n' +
          'The relay has paused its Gmail work and now probes every half hour,\n' +
          'so it resumes on its own within ~30 minutes of the quota returning.\n' +
          'Drafts you mark in the meantime stay put and go out then. Expect no\n' +
          'further mail about this episode — silence here means it is working.\n\n' +
          'If this arrives on most days, the scan is reading more drafts than it\n' +
          'should — run showConfig() and check the "scan examined" lines in the\n' +
          'execution log. A targeted scan should examine very few drafts; a full\n' +
          'sweep runs once an hour and examines every draft in the mailbox.\n\n'
        : '') +
      'Further alerts about this same failure are suppressed for ' +
      Math.round(throttleMs / 3600000) + ' hours.'
  );
}

/**
 * The message was NOT sent. The draft is left intact and editable so nothing
 * is lost, and marked so it does not retry every minute — without that, a
 * permanent failure emails on every tick, forever (three alerts in ninety
 * seconds, as it turned out).
 */
function reportNotSent(draft, decision, err, state, props) {
  var subject = decision.subject || '(no subject)';
  console.error('relay failed for "' + subject + '": ' + errorText(err, true));

  try {
    var draftDate = 0;
    try {
      draftDate = draft.getMessage().getDate().getTime();
    } catch (e) {
      // Unreadable draft; the label remains the way to retry.
    }
    state.failed[draft.getId()] = { at: new Date().getTime(), draftDate: draftDate };
    saveState(props, state);
  } catch (e) {
    console.error('could not record failure marker: ' + errorText(e));
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
      'Error:\n' + errorText(err) + '\n\n' +
      (decision.diagnostic ? 'What was examined:\n  ' + decision.diagnostic + '\n\n' : '') +
      // The stack names the line. Without it a generic runtime message like
      // "Could not decode string" identifies the symptom and hides which call
      // produced it, costing a round trip per diagnosis. Omitted when the
      // "failure" is a deliberate refusal, where a stack is only noise.
      (decision.action === 'fail' ? '' : 'Where:\n' + errorText(err, true) + '\n\n') +
      RETRY_INSTRUCTIONS
  );
}

/**
 * The outcome is UNKNOWN — SES may already have accepted this.
 *
 * We cannot ask SES "did you take this message", so we never retry it
 * automatically: a duplicate to a client is worse than a send you confirm by
 * hand. The consumed marker deliberately stays in place. Premortem item 1.
 */
function reportNeedsReview(draftId, record, detail, state, props) {
  try {
    var draft = GmailApp.getDraft(draftId);
    if (draft) addLabel(draft.getMessage().getThread(), LABEL_REVIEW);
  } catch (e) {
    // The draft is gone, which means it almost certainly did send.
  }

  delete state.inflight[draftId];
  saveState(props, state);

  tryAlert(
    'Relay needs review: ' + (record.subject || '(unknown subject)'),
    'A send was interrupted before it could be confirmed, so it may or may ' +
      'not have gone out.\n\n' +
      'Subject:    ' + (record.subject || '(unknown)') + '\n' +
      'Message-ID: ' + (record.messageId || '(unknown)') + '\n\n' +
      (detail ? 'What failed:\n' + detail + '\n\n' : '') +
      'Check your Sent folder. The draft has been labelled "' + LABEL_REVIEW +
      '" and was NOT sent again automatically — re-mark it only if you ' +
      'confirm it never left.'
  );
}

/**
 * An in-flight record surviving a run means a send whose outcome we cannot
 * determine: the previous tick died between handing the message to SES and
 * finishing its tidy-up.
 */
function reconcileInflight(props, state) {
  for (var draftId in state.inflight) {
    if (!state.inflight.hasOwnProperty(draftId)) continue;
    reportNeedsReview(
      draftId,
      state.inflight[draftId] || {},
      'The run was interrupted after the message was handed to SES.',
      state,
      props
    );
  }
}

/** Render an error for a human: message by default, message and stack if asked. */
function errorText(err, withStack) {
  if (!err) return '(no detail)';
  if (withStack) return String(err.stack || err.message || err);
  return String(err.message || err);
}

// Exported for the Node test harness; ignored by Apps Script, where `module`
// is undefined and every top-level function is already global.
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    ALERT_THROTTLE_MS: ALERT_THROTTLE_MS,
    QUOTA_ALERT_THROTTLE_MS: QUOTA_ALERT_THROTTLE_MS,
    isServiceQuotaError: isServiceQuotaError,
    isTransientGmailError: isTransientGmailError,
    RETRY_INSTRUCTIONS: RETRY_INSTRUCTIONS,
    tryAlert: tryAlert,
    claimAlertBudget: claimAlertBudget,
    ALERT_BUDGET_WINDOWS: ALERT_BUDGET_WINDOWS,
    reportRunFailed: reportRunFailed,
    errorText: errorText,
  });
}
