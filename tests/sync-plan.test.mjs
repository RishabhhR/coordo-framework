import test from "node:test";
import assert from "node:assert/strict";
import { describeSyncCollisions, itemFingerprint, planSync } from "../dist/syncPlan.js";

const item = (id, over = {}) => ({ id, status: "done", from: "claude", to: "codex", opened: "2026-10-06T10:00Z", metadata: {}, body: `${id} title\n\nbody`, ...over });

test("entries Mongo already holds are left alone", () => {
  const a = item("TASK-001");
  const plan = planSync([a], [{ ...a }]);
  assert.deepEqual([plan.additions.length, plan.staleCopies.length, plan.collisions.length], [0, 0, 0]);
});

test("an ID Mongo has never seen is a genuine addition, counted once even if the archive repeats it", () => {
  const fresh = item("TASK-090");
  const plan = planSync([item("TASK-001")], [fresh, { ...fresh }]);
  assert.deepEqual(plan.additions.map((x) => x.id), ["TASK-090"]);
});

test("a stale archive copy of a task Mongo already closed is skipped, never re-imported as open", () => {
  // Real case: the archive still says TASK-033 is open, Mongo says it is done.
  const mongo = item("TASK-033", { status: "done", body: "BUG (DATA LOSS)\n\nfixed" });
  const archive = item("TASK-033", { status: "open", body: "BUG (DATA LOSS)\n\nnot fixed yet" });
  const plan = planSync([mongo], [archive]);
  assert.equal(plan.additions.length, 0, "must not resurrect closed work");
  assert.equal(plan.staleCopies.length, 1);
  assert.equal(plan.collisions.length, 0);
});

test("the same ID for a different task is a collision and is never added", () => {
  // Real case: markdown TASK-035 (PR review) vs Mongo TASK-035 (Mongo probe).
  const mongo = item("TASK-035", { from: "antigravity", to: "codex", opened: "2026-10-06T12:00Z", body: "TASK-030 Antigravity Mongo operational probe" });
  const archive = item("TASK-035", { from: "claude", to: "codex", opened: "2026-10-18T00:04Z", body: "REVIEW of PR #4831" });
  const plan = planSync([mongo], [archive]);
  assert.equal(plan.additions.length, 0);
  assert.equal(plan.collisions.length, 1);
  assert.equal(plan.collisions[0].existing.body, mongo.body);
});

test("a request and its reply that share an ID are both fine once both are in Mongo", () => {
  const request = item("TASK-027", { from: "claude", to: "codex" });
  const reply = item("TASK-027", { from: "codex", to: "claude", opened: "2026-10-04T22:57Z", body: "TASK-027 reply" });
  const plan = planSync([request, reply], [request, reply]);
  assert.deepEqual([plan.additions.length, plan.staleCopies.length, plan.collisions.length], [0, 0, 0]);
});

test("a mixed archive is split correctly in one pass", () => {
  const mongo = [item("TASK-001"), item("TASK-002", { status: "done" }), item("TASK-003", { from: "a", to: "b", opened: "2026-01-01T00:00Z" })];
  const archive = [item("TASK-001"), item("TASK-002", { status: "open" }), item("TASK-003"), item("TASK-050")];
  const plan = planSync(mongo, archive);
  assert.deepEqual(plan.additions.map((x) => x.id), ["TASK-050"]);
  assert.deepEqual(plan.staleCopies.map((x) => x.id), ["TASK-002"]);
  assert.deepEqual(plan.collisions.map((x) => x.item.id), ["TASK-003"]);
});

test("fingerprints change with status and body, not with key order", () => {
  assert.notEqual(itemFingerprint(item("TASK-001")), itemFingerprint(item("TASK-001", { status: "open" })));
  assert.notEqual(itemFingerprint(item("TASK-001")), itemFingerprint(item("TASK-001", { body: "other" })));
  assert.equal(itemFingerprint(item("TASK-001")), itemFingerprint({ body: "TASK-001 title\n\nbody", metadata: {}, opened: "2026-10-06T10:00Z", to: "codex", from: "claude", status: "done", id: "TASK-001" }));
});

test("the refusal message names the collision, says nothing was written and points at the docs", () => {
  const one = describeSyncCollisions([{ item: item("TASK-035", { body: "REVIEW of PR" }), existing: item("TASK-035", { body: "Mongo probe" }) }]);
  assert.match(one, /^Refusing to sync: 1 archive entry reuses an ID/);
  assert.match(one, /TASK-035 "REVIEW of PR" vs Mongo TASK-035 "Mongo probe"/);
  assert.match(one, /Nothing was written\.$/);
  assert.match(one, /Archived markdown ledgers/);
  const two = describeSyncCollisions([{ item: item("TASK-035"), existing: item("TASK-035") }, { item: item("TASK-036"), existing: item("TASK-036") }]);
  assert.match(two, /2 archive entries reuse IDs/);
});
