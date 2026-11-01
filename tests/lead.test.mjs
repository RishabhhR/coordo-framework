import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end tests for coordo lead/plan/dispatch. Real agents are replaced by
// fake-agent.mjs, which behaves like a well-behaved worker: it reads its
// prompt, does "the work" by calling the real coordo CLI on the ledger, and
// exits. Keywords in a task body steer it into the failure paths.

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
  if (agent === "claude") console.log(JSON.stringify({ type: "result", is_error: false, result: message, total_cost_usd: 0.01 }));
  else if (agent === "codex") writeFileSync(args[args.indexOf("-o") + 1], message);
  else console.log(JSON.stringify({ conversationId: "fake" }));
  process.exit(0);
};

if (prompt.includes("You are the PLANNER")) {
  appendFileSync(process.env.FAKE_CALLS, "claude PLANNER\n");
  finish(process.env.FAKE_PLAN);
}

const id = (prompt.match(/YOUR ASSIGNMENT: (TASK-\d+)/) ?? [])[1];
appendFileSync(process.env.FAKE_CALLS, agent + " " + (id ?? "raw") + "\n");
if (!id) finish("raw prompt handled");

if (prompt.includes("NEVER_CLOSE")) finish("I could not finish this.");
if (prompt.includes("ASK_HUMAN")) {
  coordo("decision", "add", "Redis or in-memory LRU?", "--from", agent, "--to", "human");
  finish("Blocked on a human decision.");
}
const verified = (prompt.match(/VERIFY (TASK-\d+)/) ?? [])[1];
if (verified) {
  const marker = process.env.FAKE_CALLS + ".defect-filed";
  if (process.env.FAKE_VERIFY_FAIL_ONCE && !existsSync(marker)) {
    writeFileSync(marker, "");
    const author = prompt.match(/completed by (\w+)/)[1];
    coordo("task", "add", "DEFECT in " + verified + ": off-by-one in the schema", "--from", agent, "--to", author);
    coordo("task", "done", id, "--note", "FAIL: filed a DEFECT");
    finish("FAIL");
  }
  coordo("task", "done", id, "--note", "PASS: fake verification");
  finish("PASS");
}
writeFileSync("work-" + id + ".txt", agent + "\n");
coordo("task", "done", id, "--note", "fake " + agent + " did the work");
finish("done");
`;

// Tests that commit need a working git; on macOS /usr/bin/git can be broken
// (e.g. Xcode license not accepted), so those skip rather than fail.
const gitWorks = spawnSync("git", ["--version"]).status === 0;
const needsGit = { skip: !gitWorks && "no working git on PATH" };

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function project({ config = {}, plan, repo = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-lead-"));
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
  runCli(dir, ["init"]);
  const lead = {
    commit: repo,
    claude: { bin: bins.claude },
    codex: { bin: bins.codex },
    antigravity: { bin: bins.antigravity, pollSeconds: 1 },
    ...config,
  };
  writeFileSync(path.join(dir, ".coordo", "lead.json"), JSON.stringify(lead));
  if (plan) writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: plan }));
  if (repo) {
    writeFileSync(path.join(dir, ".gitignore"), "fake-bin/\ncalls.log*\n.coordo/state.json\n");
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  }
  return dir;
}

function runCli(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Keep git from walking up out of the temp dir into an enclosing repo.
      GIT_CEILING_DIRECTORIES: path.dirname(cwd),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
      COORDO_NO_NOTIFY: "1",
      ANTIGRAVITY_LS_ADDRESS: "",
      FAKE_COORDO_CLI: cli,
      FAKE_CALLS: path.join(cwd, "calls.log"),
      ...env,
    },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const calls = (dir) => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf-8").trim().split("\n") : []);
const ledger = (dir) => readFileSync(path.join(dir, ".coordo", "ledger.md"), "utf-8");
const header = (dir, id) => ledger(dir).split("\n").find((l) => l.startsWith(`### [${id}]`)) ?? "";

test("runs a planned goal to completion and verifies every non-verifier task", () => {
  const dir = project({
    plan: [
      { agent: "codex", title: "Define the schema", description: "Add schema.ts." },
      { agent: "antigravity", title: "Build the feature", description: "Use the schema." },
    ],
  });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir), ["codex TASK-001", "antigravity TASK-002", "claude TASK-003", "claude TASK-004"]);
  for (const id of ["TASK-001", "TASK-002", "TASK-003", "TASK-004"]) assert.match(header(dir, id), /status:done/, id);
  assert.match(header(dir, "TASK-001"), /from:lead to:codex/);
  assert.match(header(dir, "TASK-003"), /from:lead to:claude/);
  assert.match(ledger(dir), /VERIFY TASK-001 \(completed by codex/);
  assert.match(ledger(dir), /VERIFY TASK-002 \(completed by antigravity/);
  assert.match(output, /coordo lead: complete/);
  const runs = readdirSync(path.join(dir, ".coordo", "runs"));
  assert.ok(runs.some((f) => f.endsWith(".run.json")), "writes a run record");
  assert.equal(readFileSync(path.join(dir, ".coordo", "runs", ".gitignore"), "utf-8"), "*\n");
});

