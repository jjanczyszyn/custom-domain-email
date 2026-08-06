import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Parse every .gs file.
 *
 * aws.gs, relay.gs, config.gs, and setup.gs are I/O shells with no unit tests —
 * they call GmailApp, UrlFetchApp, and PropertiesService, none of which exist
 * under Node. Without this, a syntax error in them would first surface in
 * production, on a trigger, with mail waiting to go out.
 *
 * `new Function` parses without executing, so the Apps Script globals these
 * files reference are never touched.
 */
const SRC = new URL("../src/", import.meta.url);
const files = readdirSync(SRC).filter((f) => f.endsWith(".gs"));

test("there are .gs sources to check", () => {
  assert.ok(files.length >= 6, `expected the relay sources, found ${files.length}`);
});

for (const file of files) {
  test(`${file}: parses`, () => {
    const src = readFileSync(new URL(file, SRC), "utf8");
    assert.doesNotThrow(() => new Function(src), SyntaxError);
  });
}

test("no credentials are hard-coded in any source file", () => {
  for (const file of files) {
    const src = readFileSync(new URL(file, SRC), "utf8");
    assert.doesNotMatch(src, /(AKIA|ASIA)[A-Z0-9]{16}/, `${file} contains an AWS access key ID`);
    assert.doesNotMatch(
      src,
      /['"][A-Za-z0-9/+=]{40}['"]/,
      `${file} contains something shaped like an AWS secret key`
    );
  }
});
