import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { Adapter } from "./leadConfig.js";

export interface ModelRouterConfig {
  enabled: boolean;
  bin: string;
  timeoutSeconds: number;
}

export interface ModelRouteDecision {
  provider: string;
  model: string;
  tier: "fast" | "balanced" | "strong";
  score: number;
  reasons: string[];
}

export type ModelRouteResult =
  | { decision: ModelRouteDecision; warning?: undefined }
  | { decision?: undefined; warning: string };

const ROUTABLE_ADAPTERS = new Set<Adapter>(["claude", "codex", "antigravity"]);
const MAX_OUTPUT = 64 * 1024;

/** Ask the local model-router bridge for a model within the already-selected agent adapter. */
export function routeModel(
  task: string,
  context: string,
  adapter: Adapter,
  config: ModelRouterConfig,
  options: { retry?: boolean; readOnly?: boolean; cwd?: string } = {},
): Promise<ModelRouteResult> {
  if (!config.enabled) return Promise.resolve({ warning: "model routing is disabled" });
  if (!ROUTABLE_ADAPTERS.has(adapter)) {
    return Promise.resolve({ warning: `the ${adapter} adapter has no model-router provider mapping` });
  }

  const request = JSON.stringify({
    protocol: "model-router/v1",
    agent: adapter,
    provider: adapter,
    task,
    context,
    retry: Boolean(options.retry),
    read_only: Boolean(options.readOnly),
  });

  return new Promise((resolve) => {
    // Do not pass the user's full environment (which can contain API keys) to
    // the local recommender. It needs PATH to find itself and HOME for config.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: homedir(),
      LANG: process.env.LANG ?? "C",
    };
    const child = spawn(config.bin, ["bridge"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "ignore"],
      env,
    });
    let stdout = "";
    let settled = false;
    const finish = (result: ModelRouteResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ warning: `model-router timed out after ${config.timeoutSeconds}s` });
    }, Math.max(1, config.timeoutSeconds) * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT) {
        child.kill("SIGTERM");
        finish({ warning: "model-router returned an oversized response" });
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ warning: error.code === "ENOENT" ? `model-router executable not found: ${config.bin}` : `could not start model-router: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ warning: `model-router exited with status ${code}` });
        return;
      }
      try {
        const response = JSON.parse(stdout) as {
          protocol?: string;
          ok?: boolean;
          error?: string;
          decision?: Partial<ModelRouteDecision>;
        };
        const decision = response.decision;
        if (response.protocol !== "model-router/v1" || response.ok !== true || !decision) {
          finish({ warning: "model-router returned an invalid or error response" });
          return;
        }
        if (decision.provider !== adapter || typeof decision.model !== "string" || !decision.model.trim()
          || !["fast", "balanced", "strong"].includes(String(decision.tier))) {
          finish({ warning: "model-router returned a model outside the selected adapter or an invalid tier" });
          return;
        }
        finish({ decision: {
          provider: decision.provider,
          model: decision.model,
          tier: decision.tier as ModelRouteDecision["tier"],
          score: Number(decision.score) || 0,
          reasons: Array.isArray(decision.reasons) ? decision.reasons.map(String) : [],
        } });
      } catch {
        finish({ warning: "model-router returned malformed JSON" });
      }
    });
    child.stdin.on("error", () => { /* surfaced by process close/error */ });
    child.stdin.end(request);
  });
}
