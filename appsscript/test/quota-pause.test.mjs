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
// mime.gs holds the parse helpers getConfig leans on; inference.gs is what
// classifyDraft resolves an alias with; the rest is the same stack a live
// tick runs through. gmail.gs stays unloaded so its entry points can be
// stubbed per test through globalThis.
const gs = loadGs("mime.gs", "config.gs", "state.gs", "notify.gs", "inference.gs", "relay.gs");

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
  // gmail.gs entry points some tests stub in; cleared so they cannot leak.
  delete globalThis.newMessageId;
  delete globalThis.fetchRawDraft;
  delete globalThis.threadContext;
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
  gs.relayTick(); // arms the pause — and heartbeats itself: it ran
  assert.equal(beats.length, 1, "the failing tick still proves the trigger alive");
  const callsWhenPaused = gmailCalls;

  for (let tick = 0; tick < 60; tick++) gs.relayTick();

  assert.equal(gmailCalls, callsWhenPaused, "an hour of paused ticks costs zero Gmail calls");
  assert.equal(sent.length, 1, "and adds no alert mail");
  assert.equal(beats.length, 61, "every paused tick heartbeats — the trigger IS alive");
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

// A refusal Gmail is known to retract on its own takes the transient path
// instead — see transient-fault.test.mjs — so this uses a failure that means
// nothing but itself.
test("a non-quota failure does not pause Gmail work, but still heartbeats", () => {
  globalThis.GmailApp.getDrafts = () => {
    gmailCalls++;
    throw new Error("the mailbox is haunted");
  };

  gs.relayTick();

  assert.equal(sent.length, 1, "it alerts as before");
  assert.ok(!relayState().pauses.gmail, "but pausing is reserved for the quota");
  assert.equal(beats.length, 1, "a tick that ran and failed is not a silent tick");
});

/**
 * The watchdog's remaining job is TRUE silence. A tick that could not even
 * load its configuration has no AWS credentials to heartbeat with — and the
 * resulting canary mail is then correct: nothing functional is running.
 */
test("a run that dies before config loads does not heartbeat", () => {
  delete store.DOMAINS;

  gs.relayTick();

  assert.equal(sent.length, 1, "the config failure is reported by mail");
  assert.equal(beats.length, 0, "with no config there is nothing to heartbeat with");
});

/**
 * The quota can die between the scan and the classify loop. Each classify
 * costs Gmail calls of its own, so the loop must not spend one per remaining
 * candidate re-discovering the same outage — and must not report it as a
 * mailbox full of "unreadable drafts", which is a different problem.
 */
test("a quota death during classification pauses immediately", () => {
  let classified = 0;
  const quotaDraft = (id) => ({
    getId: () => id,
    getMessage: () => {
      classified++;
      throw new Error(QUOTA_MESSAGE);
    },
  });
  globalThis.GmailApp.getDrafts = () => {
    gmailCalls++;
    return [quotaDraft("d1"), quotaDraft("d2")];
  };

  gs.relayTick();

  assert.equal(classified, 1, "the second draft is never attempted");
  assert.ok(relayState().pauses.gmail, "the pause arms on this tick, not the next");
  assert.equal(sent.length, 1, "one run-failed mail, not one per draft");
});

/**
 * The quota can also die mid-send, fetching the draft's raw content. That is
 * a relay-wide outage, not a defect in the draft — so no per-draft alert, and
 * crucially no `failed` marker, which would hold the draft hostage to a
 * manual retry after an outage it had no part in.
 */
test("a quota death mid-send leaves the draft clean and retryable", () => {
  const message = {
    getSubject: () => ">>example.com hello there",
    getDate: () => new Date(Date.now() - 120 * 1000), // past the settle window
    getThread: () => {
      throw new Error("no thread in this fixture");
    },
  };
  const draft = { getId: () => "d1", getMessage: () => message };
  globalThis.GmailApp.getDrafts = () => {
    gmailCalls++;
    return [draft];
  };
  // gmail.gs is deliberately not loaded; these resolve via globalThis.
  globalThis.threadContext = () => ({ thread: null, labelNames: [] });
  globalThis.newMessageId = () => "<test@example.com>";
  globalThis.fetchRawDraft = () => {
    throw new Error(QUOTA_MESSAGE);
  };

  gs.relayTick();

  assert.equal(sent.length, 1, "one run-failed mail");
  assert.match(sent[0].subject, /run failed/i, "and it is the run-level one");
  const state = relayState();
  assert.ok(state.pauses.gmail, "the outage pauses Gmail work");
  assert.deepEqual(state.failed, {}, "the draft is NOT marked failed");
  assert.deepEqual(state.consumed, {}, "not consumed");
  assert.deepEqual(state.inflight, {}, "and not in flight — it simply retries later");
});
