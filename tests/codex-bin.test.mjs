import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODEX_APP_CANDIDATES, codexNotFoundHint, resolveCodexBin } from "../dist/agents.js";

// ChatGPT.app moved its bundled Codex on 2026-10-03 and coordo silently fell back to a human handoff.
const root = mkdtempSync(path.join(tmpdir(), "coordo-codex-"));
const NEW = path.join(root, "new", "Resources", "codex-cli", "bin", "codex");
const OLD = path.join(root, "old", "Resources", "codex");
const both = [NEW, OLD];
const install = (file, mode = 0o755) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "#!/bin/sh\n"); chmodSync(file, mode); };
const noPath = (fn) => { const saved = process.env.PATH; process.env.PATH = path.join(root, "empty-path"); try { return fn(); } finally { process.env.PATH = saved; } };
const profile = (bin = null) => ({ bin });

test("finds Codex at the new codex-cli/bin layout", () => {
  install(NEW);
  assert.equal(noPath(() => resolveCodexBin(profile(), both)), NEW);
});

test("still finds Codex at the old layout", () => {
  const only = mkdtempSync(path.join(tmpdir(), "coordo-codex-old-"));
  const old = path.join(only, "Resources", "codex"); install(old);
  assert.equal(noPath(() => resolveCodexBin(profile(), [path.join(only, "Resources", "codex-cli", "bin", "codex"), old])), old);
});

test("prefers the newest layout when both exist", () => {
  install(NEW); install(OLD);
  assert.equal(noPath(() => resolveCodexBin(profile(), both)), NEW);
});

test("skips a candidate that is not executable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coordo-codex-x-"));
  const plain = path.join(dir, "codex"); install(plain, 0o644);
  assert.equal(noPath(() => resolveCodexBin(profile(), [plain])), null);
});

test("an explicit bin from lead.json wins over PATH and the app bundle", () => {
  install(NEW);
  assert.equal(resolveCodexBin(profile("/custom/codex"), both), "/custom/codex");
});

test("a codex on PATH wins over the app bundle", () => {
  install(NEW);
  const bin = mkdtempSync(path.join(tmpdir(), "coordo-codex-path-")); install(path.join(bin, "codex"));
  const saved = process.env.PATH; process.env.PATH = bin;
  try { assert.equal(resolveCodexBin(profile(), both), path.join(bin, "codex")); } finally { process.env.PATH = saved; }
});

test("finding nothing returns null, and the hint says where it looked and what to set", () => {
  const nowhere = [path.join(root, "nope", "a"), path.join(root, "nope", "b")];
  assert.equal(noPath(() => resolveCodexBin(profile(), nowhere)), null);
  const hint = codexNotFoundHint(nowhere);
  for (const p of nowhere) assert.ok(hint.includes(p), `hint lists ${p}`);
  assert.match(hint, /\.coordo\/lead\.json/);
  assert.match(hint, /"bin"/);
});

test("the built-in candidates cover both ChatGPT.app layouts, newest first", () => {
  const c = [...CODEX_APP_CANDIDATES];
  const iNew = c.findIndex((p) => p.endsWith("/Contents/Resources/codex-cli/bin/codex"));
  const iOld = c.findIndex((p) => p.endsWith("/Contents/Resources/codex"));
  assert.ok(iNew >= 0 && iOld >= 0, "both layouts are probed");
  assert.ok(iNew < iOld, "the newer layout is tried first");
});
