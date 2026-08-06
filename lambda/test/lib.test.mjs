import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolve,
  rewrite,
  isProbe,
  isOversize,
  parseHeaders,
  oversizeNotice,
  sanitizeAddressHeaders,
  splitAddressList,
  wrapAsAttachment,
  SES_MAX_RAW_BYTES,
} from "../src/lib.mjs";

const MAPPING = {
  "@example.com": ["owner@gmail.com"],
  "hello@example.org": ["a@gmail.com"],
  "@example.org": ["catchall@gmail.com"],
};

test("resolve: catch-all routes any address on the domain", () => {
  const r = resolve(["anything@example.com"], MAPPING);
  assert.deepEqual(r.destinations, ["owner@gmail.com"]);
  assert.equal(r.fromDomain, "example.com");
});

test("resolve: explicit alias wins over catch-all", () => {
  const r = resolve(["hello@example.org"], MAPPING);
  assert.deepEqual(r.destinations, ["a@gmail.com"]);
});

test("resolve: non-alias address on a mapped domain falls back to catch-all", () => {
  const r = resolve(["random@example.org"], MAPPING);
  assert.deepEqual(r.destinations, ["catchall@gmail.com"]);
});

test("resolve: unknown domain yields no destinations (drop)", () => {
  const r = resolve(["x@unknown.com"], MAPPING);
  assert.deepEqual(r.destinations, []);
  assert.equal(r.fromDomain, null);
});

test("resolve: dedupes destinations and is case-insensitive", () => {
  const r = resolve(["A@example.com", "b@example.com"], MAPPING);
  assert.deepEqual(r.destinations, ["owner@gmail.com"]);
});

test("isProbe: detects the probe localpart, ignores others", () => {
  assert.equal(isProbe(["probe@example.com"], "probe"), true);
  assert.equal(isProbe(["hello@example.com"], "probe"), false);
  assert.equal(isProbe(["x@y.com"], ""), false);
});

const RAW = [
  "Return-Path: <bounce@sender.com>",
  "DKIM-Signature: v=1; a=rsa-sha256; d=sender.com;",
  " bh=abc; b=def",
  'From: "Jane Doe" <jane@sender.com>',
  "To: hello@example.com",
  "Subject: Hi there",
  "",
  "Body line one.",
  "",
].join("\r\n");

test("rewrite: From becomes our domain, original kept in Reply-To", () => {
  const out = rewrite(RAW, "no-reply@example.com");
  assert.match(out, /^From: "Jane Doe via example\.com" <no-reply@example\.com>/m);
  assert.match(out, /^Reply-To: "Jane Doe" <jane@sender\.com>/m);
});

test("rewrite: strips Return-Path and DKIM-Signature (incl. folded lines)", () => {
  const out = rewrite(RAW, "no-reply@example.com");
  assert.doesNotMatch(out, /^Return-Path:/m);
  assert.doesNotMatch(out, /^DKIM-Signature:/m);
  assert.doesNotMatch(out, /bh=abc/);
});

test("rewrite: preserves Subject and body", () => {
  const out = rewrite(RAW, "no-reply@example.com");
  assert.match(out, /^Subject: Hi there$/m);
  assert.match(out, /Body line one\./);
});

test("rewrite: bare From address (no display name) still rewrites", () => {
  const raw = "From: jane@sender.com\r\nSubject: x\r\n\r\nbody";
  const out = rewrite(raw, "no-reply@example.com");
  assert.match(out, /^From: "jane@sender\.com via example\.com" <no-reply@example\.com>/m);
  assert.match(out, /^Reply-To: jane@sender\.com/m);
});

test("rewrite: existing Reply-To is not overwritten", () => {
  const raw = "From: jane@sender.com\r\nReply-To: real@sender.com\r\nSubject: x\r\n\r\nb";
  const out = rewrite(raw, "no-reply@example.com");
  assert.match(out, /^Reply-To: real@sender\.com$/m);
  assert.doesNotMatch(out, /Reply-To:.*jane/);
});

// The real-world failure that started this: an Outlook client emitted a broken
// "<undisclosed-recipients:>" group, and SES rejected the whole send with
// "Local address contains illegal character", parking the mail in the DLQ.
const BROKEN_TO = [
  "From: <sender@gmail.com>",
  'To: "\'Ada Lovelace\'" <hello@example.net>,',
  "\t<undisclosed-recipients:>",
  "Subject: RE: hi",
  "",
  "Thanks!",
].join("\r\n");

test("sanitizeAddressHeaders: drops <undisclosed-recipients:>, keeps the real address", () => {
  const out = sanitizeAddressHeaders(BROKEN_TO);
  assert.match(out, /^To: "'Ada Lovelace'" <hello@example\.net>\r?$/m);
  assert.doesNotMatch(out, /undisclosed-recipients/);
});

test("sanitizeAddressHeaders: does not break the header block (no stray blank line)", () => {
  const out = sanitizeAddressHeaders(BROKEN_TO);
  // Subject must survive as a header, i.e. the To edit didn't terminate headers.
  assert.match(out, /^Subject: RE: hi$/m);
  assert.match(out, /\r\n\r\nThanks!$/);
});

