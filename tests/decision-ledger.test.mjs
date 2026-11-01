import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { 
  recordDecisionCreated, 
  recordDeliberationTurn, 
  recordDecisionResolved, 
  getDecisionRecord, 
  listDecisionRecords 
} from "../dist/decisionLedger.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-dec-test-"));
  tempDirs.push(dir);
  execFileSync(process.execPath, [cli, "init"], { cwd: dir, encoding: "utf-8" });
  return dir;
}

function runCli(cwd, args) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf-8" });
    return { status: 0, output };
  } catch (err) {
    return { status: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

test("records decisions and deliberation turns", () => {
  const dir = project();
  recordDecisionCreated(dir, {
    id: "DEC-001",
    question: "Which database schema layout?",
    from: "antigravity",
    to: "claude",
    context: "PostgreSQL vs SQLite for local cache",
  });

  recordDeliberationTurn(dir, "DEC-001", {
    speaker: "claude",
    message: "SQLite has zero external daemon overhead and fits embedded local setups.",
    role: "critic",
    creditsUsed: 0.02,
  });

  const rec = getDecisionRecord(dir, "DEC-001");
  assert.equal(rec.status, "deliberating");
  assert.equal(rec.deliberation.length, 1);
  assert.equal(rec.deliberation[0].speaker, "claude");

  recordDecisionResolved(dir, "DEC-001", {
    answer: "Use SQLite for embedded persistence.",
    by: "claude",
    rationale: "Zero daemon requirement, robust ACID, single-file simplicity.",
    optionsConsidered: ["PostgreSQL", "SQLite", "DuckDB"],
    creditsCost: 0.05,
  });

  const resolved = getDecisionRecord(dir, "DEC-001");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolvedBy, "claude");
  assert.equal(resolved.optionsConsidered.length, 3);
  assert.equal(resolved.creditsCost, 0.05);
});

test("CLI: decision answer with rationale and options, show, and log", () => {
  const dir = project();
  const add = runCli(dir, ["decision", "add", "Monorepo or Polyrepo?", "--from", "antigravity", "--to", "architect"]);
  assert.equal(add.status, 0);
  assert.match(add.output, /Allocated DEC-001/);

  const turn = runCli(dir, ["decision", "turn", "DEC-001", "Monorepo simplifies atomic refactoring across packages.", "--from", "architect"]);
  assert.equal(turn.status, 0);

  const ans = runCli(dir, [
    "decision", "answer", "DEC-001", "Adopt pnpm monorepo structure",
    "--by", "architect",
    "--rationale", "Shared tooling, atomic PRs, clean boundary enforcement",
    "--options", "monorepo,polyrepo,git submodules",
    "--credits-cost", "0.03"
  ]);
  assert.equal(ans.status, 0);

  const show = runCli(dir, ["decision", "show", "DEC-001"]);
  assert.equal(show.status, 0);
  assert.match(show.output, /Status:\s+resolved/);
  assert.match(show.output, /Rationale:/);
  assert.match(show.output, /Shared tooling/);
  assert.match(show.output, /Adopt pnpm monorepo structure/);
  assert.match(show.output, /Deliberation Trail:/);

  const log = runCli(dir, ["decision", "log"]);
  assert.equal(log.status, 0);
  assert.match(log.output, /Autonomous Decision-Making Ledger/);
  assert.match(log.output, /DEC-001/);
});
