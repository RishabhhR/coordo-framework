import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type StorageBackend = "git" | "mongo";

export interface StorageConfig {
  backend: StorageBackend;
  ledgerId: string;
}

function configPath(projectRoot: string): string {
  return path.join(projectRoot, ".coordo", "config.json");
}

export function loadStorageConfig(projectRoot: string): StorageConfig {
  let fileConfig: Partial<StorageConfig> = {};
  const file = configPath(projectRoot);
  if (existsSync(file)) {
    try {
      fileConfig = JSON.parse(readFileSync(file, "utf-8"));
    } catch (err) {
      throw new Error(`Invalid Coordo storage config at ${file}: ${(err as Error).message}`);
    }
  }

  const backend = (process.env.COORDO_STORAGE ?? fileConfig.backend ?? "git").toLowerCase();
  if (backend !== "git" && backend !== "mongo") {
    throw new Error(`Unsupported COORDO_STORAGE '${backend}'. Use 'git' or 'mongo'.`);
  }
  const ledgerId = process.env.COORDO_MONGO_LEDGER_ID ?? fileConfig.ledgerId ?? "personal";
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(ledgerId)) {
    throw new Error(`Invalid Mongo ledger id '${ledgerId}'. Use letters, digits, dot, underscore, colon or hyphen.`);
  }
  return { backend: backend as StorageBackend, ledgerId };
}

export function mongoAgent(): "claude" | "codex" | "antigravity" {
  const agent = (process.env.COORDO_AGENT ?? "").trim().toLowerCase();
  if (agent !== "claude" && agent !== "codex" && agent !== "antigravity") {
    throw new Error("Mongo storage needs an agent identity. Run with --as claude|codex|antigravity or set COORDO_AGENT; passwords stay in ~/.config/coordo/mongo.env.");
  }
  return agent;
}
