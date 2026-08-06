import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGs, rawMessage } from "./helpers.mjs";

const gs = loadGs("mime.gs");
const DOMAINS = ["example.com", "example.org", "example.net", "example.test"];

// ── Header primitives ────────────────────────────────────────────────────────

test("readHeader: unfolds RFC822 continuation lines", () => {
  const h = "Subject: a very\r\n long subject\r\nTo: x@y.com\r\n";
  assert.equal(gs.readHeader(h, "Subject"), "a very long subject");
});

test("readHeader: absent header reads as empty", () => {
  assert.equal(gs.readHeader("To: x@y.com\r\n", "Bcc"), "");
});

test("stripHeader: removes folded headers whole", () => {
  const h = "To: x@y.com\r\nBcc: a@b.com,\r\n c@d.com\r\nSubject: hi\r\n";
  const out = gs.stripHeader(h, "Bcc");
  assert.equal(out, "To: x@y.com\r\nSubject: hi\r\n");
});

test("setHeader: replaces an existing value, appends a missing one", () => {
  assert.match(gs.setHeader("From: old@x.com\r\n", "From", "new@y.com"), /From: new@y\.com/);
  assert.match(gs.setHeader("To: x@y.com\r\n", "Message-ID", "<id>"), /Message-ID: <id>/);
});

// ── Message-ID ownership (premortem item 4) ──────────────────────────────────

test("ensureMessageId: generates one when the draft has none", () => {
  const r = gs.ensureMessageId("To: x@y.com\r\n", "<gen@d.com>");
  assert.equal(r.messageId, "<gen@d.com>");
  assert.match(r.header, /Message-ID: <gen@d\.com>/);
});

test("ensureMessageId: keeps an existing id rather than minting a second", () => {
  const r = gs.ensureMessageId("Message-ID: <orig@d.com>\r\n", "<gen@d.com>");
  assert.equal(r.messageId, "<orig@d.com>");
});

test("buildOutbound: transmitted and archived copies share one Message-ID", () => {
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com", Subject: "hi" });
  const out = gs.buildOutbound(raw, { from: "hello@example.net", messageId: "<one@example.net>" });
  assert.equal(out.messageId, "<one@example.net>");
  assert.match(out.transmit, /Message-ID: <one@example\.net>/);
  assert.match(out.archive, /Message-ID: <one@example\.net>/);
});

test("buildOutbound: threading headers from the draft survive untouched", () => {
  const raw = rawMessage({
    From: "me@gmail.com",
    To: "x@y.com",
    "In-Reply-To": "<prev@them.com>",
    References: "<first@them.com> <prev@them.com>",
  });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<n@example.org>" });
  assert.match(out.transmit, /In-Reply-To: <prev@them\.com>/);
  assert.match(out.transmit, /References: <first@them\.com> <prev@them\.com>/);
});

// ── Bcc containment (premortem item 2) ───────────────────────────────────────

test("buildOutbound: Bcc never reaches the transmitted bytes", () => {
  const raw = rawMessage({
    From: "me@gmail.com",
    To: "x@y.com",
    Bcc: "secret@z.com",
    Subject: "hi",
  });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.doesNotMatch(out.transmit, /secret@z\.com/);
  assert.doesNotMatch(out.transmit, /^Bcc:/im);
});

test("buildOutbound: the archived copy keeps Bcc so you can see who you copied", () => {
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com", Bcc: "secret@z.com" });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.match(out.archive, /Bcc: secret@z\.com/);
});

test("buildOutbound: blind recipients are returned for the API parameter", () => {
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com", Cc: "c@y.com", Bcc: "s@z.com" });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.deepEqual(out.recipients.to, ["x@y.com"]);
  assert.deepEqual(out.recipients.cc, ["c@y.com"]);
  assert.deepEqual(out.recipients.bcc, ["s@z.com"]);
});

// ── From rewriting ───────────────────────────────────────────────────────────

test("buildOutbound: From is rewritten to the alias, display name preserved", () => {
  const raw = rawMessage({ From: '"Ada Lovelace" <me@gmail.com>', To: "x@y.com" });
  const out = gs.buildOutbound(raw, { from: "hello@example.net", messageId: "<m@example.net>" });
  assert.match(out.transmit, /From: "Ada Lovelace" <hello@example\.net>/);
  assert.doesNotMatch(out.transmit, /me@gmail\.com/);
});

