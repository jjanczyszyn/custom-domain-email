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
    var to = PropertiesService.getScriptProperties().getProperty(PROP_ALERT_EMAIL);
    // Call sites already name the relay, so the prefix is all that is added.
    if (to) MailApp.sendEmail(to, ALERT_SUBJECT_PREFIX + ' ' + subject, body);
  } catch (e) {
    console.error('could not send alert: ' + errorText(e));
  }
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
