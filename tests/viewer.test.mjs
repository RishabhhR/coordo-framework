import assert from "node:assert/strict";
import test from "node:test";
import { parseLedger } from "../dist/viewer.js";

test("parses valid decisions and tasks while ignoring malformed neighbors", () => {
  const ledger = `# Coordo Ledger

## Decisions Needed

### [DEC-001] status:open from:claude to:codex opened:2026-08-23T00:00Z
Keep the ledger in Git.

### [not-valid] this must not become an item
Ignore this text.

## Tasks

### [TASK-001] status:open from:claude to:antigravity opened:2026-08-23T00:01Z
Review the viewer.

## Resolved / Log

### [TASK-002] status:done from:codex to:claude opened:2026-08-23T00:02Z
Already done.
`;
  const parsed = parseLedger(ledger);
  assert.equal(parsed.decisions.length, 1);
  assert.equal(parsed.decisions[0].id, "DEC-001");
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.tasks[0].to, "antigravity");
});

test("does not let a malformed header swallow the next valid section", () => {
  const parsed = parseLedger(`## Tasks\n### broken\ntext\n## Decisions Needed\n### [DEC-004] status:open\nA decision.`);
  assert.equal(parsed.tasks.length, 0);
  assert.equal(parsed.decisions[0].summary, "A decision.");
});

test("lists no repositories until COORDO_REPOS names some", async () => {
  const { getConfiguredRepositories } = await import("../dist/viewer.js");
  assert.deepEqual(getConfiguredRepositories(undefined), []);
  assert.deepEqual(getConfiguredRepositories("   "), []);
  assert.deepEqual(getConfiguredRepositories("not a repo!"), []);
  assert.deepEqual(getConfiguredRepositories("acme/api, acme/web").map((r) => `${r.owner}/${r.repo}@${r.branch}`), ["acme/api@main", "acme/web@main"]);
  assert.equal(getConfiguredRepositories('[{"owner":"acme","repo":"api","branch":"dev","label":"API"}]')[0].branch, "dev");
});
