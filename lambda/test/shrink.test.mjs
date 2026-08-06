import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shrinkToFit } from "../src/shrink.mjs";

const IMG_B64 = readFileSync(new URL("./fixtures/sample-image.b64", import.meta.url), "utf-8");
const wrapped = IMG_B64.replace(/(.{76})/g, "$1\r\n");

// A multipart/related message with a cid: inline image, like Gmail sends.
const RELATED = [
  'From: "Jane Doe" <jane@sender.com>',
  "To: hello@example.com",
  "Subject: Trip photos",
  "Date: Mon, 29 Jun 2026 12:00:00 +0000",
  "Message-ID: <orig@sender.com>",
  "In-Reply-To: <thread-root@sender.com>",
  "References: <thread-root@sender.com>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/related; boundary="BOUND"',
  "",
  "--BOUND",
  'Content-Type: text/html; charset="UTF-8"',
  "",
  '<div>Here you go <img src="cid:img1@sender.com"></div>',
  "--BOUND",
  "Content-Type: image/jpeg",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <img1@sender.com>",
  'Content-Disposition: inline; filename="pic.jpg"',
  "",
  wrapped,
  "--BOUND--",
  "",
].join("\r\n");

test("shrinkToFit: inline image becomes a cid: part, never a data: URI", async () => {
  const res = await shrinkToFit(RELATED, {
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    targetBytes: 5 * 1024 * 1024,
  });
  assert.ok(res, "expected a rebuilt message");
  const out = res.message.toString("utf-8");
  assert.match(out, /^From: "Jane Doe via example\.com" <no-reply@example\.com>/m);
  assert.match(out, /^Reply-To: .*jane@sender\.com/m);
  assert.match(out, /^Subject: Trip photos/m);
  assert.match(out, /cid:inline-0@example\.com/); // html now references a cid
  assert.doesNotMatch(out, /data:image/); // and not an inline data: URI
  assert.match(out, /Content-Type: image\/jpeg/i);
});

test("shrinkToFit: preserves threading headers", async () => {
  const res = await shrinkToFit(RELATED, {
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    targetBytes: 5 * 1024 * 1024,
  });
  const out = res.message.toString("utf-8");
  assert.match(out, /^In-Reply-To: .*thread-root@sender\.com/m);
  assert.match(out, /^References: .*thread-root@sender\.com/m);
});

test("shrinkToFit: actually shrinks an oversize image under a tight budget", async () => {
  // The fixture encodes to ~190 KB; require the rebuild to come in well under.
  const res = await shrinkToFit(RELATED, {
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    targetBytes: 140 * 1024,
  });
  assert.ok(res, "expected recompression to fit the budget");
  assert.ok(res.newBytes <= 140 * 1024, `newBytes=${res.newBytes}`);
});

test("shrinkToFit: returns null when a non-image payload exceeds budget", async () => {
  const big = [
    "From: jane@sender.com",
    "To: hello@example.com",
    "Subject: huge file",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "see attached",
    "--B",
    'Content-Type: application/octet-stream; name="big.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="big.bin"',
    "",
    wrapped, // ~140 KB of non-image bytes
    "--B--",
    "",
  ].join("\r\n");
  const res = await shrinkToFit(big, {
    fromAddress: "no-reply@example.com",
    destinations: ["owner@gmail.com"],
    targetBytes: 50 * 1024, // smaller than the attachment
  });
  assert.equal(res, null);
});
