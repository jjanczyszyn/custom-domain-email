import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The alert subject prefix is declared independently in three places — the
 * relay (Apps Script), the DLQ notifier (Lambda), and the canary (Lambda) —
 * because they are separate runtimes that share no code.
 *
 * A single Gmail filter matches on that phrase, so if one of them drifts its
 * alerts stop being filed and quietly go unnoticed. That is precisely the
 * failure the alerts exist to prevent, so it is worth a test.
 */
const EXPECTED = "[SES alert]";

const SOURCES = {
  "appsscript/src/config.gs": /var ALERT_SUBJECT_PREFIX = '([^']+)'/,
  "notifier/index.mjs": /const ALERT_PREFIX = "([^"]+)"/,
  "canary/index.mjs": /const ALERT_PREFIX = "([^"]+)"/,
};

for (const [file, pattern] of Object.entries(SOURCES)) {
  test(`${file}: declares the shared alert prefix`, () => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    const match = src.match(pattern);
    assert.ok(match, `no alert prefix declaration found in ${file}`);
    assert.equal(match[1], EXPECTED);
  });
}

test("every alert subject is built from the prefix, never hard-coded", () => {
  const files = ["notifier/index.mjs", "canary/index.mjs"];
  for (const file of files) {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    // A literal "[SES alert]" inside a subject string would bypass the constant
    // and drift silently. The declaration itself is the only allowed occurrence.
    const occurrences = src.split(EXPECTED).length - 1;
    assert.equal(occurrences, 1, `${file} hard-codes the prefix instead of using the constant`);
  }
});
