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

function saveState(props, state) {
  props.setProperty(PROP_STATE, JSON.stringify(state));
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
