import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredits, addCredits, deductCredits, transferCredits, checkCreditAvailable, estimateCost } from "../dist/credits.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-credits-test-"));
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

test("initializes default credits for configured agents", () => {
  const dir = project();
  const state = loadCredits(dir, { agents: ["claude", "antigravity"] });
  assert.equal(state.enabled, true);
  assert.equal(state.defaultBalance, 100.0);
  assert.equal(state.accounts.claude.balance, 100.0);
  assert.equal(state.accounts.antigravity.balance, 100.0);
});

test("deducts credits on task and records transactions", () => {
  const dir = project();
  const res = deductCredits(dir, "antigravity", 0.05, "task", "TASK-001", "Worked on feature");
  assert.equal(res.ok, true);
  assert.equal(res.balance, 99.95);

  const state = loadCredits(dir);
  assert.equal(state.accounts.antigravity.balance, 99.95);
  assert.equal(state.accounts.antigravity.spent, 0.05);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].refId, "TASK-001");
  assert.equal(state.transactions[0].agent, "antigravity");
});

test("enforces limits when enforceLimits is true", () => {
  const dir = project();
  const config = { credits: { enabled: true, defaultBalance: 1.0, enforceLimits: true } };
  deductCredits(dir, "claude", 0.8, "task", "TASK-001", "Initial task", config);
  
  const check = checkCreditAvailable(dir, "claude", 0.5, config);
  assert.equal(check.ok, false);
  assert.match(check.reason, /insufficient credits/i);

  const failedDeduct = deductCredits(dir, "claude", 0.5, "task", "TASK-002", "Second task", config);
  assert.equal(failedDeduct.ok, false);
  assert.match(failedDeduct.error, /insufficient credits/i);
});

test("transfers credits between agents", () => {
  const dir = project();
  const result = transferCredits(dir, "antigravity", "claude", 10.0, "Consultation fee");
  assert.equal(result.ok, true);
  assert.equal(result.fromBalance, 90.0);
  assert.equal(result.toBalance, 110.0);

  const state = loadCredits(dir);
  assert.equal(state.transactions.length, 2);
  assert.equal(state.accounts.antigravity.balance, 90.0);
  assert.equal(state.accounts.claude.balance, 110.0);
});

test("estimates cost by duration and fallback rate", () => {
  assert.equal(estimateCost(5000, 0.04), 0.04);
  assert.equal(estimateCost(2000, undefined, 0.001), 0.002);
});

test("CLI: coordo credit status, add, and transfer commands", () => {
  const dir = project();
  const initial = runCli(dir, ["credit", "status"]);
  assert.equal(initial.status, 0);
  assert.match(initial.output, /Coordo Agent Credits/);

  const add = runCli(dir, ["credit", "add", "antigravity", "25.50", "--note", "Bonus"]);
  assert.equal(add.status, 0);
  assert.match(add.output, /Added 25.50 credits to 'antigravity'/);

  const transfer = runCli(dir, ["credit", "transfer", "antigravity", "claude", "10.00"]);
  assert.equal(transfer.status, 0);
  assert.match(transfer.output, /Transferred 10.00 credits from 'antigravity'/);

  const hist = runCli(dir, ["credit", "history"]);
  assert.equal(hist.status, 0);
  assert.match(hist.output, /Credit Transactions/);
  assert.match(hist.output, /antigravity/);
});