test("self-heals: a failed verification sends a DEFECT back to the author, then re-verifies the fix", () => {
  const dir = project({ plan: [{ agent: "codex", title: "Define the schema", description: "Add schema.ts." }] });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"], { FAKE_VERIFY_FAIL_ONCE: "1" });
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir), ["codex TASK-001", "claude TASK-002", "codex TASK-003", "claude TASK-004"]);
  assert.match(header(dir, "TASK-003"), /from:claude to:codex/);
  assert.match(ledger(dir), /DEFECT in TASK-001/);
  assert.match(ledger(dir), /VERIFY TASK-003 \(completed by codex/);
  for (const id of ["TASK-001", "TASK-002", "TASK-003", "TASK-004"]) assert.match(header(dir, id), /status:done/, id);
});

test("pauses with exit 3 when an agent raises a decision for a human", () => {
  const dir = project({ plan: [{ agent: "codex", title: "Pick a cache", description: "ASK_HUMAN about caching." }] });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 3, output);
  assert.match(output, /Paused: DEC-001 \(to human\)/);
  assert.match(header(dir, "TASK-001"), /status:open/);
  assert.deepEqual(calls(dir), ["codex TASK-001"]);
});

test("gives up with exit 4 once a task has used all its attempts", () => {
  const dir = project({ plan: [{ agent: "claude", title: "Impossible", description: "NEVER_CLOSE this." }] });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 4, output);
  assert.deepEqual(calls(dir), ["claude TASK-001", "claude TASK-001"]);
  assert.match(output, /used its 2 attempts: TASK-001/);
});

test("stops at --max-steps with exit 4 and leaves the rest open", () => {
  const dir = project({
    plan: [
      { agent: "codex", title: "One", description: "a" },
      { agent: "codex", title: "Two", description: "b" },
    ],
  });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json", "--max-steps", "1"]);
  assert.equal(status, 4, output);
  assert.deepEqual(calls(dir), ["codex TASK-001"]);
  assert.match(output, /Reached --max-steps 1/);
});

test("without a goal it drives open agent tasks and leaves human-addressed tasks alone", () => {
  const dir = project({ config: { verifier: null } });
  runCli(dir, ["task", "add", "Write the parser", "--from", "alice", "--to", "codex"]);
  runCli(dir, ["task", "add", "Approve the budget", "--from", "claude", "--to", "alice"]);
  const { status, output } = runCli(dir, ["lead"]);
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir), ["codex TASK-001"]);
  assert.match(header(dir, "TASK-002"), /status:open .*to:alice/);
});

test("goal mode leaves tasks that existed before the run alone", () => {
  const dir = project();
  runCli(dir, ["task", "add", "Someone else's task", "--from", "alice", "--to", "codex"]);
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: [{ agent: "claude", title: "Mine", description: "x" }] }));
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir), ["claude TASK-002"]);
  assert.match(header(dir, "TASK-001"), /status:open/);
});

test("--dry-run writes nothing and runs no agent, even with the goal after the flag", () => {
  const dir = project();
  runCli(dir, ["task", "add", "Write the parser", "--from", "alice", "--to", "codex"]);
  const before = ledger(dir);
  const noGoal = runCli(dir, ["lead", "--dry-run"]);
  assert.equal(noGoal.status, 0, noGoal.output);
  assert.match(noGoal.output, /TASK-001 → codex: Write the parser\n(?:\s+(?:routed|routing fallback:) [^\n]+\n)?\s+via .*fake-bin\/codex exec --cd/);

  const plan = JSON.stringify({ tasks: [{ agent: "codex", title: "Planned", description: "p" }] });
  const withGoal = runCli(dir, ["lead", "--dry-run", "Build it"], { FAKE_PLAN: plan });
  assert.equal(withGoal.status, 0, withGoal.output);
  assert.match(withGoal.output, /Planning: Build it\n\s+1\. \[codex\] Planned/);
  assert.equal(ledger(dir), before);
  assert.deepEqual(calls(dir), ["claude PLANNER"]);
});

