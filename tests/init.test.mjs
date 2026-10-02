import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function init(dir) {
  const result = spawnSync(process.execPath, [cli, "init"], { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const read = (dir, file) => readFileSync(path.join(dir, file), "utf-8");

test("init scaffolds the ledger and tool-neutral pointers, keeps existing content, and is idempotent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-init-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "CLAUDE.md"), "# My project rules\n\nBe kind.\n");

  const out = init(dir);
  assert.match(out, /Next: coordo task add/);
  assert.ok(existsSync(path.join(dir, ".coordo", "ledger.md")));
  assert.match(read(dir, ".gitignore"), /\.coordo\/state\.json/);

  const claudeMd = read(dir, "CLAUDE.md");
  assert.match(claudeMd, /^# My project rules\n\nBe kind\./, "existing content is kept");
  assert.match(claudeMd, /You are `claude`/);
  assert.match(claudeMd, /coordo digest --as claude/);

  // AGENTS.md is read by many tools, so it must not hardcode one identity.
  const agentsMd = read(dir, "AGENTS.md");
  assert.match(agentsMd, /Use your own agent name/);
  assert.match(agentsMd, /coordo digest --as <your-agent-name>/);
  assert.doesNotMatch(agentsMd + claudeMd, /Google Antigravity|the user also runs/);

  const before = [read(dir, "CLAUDE.md"), read(dir, "AGENTS.md"), read(dir, ".gitignore"), read(dir, ".coordo/ledger.md")];
  init(dir);
  assert.deepEqual([read(dir, "CLAUDE.md"), read(dir, "AGENTS.md"), read(dir, ".gitignore"), read(dir, ".coordo/ledger.md")], before);
  assert.equal(read(dir, "CLAUDE.md").split("<!-- coordo:start -->").length - 1, 1, "exactly one snippet block");
});

const gitWorks = spawnSync("git", ["--version"]).status === 0;

test("status in a repo with no commits yet explains itself instead of dumping a git error", { skip: !gitWorks && "no working git on PATH" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-nocommit-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  init(dir);
  const result = spawnSync(process.execPath, [cli, "status"], { cwd: dir, encoding: "utf-8", env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No commits yet: checkpoints start once the repo has its first commit\./);
  assert.doesNotMatch(result.stdout, /fatal|ambiguous/);
});