// ── Per-domain sender names ──────────────────────────────────────────────────

const NAMES = {
  "example.com": "Example Co",
  "example.net": "Ex Net",
};

test("parseDomainList: trims, drops blanks, tolerates junk input", () => {
  assert.deepEqual(gs.parseDomainList("example.com, example.net"), ["example.com", "example.net"]);
  assert.deepEqual(gs.parseDomainList(" a.com ,, b.com,"), ["a.com", "b.com"]);
  assert.deepEqual(gs.parseDomainList(""), []);
  assert.deepEqual(gs.parseDomainList(null), []);
});

test("messageIdReferences: the immediate parent leads, then newest references", () => {
  const header =
    "In-Reply-To: <parent@x.com>\r\n" +
    "References: <oldest@x.com> <middle@x.com> <parent@x.com>\r\n";
  // Brackets stripped, In-Reply-To first, References reversed, no duplicates.
  assert.deepEqual(gs.messageIdReferences(header), [
    "parent@x.com",
    "middle@x.com",
    "oldest@x.com",
  ]);
});

test("messageIdReferences: works with either header alone, or neither", () => {
  assert.deepEqual(gs.messageIdReferences("In-Reply-To: <a@x.com>\r\n"), ["a@x.com"]);
  assert.deepEqual(gs.messageIdReferences("References: <a@x.com> <b@x.com>\r\n"), [
    "b@x.com",
    "a@x.com",
  ]);
  assert.deepEqual(gs.messageIdReferences("Subject: hi\r\n"), []);
});

test("repairHtmlParts: base64 attachment parts are skipped, not scanned", () => {
  const attachment =
    "\r\n--b\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    "iVBORw0KGgo=</html>oddbutbase64\r\n";
  const raw = "\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n" + attachment + "\r\n--b--\r\n";
  // Untouched: rewriting inside an attachment payload would corrupt it.
  assert.equal(gs.repairHtmlParts(raw), raw);
});

test("parseDomainNames: parses pairs and lowercases the domain key", () => {
  const map = gs.parseDomainNames("Example.COM=Example Co, example.net=Ex Net");
  assert.equal(map["example.com"], "Example Co");
  assert.equal(map["example.net"], "Ex Net");
});

test("parseDomainNames: entries without an '=' are ignored, not fatal", () => {
  assert.deepEqual(gs.parseDomainNames("broken,example.com=Ok"), { "example.com": "Ok" });
  assert.deepEqual(gs.parseDomainNames(""), {});
  assert.deepEqual(gs.parseDomainNames(null), {});
});

test("displayNameFor: matches on domain, case-insensitively", () => {
  assert.equal(gs.displayNameFor("hello@EXAMPLE.com", NAMES), "Example Co");
  assert.equal(gs.displayNameFor("hello@unconfigured.com", NAMES), "");
});

test("buildOutbound: the configured domain name is what recipients see", () => {
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com" });
  const out = gs.buildOutbound(raw, {
    from: "hello@example.net",
    messageId: "<m@example.net>",
    domainNames: NAMES,
  });
  assert.match(out.transmit, /From: "Ex Net" <hello@example\.net>/);
});

test("buildOutbound: the domain name beats the draft's own display name", () => {
  // The draft carries the Gmail account holder's name; the brand should win.
  const raw = rawMessage({ From: '"Ada Lovelace" <me@gmail.com>', To: "x@y.com" });
  const out = gs.buildOutbound(raw, {
    from: "hello@example.com",
    messageId: "<m@example.com>",
    domainNames: NAMES,
  });
  assert.match(out.transmit, /From: "Example Co" <hello@example\.com>/);
  assert.doesNotMatch(out.transmit, /Ada Lovelace/);
});

test("buildOutbound: an unconfigured domain falls back to the draft's name", () => {
  const raw = rawMessage({ From: '"Ada Lovelace" <me@gmail.com>', To: "x@y.com" });
  const out = gs.buildOutbound(raw, {
    from: "hello@example.org",
    messageId: "<m@example.org>",
    domainNames: NAMES,
  });
  assert.match(out.transmit, /From: "Ada Lovelace" <hello@example\.org>/);
});

test("buildOutbound: a bare From becomes a bare alias", () => {
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com" });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.match(out.transmit, /From: hello@example\.org/);
});

