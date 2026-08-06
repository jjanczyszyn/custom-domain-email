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
