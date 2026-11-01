import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const FAKE_AGENT = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [agent, ...args] = process.argv.slice(2);
const prompt = agent === "antigravity" ? args[args.length - 1] : readFileSync(0, "utf-8");
const coordo = (...a) => execFileSync(process.execPath, [process.env.FAKE_COORDO_CLI, ...a], { encoding: "utf-8" });
const finish = (message) => {
  if (agent === "claude") console.log(JSON.stringify({ type: "result", is_error: false, result: message, total_cost_usd: 0.02 }));
  else if (agent === "codex") writeFileSync(args[args.indexOf("-o") + 1], message);
  else console.log(JSON.stringify({ conversationId: "fake", message }));
  process.exit(0);
};

if (process.env.FAKE_AGENT_CRASH) {
  console.error("fatal: model quota exhausted");
  console.log("fatal: model quota exhausted");
  process.exit(1);
}
if (process.env.FAKE_AGENT_IS_ERROR) {
  console.log(JSON.stringify({ type: "result", is_error: true, result: "API error: overloaded", total_cost_usd: 0.01 }));
  process.exit(0);
}
if (process.env.FAKE_AGENT_BLANK) finish("   ");

if (prompt.includes("QUESTION FROM")) {
  finish("Autonomous consultation: recommend option A due to modularity.");
}

const decId = (prompt.match(/DECISION NEEDED: (DEC-\d+)/) ?? [])[1];
if (decId) {
  coordo("decision", "answer", decId, "Adopt option A", "--by", agent, "--rationale", "Zero runtime overhead and clean boundaries");
  finish("decision resolved");
}

const id = (prompt.match(/YOUR ASSIGNMENT: (TASK-\d+)/) ?? [])[1];
if (id) {
  writeFileSync("work-" + id + ".txt", agent + "\n");
  coordo("task", "done", id, "--note", "fake " + agent + " finished");
  finish("done");
}

finish("generic response from " + agent);
`;

function project(config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-inter-agent-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "fake-bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(path.join(bin, "fake-agent.mjs"), FAKE_AGENT);
  const bins = {};
  for (const agent of ["claude", "codex", "antigravity"]) {
    const file = path.join(bin, agent);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake-agent.mjs")}" ${agent} "$@"\n`);
    chmodSync(file, 0o755);
    bins[agent] = file;
  }
  execFileSync(process.execPath, [cli, "init"], { cwd: dir });
  const lead = {
    commit: false,
    claude: { bin: bins.claude },
    codex: { bin: bins.codex },
    antigravity: { bin: bins.antigravity },
    ...config,
  };
  writeFileSync(path.join(dir, ".coordo", "lead.json"), JSON.stringify(lead));
  return { dir, bins };
}