test("sanitizeAddressHeaders: removes a header left with no valid address entirely", () => {
  const raw = "To: <undisclosed-recipients:>\r\nSubject: x\r\n\r\nbody";
  const out = sanitizeAddressHeaders(raw);
  assert.doesNotMatch(out, /^To:/m);
  assert.match(out, /^Subject: x$/m); // headers still intact, no blank-line split
});

test("sanitizeAddressHeaders: preserves a clean multi-recipient list", () => {
  const raw = "To: a@x.com, \"B\" <b@y.com>\r\nCc: c@z.com\r\n\r\nbody";
  const out = sanitizeAddressHeaders(raw);
  assert.match(out, /^To: a@x\.com, "B" <b@y\.com>$/m);
  assert.match(out, /^Cc: c@z\.com$/m);
});

test("sanitizeAddressHeaders: keeps good addresses, drops only the malformed ones in a mixed list", () => {
  const raw = "To: good@x.com, <undisclosed-recipients:>, also@y.com\r\n\r\nb";
  const out = sanitizeAddressHeaders(raw);
  assert.match(out, /^To: good@x\.com, also@y\.com$/m);
});

test("rewrite: a message with a broken recipient header now sanitizes to a sendable form", () => {
  const out = rewrite(BROKEN_TO, "no-reply@example.net");
  assert.doesNotMatch(out, /undisclosed-recipients/);
  // Bare From (no display name) rewrites to our address; sender kept in Reply-To.
  assert.match(out, /^From: <no-reply@example\.net>/m);
  assert.match(out, /^Reply-To: <sender@gmail\.com>/m);
  assert.match(out, /^To: "'Ada Lovelace'" <hello@example\.net>\r?$/m);
});

test("splitAddressList: commas inside quotes and angle brackets do not split", () => {
  const parts = splitAddressList('"Doe, Jane" <jane@x.com>, bob@y.com');
  assert.deepEqual(parts.map((p) => p.trim()), ['"Doe, Jane" <jane@x.com>', "bob@y.com"]);
});

test("wrapAsAttachment: builds a clean envelope with the original as message/rfc822", () => {
  const original = "From: \"Jane\" <jane@sender.com>\r\nTo: <undisclosed-recipients:>\r\nSubject: Hi\r\n\r\nBody!";
  const out = wrapAsAttachment(original, {
    fromAddress: "no-reply@example.net",
    destinations: ["owner@gmail.com"],
  }).toString("utf-8");
  assert.match(out, /^From: "Jane via example\.net" <no-reply@example\.net>/m);
  assert.match(out, /^Reply-To: "Jane" <jane@sender\.com>/m);
  assert.match(out, /^To: owner@gmail\.com$/m);
  assert.match(out, /^Subject: Hi$/m);
  assert.match(out, /Content-Type: multipart\/mixed; boundary=/);
  assert.match(out, /Content-Type: message\/rfc822/);
  // The original (with its broken header) is base64-encoded inside, so SES's
  // address parser never sees it.
  const b64 = Buffer.from(original).toString("base64");
  assert.ok(out.includes(b64.slice(0, 40)));
});

test("isOversize: true past the SES limit (minus margin), false below", () => {
  assert.equal(isOversize(SES_MAX_RAW_BYTES + 1), true);
  assert.equal(isOversize(SES_MAX_RAW_BYTES - 256 * 1024 + 1), true); // inside margin
  assert.equal(isOversize(5 * 1024 * 1024), false);
  assert.equal(isOversize(0), false);
});

test("parseHeaders: extracts named headers and unfolds continuations", () => {
  const raw = [
    'From: "Jane Doe" <jane@sender.com>',
    "Subject: a very",
    " long subject",
    "To: hello@example.com",
    "",
    "body From: not-a-header@x.com",
  ].join("\r\n");
  const h = parseHeaders(raw, ["from", "subject"]);
  assert.equal(h.from, '"Jane Doe" <jane@sender.com>');
  assert.equal(h.subject, "a very long subject"); // folded line joined
});

test("oversizeNotice: threads correctly and points at the S3 original", () => {
  const headerRaw = [
    'From: "Jane Doe" <jane@sender.com>',
    "Subject: Big photos",
    "Date: Mon, 29 Jun 2026 12:40:57 +0200",
    "",
  ].join("\r\n");
  const out = oversizeNotice({
    headerRaw,
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    bucket: "my-bucket",
    key: "archive/abc123",
    sizeBytes: 12118707,
  });
  assert.match(out, /^From: "Jane Doe via example\.com" <no-reply@example\.com>/m);
  assert.match(out, /^Reply-To: "Jane Doe" <jane@sender\.com>/m);
  assert.match(out, /^Subject: \[Large email — not auto-forwarded\] Big photos/m);
  assert.match(out, /11\.6 MB/); // 12118707 bytes
  assert.match(out, /archived permanently/);
  assert.match(out, /aws s3 cp s3:\/\/my-bucket\/archive\/abc123/);
});

test("oversizeNotice: bare From (no display name) still threads", () => {
  const out = oversizeNotice({
    headerRaw: "From: jane@sender.com\r\nSubject: x\r\n\r\n",
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    bucket: "b",
    key: "k",
    sizeBytes: 11 * 1024 * 1024,
  });
  assert.match(out, /^From: "jane@sender\.com via example\.com" <no-reply@example\.com>/m);
  assert.match(out, /^Reply-To: jane@sender\.com$/m);
});
