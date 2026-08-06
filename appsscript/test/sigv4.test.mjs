import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGs, nodeCrypto } from "./helpers.mjs";

const gs = loadGs("sigv4.gs");

// AWS publishes a signing test suite; "get-vanilla" is its simplest case and
// pins the whole algorithm end to end. If this passes, the canonical request,
// the scope, the key derivation, and the final HMAC are all correct — which is
// the point of keeping signing pure and testable rather than debugging a 403
// from inside the Apps Script editor.
const VECTOR = {
  date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  creds: {
    accessKey: "AKIDEXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
  },
  request: {
    method: "GET",
    path: "/",
    query: "",
    headers: { Host: "example.amazonaws.com" },
    body: "",
  },
  signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
};

test("sigv4: matches the AWS get-vanilla test vector", () => {
  const out = gs.signRequest(nodeCrypto, VECTOR.request, VECTOR.creds, VECTOR.date);
  assert.equal(out.signature, VECTOR.signature);
});

test("sigv4: Authorization header carries credential scope and signed headers", () => {
  const out = gs.signRequest(nodeCrypto, VECTOR.request, VECTOR.creds, VECTOR.date);
  assert.match(
    out.headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/
  );
});

test("sigv4: timestamps render in the required compact UTC form", () => {
  const ts = gs.sigv4Timestamps(new Date(Date.UTC(2027, 0, 5, 9, 3, 7)));
  assert.equal(ts.amzDate, "20270105T090307Z");
  assert.equal(ts.dateStamp, "20270105");
});

test("sigv4: canonical headers are lowercased, sorted, and whitespace-collapsed", () => {
  const cr = gs.canonicalRequest(nodeCrypto, {
    method: "POST",
    path: "/v2/email/outbound-emails",
    query: "",
    headers: { "X-Amz-Date": "20260806T000000Z", Host: "h", "Content-Type": "  a/b   c  " },
    body: "{}",
  });
  assert.equal(cr.signedHeaders, "content-type;host;x-amz-date");
  assert.match(cr.canonical, /content-type:a\/b c\n/);
});

test("sigv4: a session token is signed when present", () => {
  const out = gs.signRequest(
    nodeCrypto,
    VECTOR.request,
    { ...VECTOR.creds, sessionToken: "TOKEN" },
    VECTOR.date
  );
  assert.equal(out.headers["x-amz-security-token"], "TOKEN");
  assert.match(out.headers.Authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test("sigv4: the body is what gets hashed — changing it changes the signature", () => {
  const a = gs.signRequest(nodeCrypto, { ...VECTOR.request, body: "{}" }, VECTOR.creds, VECTOR.date);
  const b = gs.signRequest(nodeCrypto, { ...VECTOR.request, body: "{ }" }, VECTOR.creds, VECTOR.date);
  assert.notEqual(a.signature, b.signature);
});
