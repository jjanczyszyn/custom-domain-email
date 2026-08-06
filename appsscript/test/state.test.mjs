import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

const gs = loadGs("state.gs");

/** A stand-in for PropertiesService that records every write. */
function fakeProps(initial = {}) {
  const store = { ...initial };
  const writes = [];
  return {
    store,
    writes,
    setProperty(key, value) {
      store[key] = value;
      writes.push(value);
    },
  };
}

test("loadState: an absent bundle yields empty buckets", () => {
  const state = gs.loadState({});
  assert.deepEqual(state, { inflight: {}, consumed: {}, failed: {} });
});

test("loadState: a corrupt bundle does not throw", () => {
  const state = gs.loadState({ _relayState: "{not json" });
  assert.deepEqual(state, { inflight: {}, consumed: {}, failed: {} });
});

test("saveState: skips the write when nothing changed", () => {
  const props = fakeProps();
  const state = gs.loadState({});
  assert.equal(gs.saveState(props, state), false, "idle tick must not write");
  assert.equal(props.writes.length, 0);
});

/**
 * The regression that produced "a send was interrupted" after every successful
 * send.
 *
 * A send persists an in-flight entry BEFORE the network call so a crash is
 * detectable, then removes it after. The tick therefore ends with state equal
 * to how it started — but the property holds the intermediate write, and it
 * must be corrected. Comparing against the load-time value concluded "nothing
 * changed" and skipped that correction, stranding the entry for the next run
 * to report as an unconfirmed send.
 */
test("saveState: a mid-tick write that is later reverted is still corrected", () => {
  const props = fakeProps();
  const state = gs.loadState({});

  // Before the network call.
  state.inflight["draft-1"] = { messageId: "<m@x>", at: 1 };
  state.consumed["draft-1"] = { at: 1 };
  assert.equal(gs.saveState(props, state), true, "the in-flight entry must persist");
  assert.match(props.store._relayState, /draft-1/);

  // After a successful send.
  delete state.inflight["draft-1"];
  delete state.consumed["draft-1"];
  assert.equal(gs.saveState(props, state), true, "the removal must persist too");

  assert.doesNotMatch(
    props.store._relayState,
    /draft-1/,
    "a stranded entry here is reported as an unconfirmed send on the next run"
  );
  assert.equal(props.writes.length, 2);
});

test("saveState: consecutive identical saves write once", () => {
  const props = fakeProps();
  const state = gs.loadState({});
  state.failed["d"] = { at: 1 };
  gs.saveState(props, state);
  gs.saveState(props, state);
  assert.equal(props.writes.length, 1);
});

test("loadState: reloading resets the dirty tracker to what is stored", () => {
  const props = fakeProps();
  const first = gs.loadState({});
  first.consumed["d"] = { at: 1 };
  gs.saveState(props, first);

  // A later run loads what was written; saving it back changes nothing.
  const second = gs.loadState(props.store);
  assert.equal(gs.saveState(props, second), false);
  assert.equal(props.writes.length, 1);
});

test("pruneState: drops entries past the TTL, keeps fresh ones", () => {
  const state = gs.loadState({});
  const now = Date.now();
  state.consumed["old"] = { at: now - gs.STATE_TTL_MS - 1000 };
  state.consumed["new"] = { at: now };
  state.failed["undated"] = {};
  gs.pruneState(state);
  assert.deepEqual(Object.keys(state.consumed), ["new"]);
  assert.deepEqual(Object.keys(state.failed), [], "an entry with no timestamp cannot age out");
});