test("plan asks the planner agent and accepts a fenced JSON reply", () => {
  const dir = project();
  const reply = "Here is the plan:\n```json\n" + JSON.stringify({ tasks: [
    { agent: "Codex", title: "Schema", description: "Add schema.ts; tests pass." },
    { agent: "claude", title: "Tests", description: "Cover schema.ts." },
  ] }) + "\n```";
  const { status, output } = runCli(dir, ["plan", "Add a schema"], { FAKE_PLAN: reply });
  assert.equal(status, 0, output);
  assert.match(header(dir, "TASK-001"), /from:lead to:codex/);
  assert.match(header(dir, "TASK-002"), /from:lead to:claude/);
  assert.match(ledger(dir), /planned by coordo-lead run manual for goal: Add a schema/);
});

test("plan rejects a task assigned to an agent that is not enabled", () => {
  const dir = project({ config: { agents: ["claude", "codex"] } });
  const reply = JSON.stringify({ tasks: [{ agent: "antigravity", title: "UI", description: "Build it." }] });
  const { status, output } = runCli(dir, ["plan", "Build a UI"], { FAKE_PLAN: reply });
  assert.equal(status, 1);
  assert.match(output, /assigned to "antigravity", which is not an enabled agent/);
  assert.doesNotMatch(ledger(dir), /TASK-001/);
});

test("a planner question becomes a human decision and pauses the run", () => {
  const dir = project();
  const reply = JSON.stringify({ tasks: [], question: "Which auth provider?" });
  const { status, output } = runCli(dir, ["lead", "Add auth"], { FAKE_PLAN: reply });
  assert.equal(status, 3, output);
  assert.match(header(dir, "DEC-001"), /status:open from:lead to:human/);
  assert.match(ledger(dir), /Which auth provider\?/);
});

test("dispatch hands off to a human when an agent has no headless CLI", () => {
  const dir = project({ config: { antigravity: { bin: null } } });
  const { status, output } = runCli(dir, ["dispatch", "antigravity", "Refactor the router"]);
  assert.equal(status, 3, output); // handed over, no result yet
  assert.match(output, /no headless CLI here/);
  assert.match(output, /pending/);
  assert.doesNotMatch(output, /finished/);
  const prompts = readdirSync(path.join(dir, ".coordo", "runs")).filter((f) => f.endsWith(".prompt.md"));
  assert.equal(prompts.length, 1);
  assert.match(readFileSync(path.join(dir, ".coordo", "runs", prompts[0]), "utf-8"), /Refactor the router/);
});

test("commits the plan and each closed task's work itself, since agents may not be able to", needsGit, () => {
  const dir = project({ repo: true, plan: [{ agent: "codex", title: "Define the schema", description: "Add schema.ts." }] });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  const subjects = git(dir, "log", "--format=%s").trim().split("\n");
  assert.deepEqual(subjects, [
    "TASK-002: VERIFY TASK-001 (completed by codex; filed by coordo-lead)",
    "TASK-001: Define the schema",
    "coordo-lead: plan TASK-001 (run " + subjects[2].match(/run (\w+)\)/)[1] + ")",
    "init",
  ]);
  assert.deepEqual(git(dir, "show", "--name-only", "--format=", "HEAD~1").trim().split("\n").sort(), [".coordo/ledger.md", "work-TASK-001.txt"]);
  assert.equal(git(dir, "status", "--porcelain"), "", "leaves a clean tree");
  assert.match(readFileSync(path.join(dir, ".coordo", "runs", readdirSync(path.join(dir, ".coordo", "runs")).find((f) => f.endsWith("-codex-TASK-001.log"))), "utf-8"), /Do not commit: coordo-lead commits your changes under TASK-001/);
});

test("refuses to start when unrelated uncommitted changes would be swept into a task commit", needsGit, () => {
  const dir = project({ repo: true, plan: [{ agent: "codex", title: "Schema", description: "x" }] });
  writeFileSync(path.join(dir, "notes.txt"), "my own edit\n");
  const refused = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /Uncommitted changes would be swept.*\n.*notes\.txt/);
  assert.deepEqual(calls(dir), []);

  const allowed = runCli(dir, ["lead", "--allow-dirty", "--plan-file", "plan.json"]);
  assert.equal(allowed.status, 0, allowed.output);
});

test("refuses to start when it should commit but git is unusable", () => {
  const dir = project({ config: { commit: true }, plan: [{ agent: "codex", title: "Schema", description: "x" }] });
  const { status, output } = runCli(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 1);
  assert.match(output, /git is not usable here: .*\n.*"commit": false/);
  assert.deepEqual(calls(dir), []);
});

test("dispatch runs one agent on one ledger task", () => {
  const dir = project();
  runCli(dir, ["task", "add", "Write the parser", "--from", "alice", "--to", "codex"]);
  const { status, output } = runCli(dir, ["dispatch", "claude", "TASK-001"]);
  assert.equal(status, 0, output);
  assert.match(output, /claude \(headless\) finished, \$0\.01/);
  assert.match(header(dir, "TASK-001"), /status:done/);
});
