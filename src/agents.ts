import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseLedger } from "./ledger.js";
import { resolveProfile, type AgentName, type LeadConfig, type ResolvedProfile } from "./leadConfig.js";

// Headless adapters. An agent NAME resolves to a profile whose ADAPTER decides
// how it runs: claude / codex / antigravity have dedicated CLIs, `command` runs
// any CLI you describe, and `handoff` asks a human to relay the prompt. Every
// agent gets its prompt on stdin (or in argv for agentapi and `command`) and
// signals completion the same way: by running `coordo task done <id>` on the
// shared ledger. The lead never trusts an exit code alone - it re-reads the
// ledger afterwards.

export interface AgentCommand {
  bin: string;
  args: string[];
  /** Written to the child's stdin; undefined = stdin closed. */
  stdin?: string;
}

export interface DispatchResult {
  agent: AgentName;
  /** headless = ran the agent's CLI; handoff = a human relays the prompt; dry-run = nothing ran. */
  mode: "headless" | "handoff" | "dry-run";
  /** Headless: the process exited 0. Handoff: the task was closed before the timeout. */
  ok: boolean;
  exitCode: number | null;
  /** The agent's final message (or the reason it failed), trimmed. */
  summary: string;
  logPath: string | null;
  durationMs: number;
  costUsd?: number;
}

