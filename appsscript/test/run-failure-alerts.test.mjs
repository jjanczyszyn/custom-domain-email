import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * When a failed run is worth an email — premortem item 19.
 *
 * The policy: mail is sent when mail is at stake. A tick that dies with nothing
 * waiting to go out has harmed nothing, gives its reader nothing to do, and is
 * recorded rather than reported; a tick that dies holding marked drafts is an
 * email immediately. What keeps the silence honest is that a relay which cannot
 * talk to Gmail also cannot see a draft marked while it is broken — so "nothing
 * was waiting" expires, and a fault still failing after the blind window is
 * reported whether or not anything was known to be pending.
 *
 * The trigger for all of this: 00:10 UTC on 17 Aug 2026, one alert about a
 * `Gmail operation not allowed` that the following tick had already recovered
 * from, with an idle mailbox and nothing for anyone to do about it.
 */
const gs = loadGs("mime.gs", "config.gs", "state.gs", "notify.gs", "inference.gs", "relay.gs");

const TRANSIENT = "Gmail operation not allowed";
const UNKNOWN = "the mailbox is haunted";
const QUOTA = "Service invoked too many times for one day: gmail.";

let store; // script properties, as one live object
let sent; // alert emails
let beats; // heartbeat calls
let faultMetrics; // RelayFault dimension slugs
let failure; // what Gmail throws, or null when it is healthy

beforeEach(() => {
  sent = [];
  beats = [];
  faultMetrics = [];
  failure = TRANSIENT;
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

  const refuse = () => {
    if (failure) throw new Error(failure);
  };
  // A fresh state means the full sweep is due, so the first tick calls
  // getDrafts(); every tick after it takes the targeted path through gmail.gs,
  // which is deliberately not loaded so its entry points can be stubbed here.
  globalThis.GmailApp = {
    getDrafts: () => {
      refuse();
      return [];
    },
    getUserLabelByName: () => {
      refuse();
      return null;
    },
  };
  globalThis.labelledDrafts = () => {
    refuse();
    return [];
  };
  globalThis.listDrafts = () => {
    refuse();
    return [];
  };
  globalThis.draftSubjectByMessageId = () => "";
  globalThis.draftById = () => null;
  globalThis.putRelayHeartbeat = (cfg, sentCount) => beats.push(sentCount);
  globalThis.putRelayFault = (cfg, slug) => faultMetrics.push(slug);
  delete globalThis.newMessageId;
  delete globalThis.fetchRawDraft;
  delete globalThis.threadContext;
});

const relayState = () => JSON.parse(store._relayState);

/** Put the relay into a state where it has been failing for `minutes`. */
const failingFor = (minutes) => {
  gs.relayTick();
  const state = relayState();
  state.faults.run.first = Date.now() - minutes * 60 * 1000;
  store._relayState = JSON.stringify(state);
};

/** A draft the scan has already classified as marked and not yet sent. */
const markedDraftPending = (id = "d1") => {
  const state = relayState();
  state.seen[id] = { messageId: "m1", at: Date.now(), marked: true };
  store._relayState = JSON.stringify(state);
};

test("a failure with nothing waiting is recorded, not emailed", () => {
  gs.relayTick();

  assert.equal(sent.length, 0, "nobody is interrupted over mail that does not exist");
  assert.equal(beats.length, 1, "the tick still proves the trigger alive");

  const journal = Object.values(relayState().journal);
  assert.equal(journal.length, 1, "but the failure is on file");
  assert.equal(journal[0].count, 1);
  assert.match(journal[0].message, /operation not allowed/i, "with what actually failed");
  assert.ok(!journal[0].emailed, "recorded as never emailed");
});

test("the quiet path still reports to CloudWatch", () => {
  gs.relayTick();

  // The metric is the view that needs nothing from Google to read — which is
  // the only kind of view worth having when Gmail is the thing failing.
  assert.deepEqual(faultMetrics, ["gmail-operation-not-allowed"], "one fault, named");
});

test("repeats of the same failure collapse into one journal entry", () => {
  for (let tick = 0; tick < 5; tick++) gs.relayTick();

  let journal = Object.values(relayState().journal);
  assert.equal(journal.length, 1, "one fault, not five");
  assert.equal(journal[0].count, 5, "counted");
  assert.equal(sent.length, 0, "and five minutes of this is still not an email");

  // "When did this start?" is the question a journal exists to answer, so the
  // first sighting has to survive every later one.
  const state = relayState();
  const key = Object.keys(state.journal)[0];
  const started = Date.now() - 60 * 60 * 1000;
  state.journal[key].first = started;
  store._relayState = JSON.stringify(state);

  gs.relayTick();

  journal = Object.values(relayState().journal);
  assert.equal(journal[0].first, started, "the first sighting is not overwritten");
  assert.ok(journal[0].at >= started, "and the last one tracks the newest");
});

