import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// An agent is a NAME (what a ledger item is addressed to, e.g. "architect")
// backed by an ADAPTER (how coordo runs it: which CLI). Several names can share
// one adapter, which is how a single tool plays several roles: "architect" and
// "builder" can both be `claude`, on different models, with different
// instructions. Names that match a built-in adapter ("claude", "codex",
// "antigravity") need no definition and keep working exactly as before.
// A ledger item addressed to any name that is not an agent (e.g. "human",
// "alice") is treated as addressed to a person.
export const ADAPTERS = ["claude", "codex", "antigravity", "command", "handoff"] as const;
export type Adapter = (typeof ADAPTERS)[number];

export const BUILTIN_AGENT_NAMES = ["claude", "codex", "antigravity"] as const;
export type AgentName = string;

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function isBuiltinAgent(name: string): boolean {
  return (BUILTIN_AGENT_NAMES as readonly string[]).includes(name);
}

/** True when a ledger item addressed to `name` is for an agent rather than a person. */
export function isAgentAddress(config: LeadConfig, name: string): boolean {
  return config.agents.includes(name) || isBuiltinAgent(name);
}

/** One agent as written in .coordo/lead.json. Every key except `adapter` is optional. */
export interface AgentProfileConfig {
  /** Which CLI runs this agent. Optional when the name is itself a built-in adapter. */
  adapter?: Adapter;
  /** One line on what this agent is best at; shown to the planner when it assigns tasks. */
  role?: string;
  /** Standing instructions added to this agent's worker prompt. This is what makes two profiles on one tool behave differently. */
  instructions?: string;
  model?: string | null;
  /** Binary override. Required for `command`; optional for the others. */
  bin?: string | null;
  /** command: argv for the binary. `{prompt}`, `{promptFile}` and `{root}` are substituted; with neither prompt placeholder the prompt goes to stdin. */
  args?: string[];
  /** claude only. */
  permissionMode?: string;
  allowedTools?: string[];
  maxBudgetUsd?: number | null;
  /** codex only. */
  sandbox?: "read-only" | "workspace-write";
}

export interface ResolvedProfile {
  name: string;
  adapter: Adapter;
  role: string;
  instructions: string | null;
  model: string | null;
  bin: string | null;
  args: string[];
  permissionMode: string;
  allowedTools: string[];
  maxBudgetUsd: number | null;
  sandbox: "read-only" | "workspace-write";
}

export interface CreditsConfig {
  enabled: boolean;
  defaultBalance: number;
  enforceLimits: boolean;
  costPerSecondEstimate: number;
}