function runCli(cwd, args, env = {}) {
  try {
    const output = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, FAKE_COORDO_CLI: cli, ...env },
    });
    return { status: 0, output };
  } catch (err) {
    return { status: err.status ?? 1, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

test("coordo invoke allows one agent to headlessly invoke a peer agent", () => {
  const { dir } = project();
  const res = runCli(dir, ["invoke", "claude", "Please check this syntax", "--from", "antigravity"]);
  assert.equal(res.status, 0);
  assert.match(res.output, /Invoking claude \(from antigravity\)/);
  assert.match(res.output, /claude finished/);

  // Check that credits were deducted for antigravity
  const cred = runCli(dir, ["credit", "status"]);
  assert.match(cred.output, /Total Expended Across All Agents/);
});

test("coordo consult allows direct consultation with auto-decide", () => {
  const { dir } = project();
  const res = runCli(dir, ["consult", "claude", "Should we use Redis or memcached?", "--from", "antigravity", "--auto-decide"]);
  assert.equal(res.status, 0);
  assert.match(res.output, /antigravity consulting claude/);
  assert.match(res.output, /Recorded and answered decision DEC-001/);
  assert.match(res.output, /Consultation Response from claude/);

  // Decision ledger has the record
  const show = runCli(dir, ["decision", "show", "DEC-001"]);
  assert.match(show.output, /Status:\s+resolved/);
  assert.match(show.output, /Direct autonomous consultation/);
});

test("coordo lead resolves agent-addressed decisions autonomously without human pause", () => {
  const { dir } = project({ verifier: null });
  // Add a decision addressed from antigravity to claude
  runCli(dir, ["decision", "add", "Which queue library?", "--from", "antigravity", "--to", "claude"]);
  // Add a task for antigravity
  runCli(dir, ["task", "add", "Implement the queue worker", "--from", "claude", "--to", "antigravity"]);

  const res = runCli(dir, ["lead"]);
  assert.equal(res.status, 0, res.output);
  assert.match(res.output, /DEC-001 → claude/);
  assert.match(res.output, /DEC-001 resolved by claude/);
  assert.match(res.output, /TASK-001 → antigravity/);
  assert.match(res.output, /TASK-001 closed by antigravity/);
  assert.doesNotMatch(res.output, /Paused:.*needs a human answer/);
});

test("coordo lead pauses if credit limit is exhausted with enforceLimits", () => {
  const { dir } = project({
    verifier: null,
    credits: {
      enabled: true,
      defaultBalance: 0.0001,
      enforceLimits: true,
      costPerSecondEstimate: 0.1,
    },
  });

  // Exhaust credits for antigravity first
  runCli(dir, ["credit", "transfer", "antigravity", "claude", "0.0001"]);
  runCli(dir, ["task", "add", "Task that requires credits", "--from", "claude", "--to", "antigravity"]);

  const res = runCli(dir, ["lead"]);
  assert.equal(res.status, 3, res.output); // exit code 3 is paused
  assert.match(res.output, /exhausted its credit balance/);
});

// ---- A peer call only counts as an answer if an agent actually produced one (TASK-057). ----
const NO_CONNECTOR = { ANTIGRAVITY_LS_ADDRESS: undefined, COORDO_NO_NOTIFY: "1" };
const unconnected = () => project({ antigravity: { bin: null } }).dir;
const decisions = (dir) => runCli(dir, ["decision", "list", "--status", "all"]).output;
const spent = (dir) => runCli(dir, ["credit", "status"]).output;

test("invoke with no connector reports pending, not success, and charges nothing", () => {
  const dir = unconnected();
  const before = spent(dir);
  const res = runCli(dir, ["invoke", "antigravity", "audit-only probe", "--from", "codex"], NO_CONNECTOR);
  assert.equal(res.status, 3, res.output);
  assert.match(res.output, /pending/);
  assert.doesNotMatch(res.output, /finished|✅/);
  assert.equal(spent(dir), before);
});

test("consult --auto-decide with no connector records no decision", () => {
  const dir = unconnected();
  const res = runCli(dir, ["consult", "antigravity", "audit-only question", "--from", "codex", "--auto-decide"], NO_CONNECTOR);
  assert.equal(res.status, 3, res.output);
  assert.match(res.output, /has not answered/);
  assert.match(res.output, /No decision was recorded/);
  assert.doesNotMatch(res.output, /Recorded and answered|Consultation Response/);
  assert.doesNotMatch(decisions(dir), /DEC-001/);
  assert.doesNotMatch(readFileSync(path.join(dir, ".coordo", "ledger.md"), "utf-8"), /prompt written to/);
});

test("consult without --auto-decide and no connector also reports pending", () => {
  const dir = unconnected();
  const res = runCli(dir, ["consult", "antigravity", "audit-only question", "--from", "codex"], NO_CONNECTOR);
  assert.equal(res.status, 3, res.output);
  assert.doesNotMatch(res.output, /Consultation Response/);
  assert.doesNotMatch(res.output, /No decision was recorded/);
});

test("dispatch with no connector reports pending", () => {
  const dir = unconnected();
  const res = runCli(dir, ["dispatch", "antigravity", "audit-only probe"], NO_CONNECTOR);
  assert.equal(res.status, 3, res.output);
  assert.match(res.output, /pending/);
  assert.doesNotMatch(res.output, /finished|✅/);
});

test("starting an Antigravity conversation is not an answer", () => {
  const { dir } = project(); // a connector exists, but agentapi only starts the conversation
  const res = runCli(dir, ["consult", "antigravity", "Which queue?", "--from", "codex", "--auto-decide"], { COORDO_NO_NOTIFY: "1" });
  assert.equal(res.status, 3, res.output);
  assert.match(res.output, /conversation started, no result yet/);
  assert.doesNotMatch(decisions(dir), /DEC-001/);
  const invoked = runCli(dir, ["invoke", "antigravity", "Do the thing", "--from", "codex"], { COORDO_NO_NOTIFY: "1" });
  assert.equal(invoked.status, 3, invoked.output);
  assert.doesNotMatch(invoked.output, /finished|✅/);
});

for (const [agent, label] of [["claude", "claude"], ["codex", "codex"]]) {
  test(`a crashed ${label} CLI fails consult --auto-decide and records no decision`, () => {
    const { dir } = project();
    const res = runCli(dir, ["consult", agent, "Redis or memcached?", "--from", "antigravity", "--auto-decide"], { FAKE_AGENT_CRASH: "1" });
    assert.equal(res.status, 1, res.output);
    assert.match(res.output, /Consultation with .* failed/);
    assert.match(res.output, /No decision was recorded/);
    assert.doesNotMatch(res.output, /Recorded and answered|Consultation Response/);
    assert.doesNotMatch(decisions(dir), /DEC-001/);
  });
}

test("an error result from a CLI that exited 0 is still a failure", () => {
  const { dir } = project();
  const res = runCli(dir, ["consult", "claude", "Redis or memcached?", "--from", "antigravity", "--auto-decide"], { FAKE_AGENT_IS_ERROR: "1" });
  assert.equal(res.status, 1, res.output);
  assert.doesNotMatch(decisions(dir), /DEC-001/);
});

test("an empty answer does not resolve a decision", () => {
  const { dir } = project();
  const res = runCli(dir, ["consult", "claude", "Redis or memcached?", "--from", "antigravity", "--auto-decide"], { FAKE_AGENT_BLANK: "1" });
  assert.equal(res.status, 1, res.output);
  assert.match(res.output, /empty answer/);
  assert.doesNotMatch(decisions(dir), /DEC-001/);
});

test("invoke reports a crashed CLI as failed, not finished", () => {
  const { dir } = project();
  const res = runCli(dir, ["invoke", "claude", "Check this", "--from", "antigravity"], { FAKE_AGENT_CRASH: "1" });
  assert.equal(res.status, 1, res.output);
  assert.match(res.output, /claude failed/);
  assert.doesNotMatch(res.output, /finished/);
});

test("a real answer still exits 0 and resolves the decision with that answer", () => {
  const { dir } = project();
  const res = runCli(dir, ["consult", "claude", "Redis or memcached?", "--from", "antigravity", "--auto-decide"]);
  assert.equal(res.status, 0, res.output);
  const shown = runCli(dir, ["decision", "show", "DEC-001"]).output;
  assert.match(shown, /Status:\s+resolved/);
  assert.match(shown, /recommend option A/);
});

test("lead still treats a closed ledger entry as success, whatever the adapter", () => {
  const { dir } = project({ verifier: null });
  runCli(dir, ["task", "add", "Implement the worker", "--from", "claude", "--to", "antigravity"]);
  const res = runCli(dir, ["lead"], { COORDO_NO_NOTIFY: "1" });
  assert.equal(res.status, 0, res.output);
  assert.match(res.output, /TASK-001 closed by antigravity/);
});