test("a working tick ends the spell but keeps the record", () => {
  gs.relayTick();
  gs.relayTick();
  assert.equal(relayState().faults.run.count, 2);

  failure = null;
  gs.relayTick();

  const state = relayState();
  assert.ok(!state.faults.run, "the spell is over");
  assert.equal(Object.keys(state.journal).length, 1, "what happened is not forgotten");
});

test("a marked draft waiting turns the same failure into an email", () => {
  gs.relayTick(); // seeds state, quietly
  assert.equal(sent.length, 0);

  markedDraftPending("draft-42");
  gs.relayTick();

  assert.equal(sent.length, 1, "now something is at stake");
  assert.match(sent[0].subject, /run failed/i);
  assert.match(sent[0].body, /draft-42/, "and the mail names what is waiting");
  assert.match(sent[0].body, /still in your Drafts folder/i);

  const journal = Object.values(relayState().journal);
  assert.ok(journal[0].emailed, "the journal records that this one was reported");
});

test("a draft already reported as failed does not re-arm the alarm", () => {
  gs.relayTick();
  const state = relayState();
  state.seen["d9"] = { messageId: "m9", at: Date.now(), marked: true };
  state.failed["d9"] = { at: Date.now(), draftDate: Date.now() };
  store._relayState = JSON.stringify(state);

  gs.relayTick();

  // It already produced its own email and is waiting on a deliberate retry,
  // not on this run — counting it again would make every later fault loud.
  assert.equal(sent.length, 0, "that draft's email was already sent, once");
});

test("blindness expires: an unrecognised failure is reported after ten minutes", () => {
  failure = UNKNOWN;
  failingFor(11);
  assert.equal(sent.length, 0, "the first ten minutes are quiet");

  gs.relayTick();

  assert.equal(sent.length, 1, "past the window, 'nothing is waiting' is no longer a fact");
  assert.match(sent[0].body, /failing for 1[12] minutes/i, "and it says how long");
});

test("a refusal Gmail is known to retract gets the longer rope", () => {
  failingFor(11);
  gs.relayTick();
  assert.equal(sent.length, 0, "eleven minutes of this is normal Gmail weather");

  failingFor(31);
  gs.relayTick();
  assert.equal(sent.length, 1, "half an hour of it is not");
});

test("the daily quota is reported on sight, waiting drafts or not", () => {
  failure = QUOTA;

  gs.relayTick();

  // Item 18's condition lasts hours, so every draft marked during it is
  // affected — "wait and see whether anything is pending" is exactly wrong.
  assert.equal(sent.length, 1, "reported immediately");
  assert.ok(relayState().pauses.gmail, "and Gmail work is suspended as before");
});

test("with no state to reason from, it always reports", () => {
  // The policy needs the state bundle to know what was pending; without one,
  // an unreported failure is far worse than a noisy one.
  const verdict = gs.shouldReportRunFailure(new Error(TRANSIENT), 0, null);
  assert.equal(verdict.report, true);
});

test("the journal cannot grow without bound", () => {
  for (let i = 0; i < gs.FAULT_JOURNAL_MAX + 5; i++) {
    failure = `distinct failure ${String.fromCharCode(97 + i)}`;
    gs.relayTick();
  }

  const journal = relayState().journal;
  // The bundle is capped at ~9 KB and holds the never-duplicate guarantee; a
  // diagnostic must never be what evicts it.
  assert.equal(Object.keys(journal).length, gs.FAULT_JOURNAL_MAX, "the oldest are dropped");
  assert.ok(
    Object.values(journal).some((e) => /failure o/.test(e.message)),
    "and the most recent survive"
  );
});

test("ids and counts inside a message do not mint a fault per occurrence", () => {
  const a = new Error("could not read draft r-8814f3ac21 after 3 attempts");
  const b = new Error("could not read draft r-77b0e1de55 after 9 attempts");

  assert.equal(gs.faultFingerprint(a), gs.faultFingerprint(b), "the same failure, twice");
  assert.equal(gs.faultSlug(a), gs.faultSlug(b), "and one CloudWatch metric, not two");
  assert.match(gs.faultSlug(a), /^[a-z-]+$/, "the slug is a safe dimension value");
});