test("buildOutbound: stale envelope and signature headers are stripped", () => {
  const raw = rawMessage({
    From: "me@gmail.com",
    To: "x@y.com",
    "Return-Path": "<me@gmail.com>",
    Sender: "me@gmail.com",
    "DKIM-Signature": "v=1; a=rsa-sha256; d=gmail.com;",
  });
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.doesNotMatch(out.transmit, /Return-Path/i);
  assert.doesNotMatch(out.transmit, /DKIM-Signature/i);
  assert.doesNotMatch(out.transmit, /^Sender:/im);
});

test("buildOutbound: body is left byte-identical", () => {
  const body = "Line one\r\n\r\n--boundary\r\nContent-Type: image/png\r\n\r\niVBORw0KGgo=";
  const raw = rawMessage({ From: "me@gmail.com", To: "x@y.com" }, body);
  const out = gs.buildOutbound(raw, { from: "hello@example.org", messageId: "<m@example.org>" });
  assert.ok(out.transmit.endsWith(body));
});

// ── Address parsing ──────────────────────────────────────────────────────────

test("splitAddressList: a comma inside a quoted display name is not a separator", () => {
  const list = gs.splitAddressList('"Doe, Jane" <jane@x.com>, bob@y.com');
  assert.deepEqual(list, ['"Doe, Jane" <jane@x.com>', "bob@y.com"]);
});

test("collectRecipients: deduplicates case-insensitively", () => {
  const h = "To: A@X.com, a@x.com, b@x.com\r\n";
  assert.deepEqual(gs.collectRecipients(h).to, ["A@X.com", "b@x.com"]);
});

test("isSendableAddress: accepts normal addresses, rejects malformed ones", () => {
  assert.ok(gs.isSendableAddress("hello@example.net"));
  assert.ok(!gs.isSendableAddress("undisclosed-recipients:"));
  assert.ok(!gs.isSendableAddress("no-at-sign"));
  assert.ok(!gs.isSendableAddress("a b@x.com"));
  assert.ok(!gs.isSendableAddress("a@nodot"));
});

test("validateRecipients: bad addresses are reported, not silently dropped", () => {
  const r = gs.validateRecipients({ to: ["good@x.com", "bad@nodot"], cc: [], bcc: [] });
  assert.deepEqual(r.ok.to, ["good@x.com"]);
  assert.deepEqual(r.bad, ["bad@nodot"]);
  assert.equal(r.total, 1);
});

// ── Marker parsing (premortem item 9) ────────────────────────────────────────

test("parseSubjectToken: an unmarked subject is not a send", () => {
  const r = gs.parseSubjectToken("Just a draft", DOMAINS, "hello");
  assert.equal(r.marked, false);
  assert.equal(r.subject, "Just a draft");
});

test("parseSubjectToken: the token marks a send and is stripped", () => {
  const r = gs.parseSubjectToken(">>Coaching session", DOMAINS, "hello");
  assert.equal(r.marked, true);
  assert.equal(r.alias, null);
  assert.equal(r.subject, "Coaching session");
});

test("parseSubjectToken: a bare domain selects the alias", () => {
  const r = gs.parseSubjectToken(">>example.net Welcome", DOMAINS, "hello");
  assert.equal(r.alias, "hello@example.net");
  assert.equal(r.subject, "Welcome");
});

test("parseSubjectToken: a full address selects that exact alias", () => {
  const r = gs.parseSubjectToken(">>bookings@example.org Your slot", DOMAINS, "hello");
  assert.equal(r.alias, "bookings@example.org");
  assert.equal(r.subject, "Your slot");
});

test("parseSubjectToken: an unconfigured domain yields no alias", () => {
  const r = gs.parseSubjectToken(">>evil.com Hello", DOMAINS, "hello");
  assert.equal(r.marked, true);
  assert.equal(r.alias, null);
});

test("parseSubjectToken: a subject that merely starts with a domain-like word is kept", () => {
  const r = gs.parseSubjectToken(">>Re: example.net rebrand", DOMAINS, "hello");
  assert.equal(r.subject, "Re: example.net rebrand");
  assert.equal(r.alias, null);
});

