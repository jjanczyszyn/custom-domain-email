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

/** Every declared bucket, empty — asserted against STATE_BUCKETS rather than a
 * hard-coded list, so adding a bucket cannot leave these tests behind. */
const empty = () => Object.fromEntries(gs.STATE_BUCKETS.map((b) => [b, {}]));

test("loadState: an absent bundle yields empty buckets", () => {
  const state = gs.loadState({});
  assert.deepEqual(state, empty());
});

test("loadState: a corrupt bundle does not throw", () => {
  const state = gs.loadState({ _relayState: "{not json" });
  assert.deepEqual(state, empty());
});

/**
 * The footgun the module header warns about: only declared buckets survive a
 * reload. A cache bucket that is not declared is silently dropped, and the
 * thing it gates then fires on every single tick.
 */
test("loadState: every declared bucket survives a round trip", () => {
  const before = gs.emptyState();
  for (const bucket of gs.STATE_BUCKETS) before[bucket]["k"] = { at: 1000 };
  const after = gs.loadState({ _relayState: JSON.stringify(before) });
  assert.deepEqual(after, before);
});

test("dueAgain: true once, then false inside the window, true after it", () => {
  const state = gs.emptyState();
  assert.equal(gs.dueAgain(state, "sweeps", "full", 1000, 5000), true);
  assert.equal(gs.dueAgain(state, "sweeps", "full", 1000, 5500), false);
  assert.equal(gs.dueAgain(state, "sweeps", "full", 1000, 6000), true);
});

/** The cache buckets must expire sooner than the guarantee buckets: `consumed`
 * is the never-duplicate marker and must not be evicted to make room. */
test("pruneState: caches expire on their own shorter TTL", () => {
  const now = Date.now();
  const state = gs.emptyState();
  const age = now - (gs.CACHE_TTL_MS + 60_000); // past the cache TTL, inside the state TTL
  state.consumed["a"] = { at: age };
  state.seen["a"] = { at: age, messageId: "m1" };
  state.notices["gmail-quota"] = { at: age };

  gs.pruneState(state);

  assert.ok(state.consumed["a"], "consumed must outlive the cache TTL");
  assert.equal(state.seen["a"], undefined, "seen is a cache and must expire");
  assert.equal(state.notices["gmail-quota"], undefined, "notices is a cache and must expire");
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
