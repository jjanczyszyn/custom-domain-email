import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * Run-level alerts are throttled — premortem item 18, second half.
 *
 * The relay's top-level handler emails whenever a run fails. That class of
 * failure repeats on every tick by nature, so when the relay ran out of Gmail
 * quota the handler would have sent the same mail on all 1,440 ticks of the
 * day. Those alerts draw on a *separate* 100-recipients-a-day quota — the one
 * per-draft failure alerts depend on — so one stuck relay would have taken the
 * alarm system down with it.
 */
const gs = loadGs("config.gs", "state.gs", "notify.gs");

let sent;

beforeEach(() => {
  sent = [];
  globalThis.MailApp = { sendEmail: (to, subject, body) => sent.push({ to, subject, body }) };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: () => "alerts@example.com",
      setProperty: () => {},
    }),
  };
});

const quotaError = () => new Error("Service invoked too many times for one day: gmail.");

test("the same failure is emailed once, not on every tick", () => {
  const state = gs.emptyState();
  const props = { setProperty: () => {} };

  for (let tick = 0; tick < 100; tick++) {
    gs.reportRunFailed(quotaError(), state, props);
  }

  assert.equal(sent.length, 1, "1,440 ticks must not become 1,440 emails");
});

test("a different failure is still reported", () => {
  const state = gs.emptyState();
  const props = { setProperty: () => {} };

  gs.reportRunFailed(quotaError(), state, props);
  gs.reportRunFailed(new Error("Missing Script Properties: DOMAINS"), state, props);

  assert.equal(sent.length, 2, "throttling is per fault, not global");
});

/** The quota case is worth explaining in the mail itself — it looks like an AWS
 * outage and is not one, and it clears without intervention. */
test("a quota failure explains itself", () => {
  const state = gs.emptyState();
  gs.reportRunFailed(quotaError(), state, { setProperty: () => {} });

  assert.match(sent[0].body, /daily quota/i);
  assert.match(sent[0].body, /resets/i);
  assert.match(sent[0].body, /not an SES or AWS problem/i);
});

/**
 * The marker lives in state, which is reloaded from a property every tick — so
 * a marker that is not persisted is no marker at all. This is the footgun
 * state.gs warns about, in the one place where getting it wrong reproduces
 * exactly the bug being fixed.
 */
test("the throttle marker is persisted, not just held in memory", () => {
  const writes = [];
  const state = gs.emptyState();

  gs.reportRunFailed(quotaError(), state, { setProperty: (k, v) => writes.push(v) });

  assert.equal(writes.length, 1, "the marker must survive the tick that set it");
  assert.ok(
    JSON.parse(writes[0]).notices["gmail-quota"],
    "and must land in a declared bucket, or the reload drops it"
  );
});

test("a run that failed before state could load still alerts", () => {
  gs.reportRunFailed(new Error("PropertiesService unavailable"), null, null);

  assert.equal(sent.length, 1, "unthrottled is noisy; missing is invisible");
});
