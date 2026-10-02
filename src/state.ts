import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface CoordoState {
  checkpoints: Record<string, string>;
}

function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".coordo", "state.json");
}

export function readState(projectRoot: string): CoordoState {
  const p = statePath(projectRoot);
  if (!existsSync(p)) return { checkpoints: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return { checkpoints: parsed.checkpoints ?? {} };
  } catch {
    return { checkpoints: {} };
  }
}

export function writeState(projectRoot: string, state: CoordoState): void {
  writeFileSync(statePath(projectRoot), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function getCheckpoint(projectRoot: string, as: string): string | undefined {
  return readState(projectRoot).checkpoints[as];
}

export function setCheckpoint(projectRoot: string, as: string, sha: string): void {
  const state = readState(projectRoot);
  state.checkpoints[as] = sha;
  writeState(projectRoot, state);
}