// An unmarked draft must never send. This is the guarantee that ordinary drafts
// sitting in the mailbox are untouched, so it is worth asserting directly.
test("parseSubjectToken: ordinary subjects are never marked", () => {
  for (const s of ["Re: lunch", "> quoted", "Fwd: >>something", "", "  spaced"]) {
    assert.equal(gs.parseSubjectToken(s, DOMAINS, "hello").marked, false, `"${s}" was marked`);
  }
});

test("parseSubjectToken: an empty token disables the subject trigger entirely", () => {
  // Without the guard, indexOf('') === 0 for every subject and the relay would
  // mark the whole mailbox for sending.
  const r = gs.parseSubjectToken(">>Would otherwise send", DOMAINS, "hello", "");
  assert.equal(r.marked, false);
  assert.equal(r.subject, ">>Would otherwise send");
});

test("parseSubjectToken: a custom token replaces the default", () => {
  assert.equal(gs.parseSubjectToken("!!Go", DOMAINS, "hello", "!!").marked, true);
  assert.equal(gs.parseSubjectToken(">>Go", DOMAINS, "hello", "!!").marked, false);
});

// ── Alias selection (premortem item 8) ───────────────────────────────────────

test("resolveAlias: only configured domains resolve", () => {
  assert.equal(gs.resolveAlias("example.net", DOMAINS, "hello"), "hello@example.net");
  assert.equal(gs.resolveAlias("attacker.com", DOMAINS, "hello"), null);
});

test("inferAlias: a reply goes out as the domain it arrived at", () => {
  const alias = gs.inferAlias(
    ["client@external.com", "hello@example.test"],
    DOMAINS,
    "hello"
  );
  assert.equal(alias, "hello@example.test");
});

test("inferAlias: the exact local part received is preserved", () => {
  const alias = gs.inferAlias(["bookings@example.org"], DOMAINS, "hello");
  assert.equal(alias, "bookings@example.org");
});

test("inferAlias: no configured domain in the thread means no guess", () => {
  assert.equal(gs.inferAlias(["a@external.com"], DOMAINS, "hello"), null);
});

// ── Malformed Gmail draft HTML ───────────────────────────────────────────────

// Exactly what Gmail stores for a reply: the document is closed before the
// quote, leaving it outside <body>. Recipients collapse the whole message.
const GMAIL_REPLY_HTML =
  '<html><body><div dir="auto">my new text</div></body></html>' +
  '<br><div class="gmail_extra"><div>On Thu wrote:<br>' +
  '<blockquote class="gmail_quote">the original</blockquote></div></div>';

test("fixStrayClosingTags: moves the closing tags after the quote", () => {
  const fixed = gs.fixStrayClosingTags(GMAIL_REPLY_HTML);
  assert.ok(fixed.endsWith("</body></html>"), "should close at the very end");
  assert.equal((fixed.match(/<\/html>/gi) || []).length, 1, "exactly one </html>");
  assert.equal((fixed.match(/<\/body>/gi) || []).length, 1, "exactly one </body>");
});

test("fixStrayClosingTags: the quote ends up inside the document", () => {
  const fixed = gs.fixStrayClosingTags(GMAIL_REPLY_HTML);
  assert.ok(fixed.indexOf("gmail_quote") < fixed.indexOf("</body>"));
  assert.ok(fixed.indexOf("my new text") < fixed.indexOf("gmail_quote"));
});

test("fixStrayClosingTags: no content is added or lost", () => {
  const fixed = gs.fixStrayClosingTags(GMAIL_REPLY_HTML);
  for (const fragment of ["my new text", "On Thu wrote:", "the original", 'dir="auto"']) {
    assert.ok(fixed.includes(fragment), `lost: ${fragment}`);
  }
});

test("fixStrayClosingTags: well-formed HTML is left untouched", () => {
  const ok = "<html><body><div>hi</div></body></html>";
  assert.equal(gs.fixStrayClosingTags(ok), ok);
});

test("fixStrayClosingTags: plain text without tags is untouched", () => {
  assert.equal(gs.fixStrayClosingTags("just text"), "just text");
});

test("repairHtmlParts: repairs the HTML part and leaves the plain part alone", () => {
  const raw =
    "\r\n--b\r\nContent-Type: text/plain\r\n\r\nmy new text\r\n" +
    "\r\n--b\r\nContent-Type: text/html\r\n\r\n" + GMAIL_REPLY_HTML + "\r\n" +
    "\r\n--b--\r\n";
  const fixed = gs.repairHtmlParts(raw);
  assert.ok(fixed.includes("\r\n--b\r\n"), "MIME boundaries survive");
  assert.ok(fixed.includes("Content-Type: text/plain"), "plain part survives");
  assert.ok(fixed.indexOf("gmail_quote") < fixed.indexOf("</body>"));
});

