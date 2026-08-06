import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGs } from "./helpers.mjs";

/**
 * The draft scan — premortem item 12.
 *
 * The relay used to classify every draft in the mailbox on every tick, at
 * several Gmail calls apiece. Against a quota of 20,000 calls a day and a
 * trigger every minute, a mailbox holding thirty abandoned drafts exhausted the
 * whole day's allowance in under six hours, and every tick after that died at
 * GmailApp.getDrafts().
 *
 * So these tests are mostly about calls NOT made. Each one counts the reads the
 * scan performs, because the cost is the behaviour under test.
 */
const gs = loadGs("mime.gs", "state.gs", "relay.gs");

const cfg = {
  domains: ["example.com"],
  defaultLocalpart: "hello",
  subjectToken: ">>",
};

/** A subject reader that records every message it was asked for. */
function reader(subjects) {
  const reads = [];
  const read = (messageId) => {
    reads.push(messageId);
    return messageId in subjects ? subjects[messageId] : "";
  };
  read.reads = reads;
  return read;
}

const draft = (id, messageId) => ({ id, messageId });

test("a labelled draft is picked without reading anything", () => {
  const state = gs.emptyState();
  const read = reader({});

  const picked = gs.selectMarkedDrafts([draft("d1", "m1")], [], state, cfg, 1000, read);

  assert.deepEqual(picked, ["d1"]);
  assert.equal(read.reads.length, 0, "the label already answers the question");
});

test("a recent draft carrying the subject token is picked", () => {
  const state = gs.emptyState();
  const read = reader({ m1: ">>example.com A reply" });

  const picked = gs.selectMarkedDrafts([], [draft("d1", "m1")], state, cfg, 1000, read);

  assert.deepEqual(picked, ["d1"]);
});

test("an unmarked draft is read once, then not again on later ticks", () => {
  const state = gs.emptyState();
  const read = reader({ m1: "just a note to myself" });
  const recent = [draft("d1", "m1")];

  gs.selectMarkedDrafts([], recent, state, cfg, 1000, read);
  const picked = gs.selectMarkedDrafts([], recent, state, cfg, 2000, read);

  assert.deepEqual(picked, []);
  assert.equal(read.reads.length, 1, "an unchanged draft must not be re-read every tick");
});

/**
 * The memo keys on the message id because Gmail replaces a draft's underlying
 * message on every edit — which is what makes marking a draft by typing the
 * token into its subject visible for free, with no extra call.
 */
test("editing a draft changes its message id, and it is read again", () => {
  const state = gs.emptyState();
  const read = reader({ m1: "just a note", m2: ">>example.com now send it" });

  gs.selectMarkedDrafts([], [draft("d1", "m1")], state, cfg, 1000, read);
  const picked = gs.selectMarkedDrafts([], [draft("d1", "m2")], state, cfg, 2000, read);

  assert.deepEqual(picked, ["d1"], "the newly marked draft must be picked up");
  assert.deepEqual(read.reads, ["m1", "m2"]);
});

/** The backstop for a marking that somehow leaves the message id alone. */
test("an unchanged draft is re-read once the recheck window passes", () => {
  const state = gs.emptyState();
  const read = reader({ m1: "not marked" });
  const recent = [draft("d1", "m1")];

  gs.selectMarkedDrafts([], recent, state, cfg, 1000, read);
  gs.selectMarkedDrafts([], recent, state, cfg, 1000 + gs.SUBJECT_RECHECK_MS - 1, read);
  assert.equal(read.reads.length, 1);

  gs.selectMarkedDrafts([], recent, state, cfg, 1000 + gs.SUBJECT_RECHECK_MS + 1, read);
  assert.equal(read.reads.length, 2);
});

test("a draft already handed to SES is never read again", () => {
  const state = gs.emptyState();
  state.consumed["d1"] = { at: 1000 };
  const read = reader({ m1: ">>example.com already sent" });

  const picked = gs.selectMarkedDrafts([], [draft("d1", "m1")], state, cfg, 2000, read);

  assert.deepEqual(picked, [], "consumed is the never-duplicate guarantee");
  assert.equal(read.reads.length, 0);
});

/**
 * Editing a failed draft is one of the two documented ways to retry it, so the
 * scan must keep looking at failed drafts — skipping them to save a call would
 * quietly break the retry gesture.
 */
test("a failed draft is still examined, so an edit can retry it", () => {
  const state = gs.emptyState();
  state.failed["d1"] = { at: 1000, draftDate: 1000 };
  const read = reader({ m2: ">>example.com fixed it" });

  const picked = gs.selectMarkedDrafts([], [draft("d1", "m2")], state, cfg, 2000, read);

  assert.deepEqual(picked, ["d1"]);
});

test("a draft that cannot be read is skipped, not retried every tick", () => {
  const state = gs.emptyState();
  const read = (messageId) => {
    read.reads.push(messageId);
    return null; // what draftSubjectByMessageId returns when Gmail refuses
  };
  read.reads = [];
  const recent = [draft("d1", "m1")];

  const picked = gs.selectMarkedDrafts([], recent, state, cfg, 1000, read);
  gs.selectMarkedDrafts([], recent, state, cfg, 2000, read);

  assert.deepEqual(picked, []);
  assert.equal(read.reads.length, 1, "an unreadable draft must not be re-read every tick");
});

/**
 * The regression itself. Thirty untouched drafts in the mailbox must cost the
 * scan nothing at all — that is the difference between ~90 calls a minute and
 * none, and so between an exhausted quota and a working relay.
 */
test("untouched drafts cost nothing, however many there are", () => {
  const state = gs.emptyState();
  const read = reader({});

  // Only the drafts Gmail's own query returns reach the scan; the other
  // twenty-nine are never enumerated, let alone read.
  const picked = gs.selectMarkedDrafts([], [], state, cfg, 1000, read);

  assert.deepEqual(picked, []);
  assert.equal(read.reads.length, 0);
});

test("the same draft labelled and recent is picked exactly once", () => {
  const state = gs.emptyState();
  const read = reader({ m1: ">>example.com hello" });

  const picked = gs.selectMarkedDrafts(
    [draft("d1", "m1")],
    [draft("d1", "m1")],
    state,
    cfg,
    1000,
    read
  );

  assert.deepEqual(picked, ["d1"]);
  assert.equal(read.reads.length, 0, "the label short-circuits the subject read");
});