export interface LeadConfig {
  /** Names of the agents the lead may dispatch to; tasks addressed to anyone else are left alone. */
  agents: AgentName[];
  /** Definitions for agents declared in the object form of `agents`. Built-in names need none. */
  profiles: Record<AgentName, AgentProfileConfig>;
  /** Agent that reviews every other agent's completed task, or null to skip verification. */
  verifier: AgentName | null;
  /** Name agents address human decisions to. */
  human: string;
  /** Command agents run to verify their work, e.g. "npm test". Also allowlisted for claude. */
  testCommand: string | null;
  /**
   * The lead commits the plan and each closed task's changes itself. Agents
   * don't commit: sandboxed ones (codex workspace-write) can't write .git.
   */
  commit: boolean;
  maxSteps: number;
  maxAttemptsPerTask: number;
  maxPlannedTasks: number;
  runTimeoutMinutes: number;
  /** How often to re-read the ledger while waiting on a handoff or an asynchronous agent. */
  pollSeconds: number;
  /** Local model-router bridge settings. Routing only recommends a model; adapters still own execution. */
  modelRouter: {
    enabled: boolean;
    bin: string;
    timeoutSeconds: number;
  };
  /** Default role per agent name (profiles override it); shown to the planner. */
  roles: Record<AgentName, string>;
  /** Defaults shared by every agent that uses the claude adapter. */
  claude: {
    bin: string;
    model: string | null;
    plannerModel: string | null;
    permissionMode: string;
    allowedTools: string[];
    maxBudgetUsd: number | null;
  };
  /** Defaults shared by every agent that uses the codex adapter. */
  codex: {
    /** null = find `codex` on PATH, then the copy bundled inside ChatGPT.app. */
    bin: string | null;
    model: string | null;
    sandbox: "read-only" | "workspace-write";
  };
  /** Defaults shared by every agent that uses the antigravity adapter. */
  antigravity: {
    /** null = `agentapi`, used only when ANTIGRAVITY_LS_ADDRESS is set (an Antigravity terminal). */
    bin: string | null;
    model: string | null;
    /** Kept for old configs; prefer the top-level `pollSeconds`. */
    pollSeconds: number;
  };
  credits: CreditsConfig;
  /** When true, agent-addressed decisions are resolved autonomously by target agents in coordo lead. Default true. */
  autonomousDecisions: boolean;
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  agents: ["claude", "codex", "antigravity"],
  profiles: {},
  verifier: "claude",
  human: "human",
  testCommand: null,
  commit: true,
  maxSteps: 8,
  maxAttemptsPerTask: 2,
  maxPlannedTasks: 6,
  runTimeoutMinutes: 45,
  pollSeconds: 15,
  modelRouter: {
    enabled: true,
    bin: "model-router",
    timeoutSeconds: 5,
  },
  roles: {
    codex: "architecture, schemas, types, interfaces and low-level modules",
    antigravity: "feature implementation, UI and integration code",
    claude: "tests, verification, code review and git hygiene",
  },
  credits: {
    enabled: true,
    defaultBalance: 100.0,
    enforceLimits: false,
    costPerSecondEstimate: 0.0005,
  },
  autonomousDecisions: true,
  claude: {
    bin: "claude",
    model: null,
    plannerModel: "sonnet",
    permissionMode: "acceptEdits",
    // Headless runs cannot answer permission prompts, so anything not listed
    // here is denied. testCommand is appended at dispatch time.
    allowedTools: [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(coordo:*)",
      "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
    ],
    maxBudgetUsd: 3,
  },
  codex: {
    bin: null,
    model: null,
    sandbox: "workspace-write",
  },
  antigravity: {
    bin: null,
    model: null,
    pollSeconds: 15,
  },
};

const FALLBACK_ROLE = "general software engineering work";

/**
 * Fills in everything an adapter needs for one agent: the profile's own
 * settings first, then the shared per-adapter section, then the defaults.
 */
