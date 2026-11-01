// Development convenience: copy the build to ~/.local/share/coordo/versions/<v>
// and symlink ~/.local/bin/coordo to it, so `coordo` runs your working copy.
// Most people want `npm install -g .` (or `npm link`) instead.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)); // .pathname would leave a space as %20
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const target = path.join(homedir(), ".local", "share", "coordo", "versions", version);
const link = path.join(homedir(), ".local", "bin", "coordo");

mkdirSync(target, { recursive: true });
cpSync(path.join(root, "dist"), target, { recursive: true });
chmodSync(path.join(target, "cli.js"), 0o755);
// The build imports runtime dependencies (mongodb), which dist does not contain.
rmSync(path.join(target, "node_modules"), { recursive: true, force: true });
symlinkSync(path.join(root, "node_modules"), path.join(target, "node_modules"));
// Every agent runs through this symlink: prove the new copy starts before pointing it there.
try {
  execFileSync(process.execPath, [path.join(target, "cli.js"), "--help"], { stdio: "ignore" });
} catch {
  console.error(`coordo ${version} failed to start from ${target}; ${link} was left unchanged.`);
  process.exit(1);
}
mkdirSync(path.dirname(link), { recursive: true });
const next = `${link}.next`;
rmSync(next, { force: true });
symlinkSync(path.join(target, "cli.js"), next);
renameSync(next, link); // atomic, so no agent ever sees a missing coordo
console.log(`Installed coordo ${version} -> ${link}`);
console.log(`Make sure ${path.dirname(link)} is on your PATH.`);
