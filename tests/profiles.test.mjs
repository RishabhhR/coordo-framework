import assert from "node:assert/strict";
import { after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tests for agent profiles: several named agents backed by the same tool, the
// generic `command` and `handoff` adapters, and lead.json validation. The fake
// CLIs record exactly what they were launched with (model flag, prompt), which
// is what distinguishes two profiles that share one adapter.

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const FAKE = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [tool, ...args] = process.argv.slice(2);
const fileArg = args.indexOf("--file");
const prompt = fileArg !== -1 ? readFileSync(args[fileArg + 1], "utf-8") : readFileSync(0, "utf-8");
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : args.includes("-m") ? args[args.indexOf("-m") + 1] : null;
const id = (prompt.match(/YOUR ASSIGNMENT: (TASK-\d+)/) ?? [])[1];
const as = (prompt.match(/^You are (\S+?),/m) ?? [])[1];
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ tool, as, model, id, prompt }) + "\n");
if (id) execFileSync(process.execPath, [process.env.FAKE_COORDO_CLI, "task", "done", id, "--note", "PASS: fake " + tool], { encoding: "utf-8" });
if (tool === "claude") console.log(JSON.stringify({ type: "result", is_error: false, result: "done", total_cost_usd: 0 }));
else if (tool === "codex") writeFileSync(args[args.indexOf("-o") + 1], "done");
`;

function project(lead, plan) {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-profiles-"));
  tempDirs.push(dir);
  const bin = path.join(dir, "fake-bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "fake.mjs"), FAKE);
  const bins = {};
  for (const tool of ["claude", "codex", "mycli"]) {
    const file = path.join(bin, tool);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake.mjs")}" ${tool} "$@"\n`);
    chmodSync(file, 0o755);
    bins[tool] = file;
  }
  run(dir, ["init"]);
  const config = typeof lead === "function" ? lead(bins) : lead;
  writeFileSync(path.join(dir, ".coordo", "lead.json"), JSON.stringify({ commit: false, pollSeconds: 1, ...config }));
  if (plan) writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: plan }));
  return dir;
}

function run(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: path.dirname(cwd),
      COORDO_NO_NOTIFY: "1",
      ANTIGRAVITY_LS_ADDRESS: "",
      FAKE_COORDO_CLI: cli,
      FAKE_CALLS: path.join(cwd, "calls.log"),
      ...env,
    },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const calls = (dir) => {
  const file = path.join(dir, "calls.log");
  return existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const ledger = (dir) => readFileSync(path.join(dir, ".coordo", "ledger.md"), "utf-8");
const header = (dir, id) => ledger(dir).split("\n").find((l) => l.startsWith(`### [${id}]`)) ?? "";

const oneToolTeam = (bins) => ({
  claude: { bin: bins.claude },
  verifier: "reviewer",
  agents: {
    architect: { adapter: "claude", model: "opus", role: "system design and interfaces", instructions: "Never touch test files." },
    builder: { adapter: "claude", model: "sonnet", role: "implementation" },
    reviewer: { adapter: "claude", model: "haiku", role: "review", instructions: "Do not fix code yourself." },
  },
});

test("one tool plays several agents: each profile runs claude with its own model, role and instructions", () => {
  const dir = project(oneToolTeam, [
    { agent: "architect", title: "Design the API", description: "Sketch the module boundaries." },
    { agent: "builder", title: "Implement it", description: "Write the module." },
  ]);
  const { status, output } = run(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);

  const seen = calls(dir);
  assert.deepEqual(seen.map((c) => [c.as, c.model, c.id]), [
    ["architect", "opus", "TASK-001"],
    ["builder", "sonnet", "TASK-002"],
    ["reviewer", "haiku", "TASK-003"],
    ["reviewer", "haiku", "TASK-004"],
  ]);
  assert.ok(seen.every((c) => c.tool === "claude"), "every agent ran through the one claude CLI");

  // Role and instructions reach only the profile that has them.
  assert.match(seen[0].prompt, /Your role on this team: system design and interfaces/);
  assert.match(seen[0].prompt, /STANDING INSTRUCTIONS FOR architect:\nNever touch test files\./);
  assert.doesNotMatch(seen[1].prompt, /STANDING INSTRUCTIONS/);
  assert.match(seen[2].prompt, /Do not fix code yourself\./);

  // Verification is routed to the reviewer profile, not to the literal name "claude".
  assert.match(header(dir, "TASK-001"), /to:architect/);
  assert.match(header(dir, "TASK-003"), /from:lead to:reviewer/);
  assert.match(ledger(dir), /VERIFY TASK-001 \(completed by architect/);
  for (const id of ["TASK-001", "TASK-002", "TASK-003", "TASK-004"]) assert.match(header(dir, id), /status:done/, id);
});

test("the planner may only assign to the configured profiles", () => {
  const dir = project(oneToolTeam);
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ tasks: [{ agent: "claude", title: "t", description: "d" }] }));
  const { status, output } = run(dir, ["plan", "--plan-file", "plan.json"]);
  assert.equal(status, 1);
  assert.match(output, /"claude", which is not an enabled agent \(architect, builder, reviewer\)/);
});