export function resolveProfile(config: LeadConfig, name: string): ResolvedProfile {
  const own = config.profiles[name];
  const adapter = own?.adapter ?? (isBuiltinAgent(name) ? (name as Adapter) : undefined);
  if (!adapter) {
    throw new Error(`Unknown agent "${name}". Known: ${config.agents.join(", ")}. Define it in .coordo/lead.json under "agents".`);
  }
  return {
    name,
    adapter,
    role: own?.role ?? config.roles[name] ?? FALLBACK_ROLE,
    instructions: own?.instructions?.trim() || null,
    model: own?.model ?? (adapter === "claude" ? config.claude.model : adapter === "codex" ? config.codex.model : adapter === "antigravity" ? config.antigravity.model : null),
    bin: own?.bin ?? (adapter === "claude" ? config.claude.bin : adapter === "codex" ? config.codex.bin : adapter === "antigravity" ? config.antigravity.bin : null),
    args: own?.args ?? [],
    permissionMode: own?.permissionMode ?? config.claude.permissionMode,
    allowedTools: own?.allowedTools ?? config.claude.allowedTools,
    maxBudgetUsd: own?.maxBudgetUsd !== undefined ? own.maxBudgetUsd : config.claude.maxBudgetUsd,
    sandbox: own?.sandbox ?? config.codex.sandbox,
  };
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

// `agents` is either the legacy array of names or an object of name -> profile.
// Returns the names plus the profile definitions the object form carried.
function normalizeAgents(file: string, raw: unknown): { names: string[]; profiles: Record<string, AgentProfileConfig> } {
  if (Array.isArray(raw)) {
    const names = raw.map(String);
    const unknown = names.filter((n) => !isBuiltinAgent(n));
    if (unknown.length > 0) {
      fail(file, `unknown agent(s) ${unknown.join(", ")}. The list form only accepts ${BUILTIN_AGENT_NAMES.join(", ")}; to define your own agents, make "agents" an object: {"${unknown[0]}": {"adapter": "claude", "role": "..."}}.`);
    }
    return { names, profiles: {} };
  }
  if (raw === null || typeof raw !== "object") fail(file, `"agents" must be an array of names or an object of name -> profile.`);

  const names: string[] = [];
  const profiles: Record<string, AgentProfileConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_PATTERN.test(name)) {
      fail(file, `agent name "${name}" must be lowercase letters, digits, "-" or "_" (it appears in ledger headers as to:${name}).`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(file, `agent "${name}" must be an object.`);
    const profile = value as AgentProfileConfig;
    const adapter = profile.adapter ?? (isBuiltinAgent(name) ? (name as Adapter) : undefined);
    if (!adapter) {
      fail(file, `agent "${name}" needs an "adapter" (one of ${ADAPTERS.join(", ")}) because it is not a built-in name.`);
    }
    if (!(ADAPTERS as readonly string[]).includes(adapter)) {
      fail(file, `agent "${name}" has unknown adapter "${adapter}". Use one of ${ADAPTERS.join(", ")}.`);
    }
    if (adapter === "command" && !profile.bin) {
      fail(file, `agent "${name}" uses the "command" adapter, which needs "bin" (and usually "args").`);
    }
    if (profile.args !== undefined && !(Array.isArray(profile.args) && profile.args.every((a) => typeof a === "string"))) {
      fail(file, `agent "${name}": "args" must be an array of strings.`);
    }
    if (adapter === "antigravity" && profile.model !== undefined && profile.model !== null && !["flash_lite", "flash", "pro"].includes(profile.model)) {
      fail(file, `agent "${name}": antigravity model must be flash_lite, flash or pro.`);
    }
    names.push(name);
    profiles[name] = { ...profile, adapter };
  }
  if (names.length === 0) fail(file, `"agents" is empty; define at least one agent.`);
  return { names, profiles };
}

// Reads .coordo/lead.json over the defaults. Sections (roles, claude, codex,
// antigravity) merge key by key, so a config only needs the keys it changes.
export function loadLeadConfig(projectRoot: string): LeadConfig {
  const file = path.join(projectRoot, ".coordo", "lead.json");
  const config = structuredClone(DEFAULT_LEAD_CONFIG);
  if (!existsSync(file)) return config;

  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(file, "the top level must be a JSON object.");

  const { agents: rawAgents, ...rest } = raw;
  const merged: LeadConfig = {
    ...config,
    ...rest,
    roles: { ...config.roles, ...rest.roles },
    claude: { ...config.claude, ...rest.claude },
    codex: { ...config.codex, ...rest.codex },
    antigravity: { ...config.antigravity, ...rest.antigravity },
    modelRouter: { ...config.modelRouter, ...rest.modelRouter },
    credits: { ...config.credits, ...rest.credits },
    autonomousDecisions: rest.autonomousDecisions ?? config.autonomousDecisions,
  };
  if (typeof merged.modelRouter.enabled !== "boolean") {
    fail(file, `"modelRouter.enabled" must be true or false.`);
  }
  if (typeof merged.modelRouter.bin !== "string" || !merged.modelRouter.bin.trim()) {
    fail(file, `"modelRouter.bin" must be a non-empty executable name or path.`);
  }
  if (!Number.isInteger(merged.modelRouter.timeoutSeconds) || merged.modelRouter.timeoutSeconds < 1 || merged.modelRouter.timeoutSeconds > 60) {
    fail(file, `"modelRouter.timeoutSeconds" must be an integer from 1 to 60.`);
  }
  if (rawAgents !== undefined) {
    const { names, profiles } = normalizeAgents(file, rawAgents);
    merged.agents = names;
    merged.profiles = profiles;
  }
  // Old configs set the wait interval under antigravity; honour it unless the
  // top-level key is present.
  if (rest.pollSeconds === undefined && rest.antigravity?.pollSeconds !== undefined) {
    merged.pollSeconds = rest.antigravity.pollSeconds;
  }

  // With no explicit verifier, claude verifies if it is on the team; a team
  // without claude runs unverified rather than failing to load.
  if (rest.verifier === undefined && !merged.agents.includes(merged.verifier ?? "")) merged.verifier = null;
  if (merged.verifier !== null && !merged.agents.includes(merged.verifier)) {
    fail(file, `verifier "${merged.verifier}" is not in agents [${merged.agents.join(", ")}]. Set "verifier" to one of them, or to null to skip verification.`);
  }
  return merged;
}
