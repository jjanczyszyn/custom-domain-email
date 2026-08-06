import { readFileSync } from "node:fs";
import nodeCryptoLib from "node:crypto";

/**
 * Load Apps Script .gs sources so Node's test runner can exercise them.
 *
 * The sources are concatenated and evaluated in a single function scope, which
 * is how Apps Script resolves top-level declarations across a project's files
 * — so the code runs here the way it runs in production, with no build step and
 * no dependencies.
 *
 * Evaluated in the host realm rather than a vm sandbox on purpose: a sandbox
 * gives the code its own Array/Object intrinsics, and assert.deepEqual then
 * rejects structurally identical arrays for not sharing a prototype. Each .gs
 * file merges into a shared `module.exports`, which Apps Script itself skips
 * because `module` is undefined there.
 */
export function loadGs(...files) {
  const src = files
    .map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"))
    .join("\n");
  const module = { exports: {} };
  return new Function("module", `${src}\nreturn module.exports;`)(module);
}

/** The crypto adapter sigv4.gs expects, backed by node:crypto. */
export const nodeCrypto = {
  sha256Hex: (s) => nodeCryptoLib.createHash("sha256").update(s, "utf8").digest("hex"),
  hmac: (key, msg) =>
    Array.from(
      nodeCryptoLib.createHmac("sha256", Buffer.from(key)).update(msg, "utf8").digest()
    ),
  toBytes: (s) => Array.from(Buffer.from(s, "utf8")),
  hex: (bytes) => Buffer.from(bytes).toString("hex"),
};

/** Build a raw RFC822 message from headers + body, with CRLF line endings. */
export function rawMessage(headers, body = "hello") {
  const head = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return `${head}\r\n\r\n${body}`;
}