test("a decision addressed to a profile does not pause the lead; one addressed to a person does", () => {
  const dir = project(oneToolTeam);
  run(dir, ["decision", "add", "Which module layout?", "--from", "builder", "--to", "architect"]);
  assert.doesNotMatch(run(dir, ["lead", "--dry-run"]).output, /pause/i);
  run(dir, ["decision", "add", "Approve the budget?", "--from", "builder", "--to", "alice"]);
  assert.match(run(dir, ["lead", "--dry-run"]).output, /would pause on DEC-002 \(to alice\)/);
});

test("the command adapter runs any CLI, passing the prompt by file or by stdin", () => {
  const dir = project(
    (bins) => ({
      verifier: null,
      agents: {
        viafile: { adapter: "command", bin: bins.mycli, args: ["--file", "{promptFile}"], role: "files" },
        viastdin: { adapter: "command", bin: bins.mycli, role: "stdin" },
      },
    }),
    [
      { agent: "viafile", title: "A", description: "first" },
      { agent: "viastdin", title: "B", description: "second" },
    ],
  );
  const { status, output } = run(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir).map((c) => [c.tool, c.as, c.id]), [["mycli", "viafile", "TASK-001"], ["mycli", "viastdin", "TASK-002"]]);
  assert.match(header(dir, "TASK-001"), /status:done/);
  assert.match(header(dir, "TASK-002"), /status:done/);
});

test("the handoff adapter writes the prompt for a human to relay instead of running anything", () => {
  const dir = project({ agents: { tutor: { adapter: "handoff", role: "explains" } }, verifier: null });
  const { status, output } = run(dir, ["dispatch", "tutor", "Explain the module."]);
  assert.equal(status, 3, output); // handed over, no result yet
  assert.match(output, /tutor \(handoff\) pending/);
  assert.match(output, /prompt written to .*\.prompt\.md/);
  assert.deepEqual(calls(dir), []);
});

test("built-in names still work in the object form without an adapter, and the legacy array form is unchanged", () => {
  const dir = project((bins) => ({ agents: { codex: { bin: bins.codex }, claude: { bin: bins.claude } } }), [
    { agent: "codex", title: "A", description: "x" },
  ]);
  const { status, output } = run(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  assert.deepEqual(calls(dir).map((c) => [c.tool, c.id]), [["codex", "TASK-001"], ["claude", "TASK-002"]]);
});

test("a team without claude runs unverified instead of failing to load", () => {
  const dir = project((bins) => ({ agents: { solo: { adapter: "codex", bin: bins.codex } } }), [
    { agent: "solo", title: "A", description: "x" },
  ]);
  const { status, output } = run(dir, ["lead", "--plan-file", "plan.json"]);
  assert.equal(status, 0, output);
  assert.match(output, /No verifier configured/);
  assert.deepEqual(calls(dir).map((c) => c.id), ["TASK-001"]);
});

for (const [name, lead, expected] of [
  ["an unknown adapter", { agents: { x: { adapter: "gpt" } } }, /unknown adapter "gpt"/],
  ["a custom name with no adapter", { agents: { x: { role: "r" } } }, /agent "x" needs an "adapter"/],
  ["the command adapter with no bin", { agents: { x: { adapter: "command" } } }, /"command" adapter, which needs "bin"/],
  ["an uppercase agent name", { agents: { Architect: { adapter: "claude" } } }, /must be lowercase/],
  ["the list form with a custom name (and says how to fix it)", { agents: ["architect"] }, /make "agents" an object/],
  ["a verifier that is not on the team", { agents: { a: { adapter: "claude" } }, verifier: "b" }, /verifier "b" is not in agents \[a\]/],
  ["an empty team", { agents: {} }, /"agents" is empty/],
  ["bad args", { agents: { x: { adapter: "command", bin: "y", args: "nope" } } }, /"args" must be an array of strings/],
]) {
  test(`rejects ${name}`, () => {
    const dir = project(lead);
    const { status, output } = run(dir, ["lead", "--dry-run"]);
    assert.equal(status, 1);
    assert.match(output, expected);
  });
}

test("dispatching to an unknown agent names the agents that exist", () => {
  const dir = project(oneToolTeam);
  const { status, output } = run(dir, ["dispatch", "ghost", "hello"]);
  assert.equal(status, 1);
  assert.match(output, /Unknown agent "ghost"\. Known: architect, builder, reviewer/);
});

const examplesDir = fileURLToPath(new URL("../examples/", import.meta.url));
for (const file of readdirSync(examplesDir).filter((f) => f.endsWith(".json"))) {
  test(`shipped example ${file} is a valid lead.json`, () => {
    const dir = project({});
    writeFileSync(path.join(dir, ".coordo", "lead.json"), readFileSync(path.join(examplesDir, file)));
    run(dir, ["task", "add", "Anything", "--from", "you", "--to", "nobody"]);
    const { status, output } = run(dir, ["lead", "--dry-run"]);
    assert.equal(status, 0, output);
  });
}
