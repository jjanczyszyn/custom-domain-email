import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, rewrite, isProbe } from "../src/lib.mjs";

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
