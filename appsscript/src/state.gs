/**
 * state.gs — the relay's runtime state.
 *
 * Three buckets, each answering a different question about a draft:
 *
 *   consumed — has this already been handed to SES? Blocks a resend. This is
 *              the never-duplicate guarantee (premortem item 1) and is the one
 *              bucket that must survive a crash.
 *   inflight — was a send interrupted before we could confirm it? Present only
 *              between the SES call and the tidy-up that follows it.
 *   failed   — did this fail, and is it therefore waiting for the operator to
 *              retry deliberately? Blocks automatic retry.
 *
 * All three live under ONE property. Script Properties is the same surface that
 * holds your credentials and configuration, so a marker per draft would bury
 * the handful of values you actually edit.
 */

var PROP_STATE = '_relayState';
var STATE_BUCKETS = ['inflight', 'consumed', 'failed'];

/**
 * How long an entry survives.
 *
 * This bounds the never-duplicate guarantee: once a consumed entry expires its
 * draft becomes eligible again, so the window must comfortably exceed the time
 * anyone would plausibly leave a failed draft sitting before dealing with it.
 * A week does that while keeping the bundle small — Script Properties caps a
 * single value at ~9 KB, roughly 80 entries at the size we write.
 */
var STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What we last actually wrote, for the run in progress.
 *
 * saveState is called several times per tick — once before the network call so
 * a crash is detectable, once after. Skipping a redundant write has to compare
 * against what was LAST WRITTEN, not against what was loaded: a send that adds
 * an in-flight entry and then removes it ends the tick equal to its starting
 * value, while the property still holds the intermediate write. Comparing to
 * the load-time value therefore skips the corrective write and strands the
 * entry, which the next run reports as an unconfirmed send. Every successful
 * send did this.
 */
var _lastWrittenState = null;

function emptyState() {
  return { inflight: {}, consumed: {}, failed: {} };
}

/**
 * Read the state bundle from an already-fetched property snapshot, so this
 * costs no additional remote call.
 */
function loadState(snapshot) {
  var state = emptyState();
  var raw = snapshot[PROP_STATE];
  _lastWrittenState = raw || JSON.stringify(state);
  if (!raw) return state;

  try {
    var parsed = JSON.parse(raw);
    for (var i = 0; i < STATE_BUCKETS.length; i++) {
      state[STATE_BUCKETS[i]] = parsed[STATE_BUCKETS[i]] || {};
    }
  } catch (e) {
    // A corrupt bundle must not wedge the relay. Starting empty risks resending
    // a draft that was mid-flight, which is why it is loud rather than silent.
    console.warn('relay state was unreadable; starting from empty');
  }
  return state;
}

/**
 * Persist the state, skipping the write when it would change nothing.
 *
 * The dirty check lives here rather than at the call site because only this
 * function knows what was actually written — see _lastWrittenState.
 */
function saveState(props, state) {
  var json = JSON.stringify(state);
  if (json === _lastWrittenState) return false;
  props.setProperty(PROP_STATE, json);
  _lastWrittenState = json;
  return true;
}

/** Drop entries past the TTL so the bundle cannot grow without bound. */
function pruneState(state) {
  var cutoff = new Date().getTime() - STATE_TTL_MS;
  for (var i = 0; i < STATE_BUCKETS.length; i++) {
    var bucket = state[STATE_BUCKETS[i]];
    for (var id in bucket) {
      if (!bucket.hasOwnProperty(id)) continue;
      var at = bucket[id] && bucket[id].at;
      if (!at || at < cutoff) delete bucket[id];
    }
  }
}

// Exported for the Node test harness; ignored by Apps Script, where `module`
// is undefined and every top-level function is already global.
if (typeof module !== 'undefined') {
  module.exports = Object.assign(module.exports || {}, {
    PROP_STATE: PROP_STATE,
    STATE_BUCKETS: STATE_BUCKETS,
    STATE_TTL_MS: STATE_TTL_MS,
    emptyState: emptyState,
    loadState: loadState,
    saveState: saveState,
    pruneState: pruneState,
  });
}