test("repairHtmlParts: a message with no HTML is returned byte-identical", () => {
  const raw = "\r\n--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n\r\n--b--\r\n";
  assert.equal(gs.repairHtmlParts(raw), raw);
});

test("buildOutbound: the transmitted reply has the quote inside the document", () => {
  const raw = rawMessage(
    { From: "me@gmail.com", To: "x@y.com", "Content-Type": "text/html" },
    GMAIL_REPLY_HTML
  );
  const out = gs.buildOutbound(raw, { from: "hello@example.net", messageId: "<m@example.net>" });
  assert.ok(out.transmit.indexOf("gmail_quote") < out.transmit.indexOf("</body>"));
  assert.ok(out.transmit.includes("my new text"));
  assert.ok(out.transmit.includes("the original"));
});

// ── Last-resort inference from quoted text ───────────────────────────────────

test("inferDomainFromText: finds our domain in a quoted attribution line", () => {
  const body = 'On Thu, 6 Aug 2026 at 19:23, Ada via example.net\r\n<no-reply@example.net> wrote:\r\n> hi';
  assert.equal(gs.inferDomainFromText(body, DOMAINS), "example.net");
});

test("inferDomainFromText: ignores domains that are not ours", () => {
  assert.equal(gs.inferDomainFromText("mail to someone@stranger.com", DOMAINS), null);
});

test("inferDomainFromText: returns the domain only, never the local part", () => {
  // The address in a body is usually the parent's sender, so its local part
  // must not become the sending identity.
  assert.equal(gs.inferDomainFromText("<no-reply@example.org>", DOMAINS), "example.org");
});

test("inferDomainFromText: a bare domain with no address does not match", () => {
  assert.equal(gs.inferDomainFromText("visit https://example.net today", DOMAINS), null);
});

test("inferDomainFromText: empty and null input are safe", () => {
  assert.equal(gs.inferDomainFromText("", DOMAINS), null);
  assert.equal(gs.inferDomainFromText(null, DOMAINS), null);
});

// ── base64url normalisation ──────────────────────────────────────────────────

test("normalizeBase64: converts base64url characters to standard base64", () => {
  assert.equal(gs.normalizeBase64("a-b_"), "a+b/");
  // Already a multiple of four, so no padding is added on top of the swap.
  assert.equal(gs.normalizeBase64("-_-_"), "+/+/");
});

test("normalizeBase64: pads to a multiple of four, as Gmail returns it unpadded", () => {
  assert.equal(gs.normalizeBase64("YQ").length % 4, 0);
  assert.equal(gs.normalizeBase64("YQ"), "YQ==");
  assert.equal(gs.normalizeBase64("YWJj"), "YWJj");
});

test("normalizeBase64: strips whitespace and newlines", () => {
  assert.equal(gs.normalizeBase64("YW\r\nJj"), "YWJj");
});

test("normalizeBase64: null and undefined do not throw", () => {
  assert.equal(gs.normalizeBase64(null), "");
  assert.equal(gs.normalizeBase64(undefined), "");
});

test("normalizeBase64: output round-trips through a real base64 decoder", () => {
  const original = "From: a@b.com\r\nSubject: hi\r\n\r\nbody";
  const urlSafe = Buffer.from(original).toString("base64url");
  const decoded = Buffer.from(gs.normalizeBase64(urlSafe), "base64").toString("utf8");
  assert.equal(decoded, original);
});

// ── Size ceiling (premortem item 7) ──────────────────────────────────────────

test("utf8ByteLength: multibyte characters count as their encoded length", () => {
  assert.equal(gs.utf8ByteLength("abc"), 3);
  assert.equal(gs.utf8ByteLength("é"), 2);
  assert.equal(gs.utf8ByteLength("😀"), 4);
});

test("isOversize: trips just above the SES 10 MB send ceiling", () => {
  assert.ok(!gs.isOversize("x".repeat(gs.SES_MAX_RAW_BYTES)));
  assert.ok(gs.isOversize("x".repeat(gs.SES_MAX_RAW_BYTES + 1)));
});
