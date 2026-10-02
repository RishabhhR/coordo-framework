// Development convenience: copy the build to ~/.local/share/coordo/versions/<v>
// and symlink ~/.local/bin/coordo to it, so `coordo` runs your working copy.
// Most people want `npm install -g .` (or `npm link`) instead.
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const target = path.join(homedir(), ".local", "share", "coordo", "versions", version);
const link = path.join(homedir(), ".local", "bin", "coordo");

mkdirSync(target, { recursive: true });
cpSync(path.join(root, "dist"), target, { recursive: true });
chmodSync(path.join(target, "cli.js"), 0o755);
mkdirSync(path.dirname(link), { recursive: true });
rmSync(link, { force: true });
symlinkSync(path.join(target, "cli.js"), link);
console.log(`Installed coordo ${version} -> ${link}`);
console.log(`Make sure ${path.dirname(link)} is on your PATH.`);
