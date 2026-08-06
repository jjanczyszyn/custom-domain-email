/**
 * gmail.gs — the Gmail I/O shell.
 *
 * Everything that talks to GmailApp or the advanced Gmail service lives here,
 * so relay.gs can be read as a sequence of decisions rather than a mix of
 * decisions and API calls. Nothing in this file makes a policy choice.
 */

/**
 * The draft's raw RFC822 content.
 *
 * GmailApp's own getRawContent() does not reliably expose Bcc, and Bcc must be
 * visible here so it can be stripped from the transmitted bytes and routed as
 * an API parameter instead (premortem item 2).
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
  return decodeRawPayload(res.message.raw);
}

/**
 * Turn whatever Gmail handed back into a string.
 *
 * Apps Script's advanced services DECODE protobuf `bytes` fields for you and
 * return a Byte[] — not the base64 string the REST API documents. There is
 * nothing to decode, and passing it to a base64 decoder yields "Could not
 * decode string", an error describing the decoder's disappointment rather than
 * the actual shape. The other branches cover shapes seen across runtime
 * versions; describeRawPayload() reports which one was taken.
 */
function decodeRawPayload(raw) {
  if (Object.prototype.toString.call(raw) === '[object Array]') {
    return Utilities.newBlob(raw).getDataAsString('UTF-8');
  }
  if (raw && typeof raw.getDataAsString === 'function') {
    return raw.getDataAsString('UTF-8');
  }
  if (raw && typeof raw.getBytes === 'function') {
    return Utilities.newBlob(raw.getBytes()).getDataAsString('UTF-8');
  }

  // A base64url string. base64DecodeWebSafe rejects unpadded input, which is
  // what Gmail returns, so fall back to padded standard base64.
  var bytes = null;
  var attempts = [];
  try {
    bytes = Utilities.base64DecodeWebSafe(String(raw));
  } catch (e) {
    attempts.push('base64DecodeWebSafe: ' + errorText(e));
  }
  if (bytes === null) {
    try {
      bytes = Utilities.base64Decode(normalizeBase64(raw));
    } catch (e) {
      attempts.push('base64Decode(normalised): ' + errorText(e));
    }
  }
  if (bytes === null) {
    throw new Error(
      'Could not decode the raw draft. ' + describeRawPayload(raw) +
      ' | attempts: ' + attempts.join(' ;; ')
    );
  }

  try {
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch (e) {
    // Not every body is valid UTF-8; fall back rather than lose the send.
    return Utilities.newBlob(bytes).getDataAsString();
  }
}

/**
 * Describe the shape of a raw payload.
 *
 * Shared by the decoder's error path and inspectDrafts(), so the diagnostic
 * cannot drift from the code it exists to explain — which is exactly what
 * happened when the two were written separately.
 */
function describeRawPayload(raw) {
  return (
    'typeof=' + typeof raw +
    ', constructor=' + (raw && raw.constructor ? raw.constructor.name : 'n/a') +
    ', length=' + (typeof raw === 'string' ? raw.length : 'n/a') +
    ', head=' + String(raw).slice(0, 40)
  );
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

/** A Message-ID we own, so the transmitted and archived copies agree (item 4). */
function newMessageId(address) {
  return '<' + Utilities.getUuid() + '@' + String(address).split('@')[1] + '>';
}

// ── Labels ───────────────────────────────────────────────────────────────────

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

/** The names of every label on a draft's thread, and the thread itself. */
function threadContext(message) {
  var context = { thread: null, labelNames: [] };
  try {
    context.thread = message.getThread();
    var labels = context.thread.getLabels();
    for (var i = 0; i < labels.length; i++) context.labelNames.push(labels[i].getName());
  } catch (e) {
    // A draft with no thread context is still sendable via the subject token.
  }
  return context;
}
