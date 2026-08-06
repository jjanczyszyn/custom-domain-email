/**
 * inference.gs — deciding which of our addresses a draft goes out as.
 *
 * After January 2027 Gmail will not offer the alias in the From picker at all,
 * so every draft is authored as the Gmail address and something has to choose.
 * Six sources are tried in a fixed order (premortem item 8):
 *
 *   1. the subject token          you said so explicitly
 *   2. a SES/from: label          you said so explicitly
 *   3. the thread's recipients    where this conversation actually reached us
 *   4. the parent message         same, when Gmail did not thread the reply
 *   5. the quoted body            same, when Gmail recorded no reply at all
 *   6. the draft's own recipients weakest; see the note on that source
 *
 * The order is the design: stated intent beats evidence, and evidence beats
 * guessing. When none of them resolve, the caller refuses to send rather than
 * picking a default — a message that does not go out is recoverable, one sent
 * under the wrong brand is not.
 *
 * Sources 4-6 exist because Gmail's threading turned out not to be dependable;
 * each was added against a real draft that the previous source could not place.
 */

var ALIAS_SOURCES = [
  { name: 'subject token', run: aliasFromSubjectToken },
  { name: 'SES/from: label', run: aliasFromLabels },
  { name: 'thread recipients', run: aliasFromThread },
  { name: 'parent message', run: aliasFromParentMessage },
  { name: 'quoted body', run: aliasFromQuotedBody },
  { name: 'draft recipients', run: aliasFromDraftRecipients },
];

/**
 * Build the context the sources share. `rawParts` memoises the draft fetch:
 * three of the six sources need the raw MIME, and it is a slow remote call.
 */
function aliasContext(draftId, token, labelNames, thread, cfg) {
  var parts = null;
  return {
    draftId: draftId,
    token: token,
    labelNames: labelNames,
    thread: thread,
    cfg: cfg,
    diag: [],
    rawParts: function () {
      if (!parts) parts = splitMime(fetchRawDraft(draftId));
      return parts;
    },
  };
}

/**
 * Try each source in order, recording what every one of them saw.
 *
 * The driver owns the diagnostic trail rather than each source, so a refusal
 * can account for all six — the earlier version only reported the sources that
 * happened to have been written with logging in them, which made an
 * unresolvable draft look like it had barely been examined.
 */
function resolveSendAlias(ctx) {
  for (var i = 0; i < ALIAS_SOURCES.length; i++) {
    var source = ALIAS_SOURCES[i];
    var alias = null;
    try {
      alias = source.run(ctx);
    } catch (e) {
      ctx.diag.push(source.name + ': threw — ' + errorText(e));
      continue;
    }
    ctx.diag.push(source.name + ': ' + (alias || 'no match'));
    if (alias) return alias;
  }
  return null;
}

// ── The sources ──────────────────────────────────────────────────────────────

function aliasFromSubjectToken(ctx) {
  return ctx.token.alias;
}

/** An explicit SES/from:<domain> label. */
function aliasFromLabels(ctx) {
  for (var i = 0; i < ctx.labelNames.length; i++) {
    if (ctx.labelNames[i].indexOf(LABEL_FROM_PREFIX) !== 0) continue;
    var candidate = ctx.labelNames[i].slice(LABEL_FROM_PREFIX.length);
    var alias = resolveAlias(candidate, ctx.cfg.domains, ctx.cfg.defaultLocalpart);
    if (alias) return alias;
  }
  return null;
}

/** The addresses this thread was delivered to — the ordinary case for a reply. */
function aliasFromThread(ctx) {
  if (!ctx.thread) return null;
  return inferAlias(threadRecipients(ctx.thread), ctx.cfg.domains, ctx.cfg.defaultLocalpart);
}

/**
 * Follow the draft's own In-Reply-To / References back to the message being
 * answered, and read who that was addressed to.
 *
 * Gmail does not always thread a reply with its parent — compose on mobile, or
 * reply to forwarded mail, and the draft lands in a thread of its own with
 * nothing to infer from. The reply headers are authoritative where Gmail's
 * threading is not.
 */
function aliasFromParentMessage(ctx) {
  var header = ctx.rawParts().header;
  var refs = messageIdReferences(header);
  if (!refs.length) return null;

  // Newest first: the immediate parent is the best evidence of which of our
  // addresses this conversation actually reached. Older references are
  // progressively weaker, so only the nearest few are worth a search each.
  var limit = Math.min(refs.length, MAX_PARENT_LOOKUPS);
  for (var i = 0; i < limit; i++) {
    var threads = GmailApp.search('rfc822msgid:' + refs[i], 0, 1);
    if (!threads.length) continue;
    var alias = inferAlias(threadRecipients(threads[0]), ctx.cfg.domains, ctx.cfg.defaultLocalpart);
    if (alias) return alias;
  }
  return null;
}

/**
 * The quoted attribution line — "On …, X <someone@ourdomain> wrote:".
 *
 * When Gmail records no thread and no reply headers, the body is the only
 * remaining evidence of which conversation this answers. Only the domain is
 * taken: an address quoted in a body is almost always the parent's sender,
 * which our own forwarder rewrote to no-reply@, and sending as that is wrong.
 */
function aliasFromQuotedBody(ctx) {
  var domain = inferDomainFromText(ctx.rawParts().body, ctx.cfg.domains);
  return domain ? ctx.cfg.defaultLocalpart + '@' + domain : null;
}

/**
 * The draft's own To/Cc.
 *
 * Last and weakest, because these are the people you are writing TO, not an
 * address this conversation ever reached you at. It only helps when you are
 * corresponding with one of your own domains, and in that case sending as that
 * same address is a guess rather than a deduction — so everything else gets a
 * chance first.
 */
function aliasFromDraftRecipients(ctx) {
  var own = collectRecipients(ctx.rawParts().header);
  return inferAlias(own.to.concat(own.cc), ctx.cfg.domains, ctx.cfg.defaultLocalpart);
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** How many References entries are worth a Gmail search each. */
var MAX_PARENT_LOOKUPS = 3;

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