export interface DispatchOptions {
  root: string;
  config: LeadConfig;
  /** Ledger task the prompt is about; lets handoff/async modes wait for it to close. */
  taskId?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

const CODEX_APP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const AGENTAPI_BIN = path.join(homedir(), ".gemini", "antigravity", "bin", "agentapi");
const SUMMARY_CHARS = 600;

// Read-only tools for the planner: it looks at the repo, it never changes it.
const PLANNER_TOOLS = [
  "Read", "Glob", "Grep",
  "Bash(git log:*)", "Bash(git ls-files:*)", "Bash(git status:*)", "Bash(coordo status:*)",
];

// .coordo/runs holds per-dispatch logs and run records. They can contain whole
// prompts and agent transcripts, so the directory ignores itself in git.
export function runsDir(projectRoot: string): string {
  const dir = path.join(projectRoot, ".coordo", "runs");
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

export function resolveCodexBin(profile: Pick<ResolvedProfile, "bin">): string | null {
  return profile.bin ?? onPath("codex") ?? (existsSync(CODEX_APP_BIN) ? CODEX_APP_BIN : null);
}

// agentapi talks to the Antigravity language server whose address Antigravity
// exports into its own terminals. Outside one there is no supported way to
// reach it, so Antigravity work falls back to a human handoff.
export function resolveAgentapiBin(profile: Pick<ResolvedProfile, "bin">): string | null {
  if (profile.bin) return profile.bin;
  if (!process.env.ANTIGRAVITY_LS_ADDRESS) return null;
  return onPath("agentapi") ?? (existsSync(AGENTAPI_BIN) ? AGENTAPI_BIN : null);
}

export function claudeCommand(config: LeadConfig, prompt: string, opts: { planner?: boolean; profile?: ResolvedProfile } = {}): AgentCommand {
  const profile = opts.profile ?? resolveProfile(config, "claude");
  const args = ["-p", "--output-format", "json"];
  const model = opts.planner ? config.claude.plannerModel : profile.model;
  if (model) args.push("--model", model);
  if (opts.planner) {
    args.push("--allowedTools", ...PLANNER_TOOLS);
  } else {
    const tools = [...profile.allowedTools];
    if (config.testCommand) tools.push(`Bash(${config.testCommand}:*)`);
    args.push("--permission-mode", profile.permissionMode, "--allowedTools", ...tools);
  }
  const budget = opts.planner ? config.claude.maxBudgetUsd : profile.maxBudgetUsd;
  if (budget) args.push("--max-budget-usd", String(budget));
  return { bin: opts.planner ? config.claude.bin : (profile.bin ?? config.claude.bin), args, stdin: prompt };
}

export function codexCommand(profile: ResolvedProfile, root: string, prompt: string, lastMessageFile: string): AgentCommand | null {
  const bin = resolveCodexBin(profile);
  if (!bin) return null;
  const args = ["exec", "--cd", root, "--sandbox", profile.sandbox, "--color", "never", "-o", lastMessageFile];
  if (profile.model) args.push("-m", profile.model);
  args.push("-"); // read the prompt from stdin
  return { bin, args, stdin: prompt };
}

export function antigravityCommand(profile: ResolvedProfile, prompt: string, title: string): AgentCommand | null {
  const bin = resolveAgentapiBin(profile);
  if (!bin) return null;
  return { bin, args: ["new-conversation", `--model=${profile.model ?? "flash"}`, `--title=${title}`, prompt] };
}

// Any other CLI. {prompt}, {promptFile} and {root} are substituted into args;
// when neither prompt placeholder appears the prompt is sent on stdin.
export function customCommand(profile: ResolvedProfile, root: string, prompt: string, promptFile: string): AgentCommand | null {
  if (!profile.bin) return null;
  const usesPlaceholder = profile.args.some((a) => a.includes("{prompt}") || a.includes("{promptFile}"));
  const args = profile.args.map((a) => a.split("{promptFile}").join(promptFile).split("{root}").join(root).split("{prompt}").join(prompt));
  return { bin: profile.bin, args, stdin: usesPlaceholder ? undefined : prompt };
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  error: string | null;
  timedOut: boolean;
}

export function runProcess(cmd: AgentCommand, cwd: string, logPath: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(logPath, { flags: "a" });
    log.write(`$ ${cmd.bin} ${cmd.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    if (cmd.stdin !== undefined) log.write(`--- stdin ---\n${cmd.stdin}\n--- output ---\n`);

    const child = spawn(cmd.bin, cmd.args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end(`\n--- exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.error ? ` (${result.error})` : ""} ---\n`);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      log.write(chunk);
      if (stdout.length < 5_000_000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));
    child.on("error", (err: NodeJS.ErrnoException) => {
      const error = err.code === "ENOENT" ? `${cmd.bin} not found` : err.message;
      finish({ exitCode: null, stdout, error, timedOut });
    });
    child.on("close", (code) => finish({ exitCode: code, stdout, error: null, timedOut }));

    child.stdin.on("error", () => { /* the child exited before reading stdin; reported via close */ });
    child.stdin.end(cmd.stdin ?? "");
  });
}

function trimSummary(text: string): string {
  const t = text.trim();
  return t.length > SUMMARY_CHARS ? `…${t.slice(-SUMMARY_CHARS)}` : t;
}

// claude -p --output-format json prints one result object at the end.
export function parseClaudeOutput(stdout: string): { summary: string; costUsd?: number; isError: boolean } {
  try {
    const out = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    return { summary: String(out.result ?? ""), costUsd: out.total_cost_usd, isError: out.is_error === true };
  } catch {
    return { summary: stdout, isError: false };
  }
}

export function isTaskDone(root: string, taskId: string): boolean {
  const ledger = parseLedger(root);
  return !ledger.tasks.some((t) => t.id === taskId)
    && ledger.resolvedLog.some((t) => t.id === taskId && t.status === "done");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTaskDone(root: string, taskId: string, pollMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (isTaskDone(root, taskId)) return true;
    } catch { /* ledger mid-write or mid-merge; look again next poll */ }
    await sleep(pollMs);
  }
  return isTaskDone(root, taskId);
}

export function notify(message: string): void {
  process.stdout.write("\x07");
  if (process.platform !== "darwin" || process.env.COORDO_NO_NOTIFY) return;
  const text = JSON.stringify(message.replace(/\s+/g, " ").slice(0, 200));
  try {
    execFileSync("osascript", ["-e", `display notification ${text} with title "coordo lead"`], { stdio: "ignore" });
  } catch { /* notifications are best-effort */ }
}

// Runs one agent on one prompt and waits for it to finish (headless), or for
// the task to be closed on the ledger (async/handoff).
export async function dispatch(agent: AgentName, prompt: string, opts: DispatchOptions): Promise<DispatchResult> {
  const { root, config, taskId } = opts;
  const profile = resolveProfile(config, agent);
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = Date.now();
  const label = `${timestamp()}-${agent}${taskId ? `-${taskId}` : ""}`;
  const timeoutMs = config.runTimeoutMinutes * 60_000;
  const pollMs = config.pollSeconds * 1000;
  const elapsed = () => Date.now() - started;

  const lastMessageFile = path.join(root, ".coordo", "runs", `${label}.last-message.txt`);
  const promptFile = path.join(root, ".coordo", "runs", `${label}.prompt.md`);
  let cmd: AgentCommand | null;
  switch (profile.adapter) {
    case "claude": cmd = claudeCommand(config, prompt, { profile }); break;
    case "codex": cmd = codexCommand(profile, root, prompt, lastMessageFile); break;
    case "antigravity": cmd = antigravityCommand(profile, prompt, `coordo ${taskId ?? "dispatch"}`); break;
    case "command": cmd = customCommand(profile, root, prompt, promptFile); break;
    case "handoff": cmd = null; break;
  }

  if (opts.dryRun) {
    // agentapi carries the whole prompt as its last argument; don't print it.
    const shown = cmd ? cmd.args.slice(0, profile.adapter === "antigravity" ? -1 : undefined) : [];
    const how = cmd
      ? `${cmd.bin} ${shown.join(" ")}`.slice(0, 300) + ` [${profile.adapter}${profile.model ? `, ${profile.model}` : ""}]`
      : "handoff (no headless CLI available)";
    return { agent, mode: "dry-run", ok: true, exitCode: null, summary: how, logPath: null, durationMs: 0 };
  }

  const dir = runsDir(root);
  const logPath = path.join(dir, `${label}.log`);

  if (!cmd) {
    // No headless path: hand the prompt to a human and wait for the ledger.
    writeFileSync(promptFile, prompt);
    notify(`${taskId ?? "A prompt"} needs ${agent}: paste ${path.basename(promptFile)} into ${agent}`);
    log(`  ✋ ${agent} has no headless CLI here. Paste this prompt into ${agent}:\n     ${promptFile}`);
    if (!taskId) {
      return { agent, mode: "handoff", ok: true, exitCode: null, summary: `prompt written to ${promptFile}`, logPath: null, durationMs: elapsed() };
    }
    log(`     Waiting up to ${config.runTimeoutMinutes}m for ${taskId} to be marked done (Ctrl-C to stop)...`);
    const done = await waitForTaskDone(root, taskId, pollMs, timeoutMs);
    return {
      agent, mode: "handoff", ok: done, exitCode: null, logPath: null, durationMs: elapsed(),
      summary: done ? `${taskId} closed on the ledger` : `timed out waiting for ${taskId}`,
    };
  }

  if (profile.adapter === "command" && profile.args.some((a) => a.includes("{promptFile}"))) writeFileSync(promptFile, prompt);
  const result = await runProcess(cmd, root, logPath, timeoutMs);
  const base = { agent, mode: "headless" as const, exitCode: result.exitCode, logPath };
  if (result.error || result.timedOut) {
    return { ...base, ok: false, durationMs: elapsed(), summary: result.error ?? `timed out after ${config.runTimeoutMinutes}m` };
  }

  if (profile.adapter === "claude") {
    const out = parseClaudeOutput(result.stdout);
    return { ...base, ok: result.exitCode === 0 && !out.isError, summary: trimSummary(out.summary), costUsd: out.costUsd, durationMs: elapsed() };
  }
  if (profile.adapter === "codex") {
    const last = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, "utf-8") : result.stdout;
    return { ...base, ok: result.exitCode === 0, summary: trimSummary(last), durationMs: elapsed() };
  }
  if (profile.adapter === "command") {
    return { ...base, ok: result.exitCode === 0, summary: trimSummary(result.stdout), durationMs: elapsed() };
  }

  // antigravity: agentapi only starts the conversation; the work happens
  // asynchronously, so completion is the task closing on the ledger.
  if (result.exitCode !== 0 || /"error"/.test(result.stdout)) {
    return { ...base, ok: false, summary: trimSummary(result.stdout), durationMs: elapsed() };
  }
  if (!taskId) return { ...base, ok: true, summary: trimSummary(result.stdout), durationMs: elapsed() };
  log(`     Antigravity conversation started; waiting for ${taskId} to be marked done...`);
  const done = await waitForTaskDone(root, taskId, pollMs, timeoutMs);
  return { ...base, ok: done, summary: done ? `${taskId} closed on the ledger` : `timed out waiting for ${taskId}`, durationMs: elapsed() };
}
