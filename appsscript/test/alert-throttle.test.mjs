import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * Alerts must never become the problem — premortem item 18, second half.
 *
 * The relay's top-level handler emails whenever a run fails. That class of
 * failure repeats on every tick by nature, so when the relay ran out of Gmail
 * quota the handler would have sent the same mail on all 1,440 ticks of the
 * day. Those alerts draw on a *separate* 100-recipients-a-day quota — the one
 * per-draft failure alerts depend on — so one stuck relay would have taken the
 * alarm system down with it.
 *
 * Two independent guards, tested separately here because they fail separately:
 * a per-fault throttle stops the same failure repeating, and a volume cap
 * bounds everything else regardless of how many distinct things go wrong.
 */
const gs = loadGs("config.gs", "state.gs", "notify.gs");

let sent;
let store;

beforeEach(() => {
  sent = [];
  // A real key-value store, not a stub that answers every key the same way:
  // the volume cap keeps its own property, and a stub that shadowed it would
  // have let these tests pass while the cap did nothing.
  store = { ALERT_EMAIL: "alerts@example.com" };
  globalThis.MailApp = { sendEmail: (to, subject, body) => sent.push({ to, subject, body }) };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (key in store ? store[key] : null),
      setProperty: (key, value) => {
        store[key] = value;
      },
    }),
  };
});

const quotaError = () => new Error("Service invoked too many times for one day: gmail.");
const freshState = () => gs.loadState({}); // as a real tick does, before anything else

// ── The per-fault throttle ───────────────────────────────────────────────────

test("the same failure is emailed once, not on every tick", () => {
  const state = freshState();

  for (let tick = 0; tick < 100; tick++) {
    gs.reportRunFailed(quotaError(), state, { setProperty: () => {} });
  }

  assert.equal(sent.length, 1, "1,440 ticks must not become 1,440 emails");
});

test("a different failure is still reported", () => {
  const state = freshState();
  const props = { setProperty: () => {} };

  gs.reportRunFailed(quotaError(), state, props);
  gs.reportRunFailed(new Error("Missing Script Properties: DOMAINS"), state, props);

  assert.equal(sent.length, 2, "throttling is per fault, not global");
});

/** The quota case is worth explaining in the mail itself — it looks like an AWS
 * outage and is not one, and it clears without intervention. */
test("a quota failure explains itself", () => {
  gs.reportRunFailed(quotaError(), freshState(), { setProperty: () => {} });

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

  gs.reportRunFailed(quotaError(), freshState(), { setProperty: (k, v) => writes.push(v) });

  assert.equal(writes.length, 1, "the marker must survive the tick that set it");
  assert.ok(
    JSON.parse(writes[0]).notices["gmail-quota"],
    "and must land in a declared bucket, or the reload drops it"
  );
});

/**
 * The regression this guards: a suppressed alert used to return before saving.
 * A failing tick has already set the hourly-sweep marker, so dropping that
 * write made every failing tick retry the expensive full scan — which is
 * exactly what exhausted the quota to begin with.
 */
test("state is persisted even when the alert itself is suppressed", () => {
  const state = freshState();
  const writes = [];
  const props = { setProperty: (k, v) => writes.push(v) };

  gs.reportRunFailed(quotaError(), state, props); // first: alerts, and saves
  state.sweeps.full = { at: 111 }; // as collectDrafts sets at the top of a tick
  gs.reportRunFailed(quotaError(), state, props); // second: throttled

  assert.equal(sent.length, 1, "the second alert is suppressed");
  assert.equal(writes.length, 2, "but its state still has to be written");
  assert.deepEqual(
    JSON.parse(writes[1]).sweeps.full,
    { at: 111 },
    "or the next tick runs the expensive scan again"
  );
});

test("a run that failed before state could load still alerts", () => {
  gs.reportRunFailed(new Error("PropertiesService unavailable"), null, null);

  assert.equal(sent.length, 1, "unthrottled is noisy; missing is invisible");
});

// ── The volume cap ───────────────────────────────────────────────────────────

test("a burst of distinct failures is capped", () => {
  for (let i = 0; i < 20; i++) gs.tryAlert("failure number " + i, "body");

  const hourly = gs.ALERT_BUDGET_WINDOWS[0].max;
  assert.equal(sent.length, hourly, `no more than ${hourly} alerts an hour, whatever happens`);
});

/**
 * A cap that silently drops mail is worse than no cap: it makes "nothing is
 * wrong" and "everything is wrong" look identical from the inbox.
 */
test("the next alert through says how many were held back", () => {
  const hourly = gs.ALERT_BUDGET_WINDOWS[0].max;
  for (let i = 0; i < hourly + 3; i++) gs.tryAlert("failure " + i, "body");
  assert.equal(sent.length, hourly);

  // Wind the hour window back so the next alert is allowed through.
  const budget = JSON.parse(store._relayAlertBudget);
  budget.hour.start -= gs.ALERT_BUDGET_WINDOWS[0].ms + 1;
  store._relayAlertBudget = JSON.stringify(budget);

  gs.tryAlert("something new", "body");

  assert.equal(sent.length, hourly + 1);
  assert.match(sent[sent.length - 1].body, /3 further alert\(s\) were suppressed/);
});

test("an unreadable budget is not a reason to stay silent", () => {
  store._relayAlertBudget = "{not json";

  gs.tryAlert("a real failure", "body");

  assert.equal(sent.length, 1);
});

test("no alert address configured means no mail and no crash", () => {
  delete store.ALERT_EMAIL;

  assert.doesNotThrow(() => gs.tryAlert("a failure", "body"));
  assert.equal(sent.length, 0);
});

test("a failing mail send never propagates out of tryAlert", () => {
  globalThis.MailApp = {
    sendEmail: () => {
      throw new Error("Service invoked too many times for one day: email");
    },
  };

  assert.doesNotThrow(() => gs.tryAlert("a failure", "body"));
});
