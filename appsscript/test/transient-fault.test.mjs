import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * Momentary Gmail refusals — the noise floor under the alerting.
 *
 * Gmail's backend intermittently refuses a call that is perfectly valid:
 * "Gmail operation not allowed" thrown by GmailApp.getUserLabelByName(), at
 * 00:10 UTC on 17 Aug 2026, on a relay that ran normally the following minute
 * and every minute after. Reported on sight, that is an email about an event
 * that has already fixed itself — and an alert stream containing those is one
 * the operator learns to skim.
 *
 * So the relay counts them instead, and only a streak is an email. What the
 * tests below pin down is the distinction that makes that safe: a blip is
 * silent, a fault that keeps failing is reported within minutes, and neither
 * path may cost the state bundle the markers a failing tick still needs to
 * persist.
 */
const gs = loadGs("mime.gs", "config.gs", "state.gs", "notify.gs", "inference.gs", "relay.gs");

const TRANSIENT = "Gmail operation not allowed";

let store; // script properties, as one live object
let sent; // alert emails
let beats; // heartbeat calls
let failing; // whether Gmail is currently refusing

beforeEach(() => {
  sent = [];
  beats = [];
  failing = true;
  store = {
    AWS_ACCESS_KEY_ID: "AKIA_TEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    DOMAINS: "example.com",
    ALERT_EMAIL: "alerts@example.com",
  };

  globalThis.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  globalThis.PropertiesService = {
    getScriptProperties: () => ({
      getProperties: () => ({ ...store }),
      getProperty: (key) => (key in store ? store[key] : null),
      setProperty: (key, value) => {
        store[key] = value;
      },
    }),
  };
  globalThis.MailApp = {
    sendEmail: (to, subject, body) => sent.push({ to, subject, body }),
  };
  // Fresh state means the full sweep is due, so the tick's first Gmail call is
  // getDrafts(); a recovered mailbox is simply an empty one.
  globalThis.GmailApp = {
    getDrafts: () => {
      if (failing) throw new Error(TRANSIENT);
      return [];
    },
    getUserLabelByName: () => {
      if (failing) throw new Error(TRANSIENT);
      return null;
    },
  };
  // Only the first tick of a test sweeps; every tick after it takes the
  // targeted path, so gmail.gs's entry points are stubbed too — they refuse
  // exactly as GmailApp does, which is where the live failure came from.
  globalThis.labelledDrafts = () => {
    if (failing) throw new Error(TRANSIENT);
    return [];
  };
  globalThis.listDrafts = () => {
    if (failing) throw new Error(TRANSIENT);
    return [];
  };
  globalThis.draftSubjectByMessageId = () => "";
  globalThis.draftById = () => null;
  globalThis.putRelayHeartbeat = (cfg, sentCount) => beats.push(sentCount);
  delete globalThis.newMessageId;
  delete globalThis.fetchRawDraft;
  delete globalThis.threadContext;
});

const relayState = () => JSON.parse(store._relayState);

test("a one-off refusal is counted, not emailed", () => {
  gs.relayTick();

  assert.equal(sent.length, 0, "a self-healing blip is not worth an email");
  assert.equal(relayState().faults.gmail.count, 1, "but it is remembered");
  assert.equal(beats.length, 1, "and the tick still proves the trigger alive");
});

test("the streak has to survive the tick that recorded it", () => {
  gs.relayTick();

  // The counter lives in the state bundle, so it must be in a declared bucket:
  // anything else is dropped on reload, and the count would restart at one
  // every minute — a fault that never reaches the reporting threshold.
  assert.ok(gs.STATE_BUCKETS.indexOf("faults") !== -1, "faults is a declared bucket");
  const reloaded = gs.loadState({ ...store });
  assert.equal(reloaded.faults.gmail.count, 1, "and survives a reload intact");
});

test("a refusal that keeps refusing is reported, once", () => {
  for (let tick = 0; tick < gs.TRANSIENT_ALERT_AFTER; tick++) gs.relayTick();

  assert.equal(sent.length, 1, "reported on the tick that proves it is not a blip");
  assert.match(sent[0].subject, /run failed/i);
  assert.match(sent[0].body, /consecutive ticks/i, "and says how long it has persisted");

  // Past the threshold the four-hour throttle takes over, as for any other
  // run-level fault: the streak keeps counting, the mailbox stays quiet.
  for (let tick = 0; tick < 30; tick++) gs.relayTick();
  assert.equal(sent.length, 1, "half an hour of the same outage is still one email");
  assert.equal(beats.length, gs.TRANSIENT_ALERT_AFTER + 30, "every tick heartbeats");
});

test("a working tick ends the streak", () => {
  gs.relayTick();
  gs.relayTick();
  assert.equal(relayState().faults.gmail.count, 2, "two in a row");

  failing = false;
  gs.relayTick();
  assert.deepEqual(relayState().faults, {}, "a tick that worked clears the count");

  // …so the next blip starts from one again, rather than inheriting a total
  // accumulated over hours of otherwise healthy running.
  failing = true;
  gs.relayTick();
  assert.equal(relayState().faults.gmail.count, 1);
  assert.equal(sent.length, 0, "and three scattered blips are still not an outage");
});

test("blips too far apart are not one streak", () => {
  gs.relayTick();
  const state = relayState();
  state.faults.gmail.at = Date.now() - gs.TRANSIENT_STREAK_WINDOW_MS - 1;
  store._relayState = JSON.stringify(state);

  gs.relayTick();

  assert.equal(relayState().faults.gmail.count, 1, "the stale streak is not extended");
});

/**
 * The silent path must still persist what the run recorded. reportRunFailed
 * saves unconditionally for this reason — a failing tick has already written
 * the hourly-sweep marker at the top of the run, and dropping it means every
 * failing tick attempts the expensive full scan again, which is how the daily
 * Gmail quota was exhausted in the first place (premortem 18).
 */
test("a silent tick still persists the sweep marker", () => {
  gs.relayTick();

  assert.ok(relayState().sweeps.full, "the sweep it attempted is recorded");
});

/**
 * A failure the relay cannot classify is not given the benefit of the doubt:
 * waiting three minutes to report something that may never clear on its own is
 * the wrong trade in the other direction.
 */
test("an unrecognised failure still alerts on the first tick", () => {
  globalThis.GmailApp.getDrafts = () => {
    throw new Error("something nobody has seen before");
  };

  gs.relayTick();

  assert.equal(sent.length, 1, "reported immediately");
  assert.ok(!relayState().faults.gmail, "and not counted as a transient");
});

/**
 * The short-term rate limit reads almost exactly like the daily quota and means
 * something entirely different: it clears in seconds. Treating it as the
 * day-long condition would suspend Gmail work for half an hour and email a
 * paragraph about a quota that has not run out.
 */
test("the short-term rate limit is transient, not the daily quota", () => {
  const rateLimit = "Service invoked too many times in a short time: gmail. Try Utilities.sleep";
  assert.equal(gs.isServiceQuotaError(new Error(rateLimit)), false);
  assert.equal(gs.isTransientGmailError(new Error(rateLimit)), true);

  const daily = "Service invoked too many times for one day: gmail.";
  assert.equal(gs.isServiceQuotaError(new Error(daily)), true);
  assert.equal(gs.isTransientGmailError(new Error(daily)), false, "the quota owns its own path");

  globalThis.GmailApp.getDrafts = () => {
    throw new Error(rateLimit);
  };
  gs.relayTick();

  assert.equal(sent.length, 0, "a moment of rate limiting is not an email");
  assert.ok(!relayState().pauses.gmail, "and does not suspend half an hour of Gmail work");
});
