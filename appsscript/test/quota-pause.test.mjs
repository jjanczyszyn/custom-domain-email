import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * The quota pause — premortem item 18, third act.
 *
 * Exhausting Gmail's daily quota is a condition, not an event: every Gmail
 * call fails identically until the day's window rolls over. The first fix
 * (targeted scans) stops the relay causing that condition. This one stops the
 * relay narrating it — a tick that dies on the quota suspends Gmail work, and
 * the ticks that follow heartbeat and exit instead of failing the same way
 * once a minute for the rest of the day, each failure re-tempting the alert
 * throttle and starving the external watchdog of heartbeats.
 *
 * These tests drive relayTick itself, with the world stubbed at the same
 * boundaries Apps Script provides it: GmailApp, LockService, MailApp,
 * PropertiesService, and the heartbeat.
 */
// mime.gs holds the parse helpers getConfig leans on; the rest is the same
// stack a live tick runs through.
const gs = loadGs("mime.gs", "config.gs", "state.gs", "notify.gs", "relay.gs");

const QUOTA_MESSAGE = "Service invoked too many times for one day: gmail.";

let store; // script properties, as one live object
let sent; // alert emails
let beats; // heartbeat calls
let gmailCalls; // every GmailApp entry relayTick could take

beforeEach(() => {
  sent = [];
  beats = [];
  gmailCalls = 0;
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
  // Fresh state means the full sweep is due, so the first Gmail call a tick
  // makes is getDrafts() — the exact call the relay died on in production.
  globalThis.GmailApp = {
    getDrafts: () => {
      gmailCalls++;
      throw new Error(QUOTA_MESSAGE);
    },
    getUserLabelByName: () => {
      gmailCalls++;
      throw new Error(QUOTA_MESSAGE);
    },
  };
  globalThis.putRelayHeartbeat = (cfg, sentCount) => beats.push(sentCount);
});

const relayState = () => JSON.parse(store._relayState);

test("a quota death pauses Gmail work and the pause persists", () => {
  gs.relayTick();

  assert.equal(sent.length, 1, "the episode is reported once");
  const pause = relayState().pauses.gmail;
  assert.ok(pause, "the pause must land in a declared bucket to survive reload");
  assert.ok(
    pause.until > Date.now() && pause.until <= Date.now() + gs.QUOTA_PAUSE_MS,
    "and suspend roughly QUOTA_PAUSE_MS of Gmail work"
  );
});

test("paused ticks make no Gmail calls, send no mail, and still heartbeat", () => {
  gs.relayTick(); // arms the pause
  const callsWhenPaused = gmailCalls;

  for (let tick = 0; tick < 60; tick++) gs.relayTick();

  assert.equal(gmailCalls, callsWhenPaused, "an hour of paused ticks costs zero Gmail calls");
  assert.equal(sent.length, 1, "and adds no alert mail");
  assert.equal(beats.length, 60, "every paused tick heartbeats — the trigger IS alive");
  assert.ok(beats.every((n) => n === 0), "reporting nothing sent, which is the truth");
});

test("an expired pause probes Gmail again", () => {
  gs.relayTick();
  const state = relayState();
  state.pauses.gmail.until = Date.now() - 1;
  // Make the probe deterministic: with the sweep due, the tick's first Gmail
  // call is getDrafts(), the stubbed entry point. (A real probe may take the
  // targeted path instead; either way its first Gmail call throws the same.)
  delete state.sweeps.full;
  store._relayState = JSON.stringify(state);

  const before = gmailCalls;
  gs.relayTick();

  assert.ok(gmailCalls > before, "past the pause, the next tick asks Gmail again");
  const rearmed = relayState().pauses.gmail;
  assert.ok(rearmed.until > Date.now(), "and a still-dead quota re-arms the pause");
  assert.equal(sent.length, 1, "without another email — same episode, same silence");
});

test("a recovered quota resumes normal scanning", () => {
  gs.relayTick();
  const state = relayState();
  state.pauses.gmail.until = Date.now() - 1;
  delete state.sweeps.full; // as above: route the probe through getDrafts()
  store._relayState = JSON.stringify(state);

  // Gmail is back: the full sweep succeeds and finds an empty mailbox.
  globalThis.GmailApp.getDrafts = () => {
    gmailCalls++;
    return [];
  };

  gs.relayTick();

  const beat = beats[beats.length - 1];
  assert.equal(beat, 0, "the recovered tick completes and heartbeats");
  const after = relayState();
  assert.ok(
    !after.pauses.gmail || after.pauses.gmail.until < Date.now(),
    "and no future tick is still paused"
  );
});

test("a non-quota failure does not pause Gmail work", () => {
  globalThis.GmailApp.getDrafts = () => {
    gmailCalls++;
    throw new Error("Gmail operation not allowed");
  };

  gs.relayTick();

  assert.equal(sent.length, 1, "it alerts as before");
  assert.ok(!relayState().pauses.gmail, "but pausing is reserved for the quota");
});
