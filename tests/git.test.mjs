import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// On macOS /usr/bin/git can itself be broken (e.g. Xcode license not yet
// accepted), so the tests that need a real git skip rather than fail.
const gitWorks = spawnSync("git", ["--version"]).status === 0;
const needsGit = { skip: !gitWorks && "no working git on PATH" };

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf-8",
    // Keep git from walking up out of the temp dir into an enclosing repo.
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd), ...env },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

function withCheckpoint(dir, sha) {
  mkdirSync(path.join(dir, ".coordo"), { recursive: true });
  writeFileSync(path.join(dir, ".coordo", "state.json"), JSON.stringify({ checkpoints: { claude: sha } }));
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function commit(repo, message) {
  git(repo, "-c", "user.name=coordo-test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD").trim();
}

// Stand-in for macOS /usr/bin/git before the Xcode license is accepted.
function xcodeLicenseGitShim() {
  const bin = tempDir("coordo-shim-");
  writeFileSync(path.join(bin, "git"), `#!/bin/sh
echo "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' from within a Terminal window to review and agree to the Xcode and Apple SDKs license." >&2
exit 69
`);
  chmodSync(path.join(bin, "git"), 0o755);
  return bin;
}

test("digest reports a broken git instead of advising a checkpoint reset", () => {
  const project = tempDir("coordo-project-");
  withCheckpoint(project, "2c4757e5d1f0a3b6c9e8d7f6a5b4c3d2e1f0a9b8");
  const shimPath = `${xcodeLicenseGitShim()}${path.delimiter}${process.env.PATH}`;

  const { status, output } = runCli(project, ["digest", "--as", "claude"], { PATH: shimPath });

  assert.notEqual(status, 0);
  assert.match(output, /git is not usable here: You have not agreed to the Xcode license agreements/);
  assert.match(output, /'2c4757e5d1f0a3b6c9e8d7f6a5b4c3d2e1f0a9b8' was not checked and is unchanged/);
  assert.doesNotMatch(output, /not found in Git history/);
  assert.doesNotMatch(output, /coordo checkpoint/);
});

test("digest reports a missing git executable instead of advising a checkpoint reset", () => {
  const project = tempDir("coordo-project-");
  withCheckpoint(project, "2c4757e5d1f0a3b6c9e8d7f6a5b4c3d2e1f0a9b8");

  const { status, output } = runCli(project, ["digest", "--as", "claude"], { PATH: tempDir("coordo-empty-path-") });

  assert.notEqual(status, 0);
  assert.match(output, /git is not usable here: git executable not found on PATH/);
  assert.doesNotMatch(output, /coordo checkpoint/);
});

test("status and checkpoint surface git's own error", () => {
  const project = tempDir("coordo-project-");
  withCheckpoint(project, "2c4757e5d1f0a3b6c9e8d7f6a5b4c3d2e1f0a9b8");
  writeFileSync(path.join(project, ".coordo", "ledger.md"), "# Coordo Ledger\n\n## Decisions Needed\n\n## Tasks\n\n## Resolved / Log\n");
  const shimPath = `${xcodeLicenseGitShim()}${path.delimiter}${process.env.PATH}`;

  const status = runCli(project, ["status"], { PATH: shimPath });
  assert.match(status.output, /Could not fetch Git checkpoints status: Failed to get current Git HEAD: You have not agreed/);

  const checkpoint = runCli(project, ["checkpoint", "--as", "claude"], { PATH: shimPath });
  assert.notEqual(checkpoint.status, 0);
  assert.match(checkpoint.output, /Failed to get current Git HEAD: You have not agreed/);
  assert.doesNotMatch(checkpoint.output, /Is this a Git repository/);
});

test("digest outside a git repository says so instead of blaming the checkpoint", needsGit, () => {
  const project = tempDir("coordo-project-");
  withCheckpoint(project, "2c4757e5d1f0a3b6c9e8d7f6a5b4c3d2e1f0a9b8");

  const { status, output } = runCli(project, ["digest", "--as", "claude"]);

  assert.notEqual(status, 0);
  assert.match(output, /git is not usable here: fatal: not a git repository/);
  assert.doesNotMatch(output, /not found in Git history/);
});

test("digest still reports a checkpoint that is genuinely missing", needsGit, () => {
  const repo = tempDir("coordo-repo-");
  git(repo, "init", "-q");
  commit(repo, "first");

  // Well-formed but absent object: `cat-file -e` exits 1 silently.
  withCheckpoint(repo, "0000000000000000000000000000000000000001");
  let result = runCli(repo, ["digest", "--as", "claude"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /not found in Git history/);

  // Unresolvable name: `cat-file -e` exits 128 "Not a valid object name".
  withCheckpoint(repo, "deadbee");
  result = runCli(repo, ["digest", "--as", "claude"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /not found in Git history/);
});

test("digest lists commits since a valid checkpoint", needsGit, () => {
  const repo = tempDir("coordo-repo-");
  git(repo, "init", "-q");
  withCheckpoint(repo, commit(repo, "reviewed work"));
  commit(repo, "unreviewed work from the other agent");

  const { status, output } = runCli(repo, ["digest", "--as", "claude"]);

  assert.equal(status, 0);
  assert.match(output, /unreviewed work from the other agent/);
  assert.doesNotMatch(output, /\breviewed work/);
});
