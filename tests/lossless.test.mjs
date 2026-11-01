import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function run(dir, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf-8" });
}

test("Git writes refuse unsupported headers instead of silently deleting them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-lossless-"));
  tempDirs.push(dir);
  assert.equal(run(dir, ["init"]).status, 0);
  const ledgerPath = path.join(dir, ".coordo", "ledger.md");
  const before = readFileSync(ledgerPath, "utf-8") + "\n### [TASK-030-ACCESS] status:done from:codex to:claude opened:2026-10-06T00:00Z\nHistorical note\n";
  writeFileSync(ledgerPath, before);

  for (const args of [
    ["task", "add", "new task", "--from", "codex", "--to", "claude"],
    ["task", "done", "TASK-001"],
    ["decision", "add", "question", "--from", "codex", "--to", "claude"]
  ]) {
    const result = run(dir, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to rewrite/);
  }
  assert.equal(readFileSync(ledgerPath, "utf-8"), before);
});
