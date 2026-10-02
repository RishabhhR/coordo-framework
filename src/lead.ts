import { writeFileSync } from "node:fs";
import path from "node:path";
import { dispatch, isTaskDone, notify, runsDir, timestamp, type DispatchResult } from "./agents.js";
import { commitAll, commitBlocker, uncommittedChanges, type GitError } from "./git.js";
import { addTask, parseLedger, type LedgerItem } from "./ledger.js";
import { isAgentAddress, type AgentName, type LeadConfig } from "./leadConfig.js";
import { makePlan, writePlan } from "./planner.js";
import { isVerifyTask, verifyTaskBody, workerPrompt, VERIFY_PREFIX } from "./prompts.js";

// The coordo-lead loop. Each step re-reads the ledger, pauses if a human owes
// a decision, otherwise dispatches the oldest open in-scope task to the agent
// it is addressed to and checks the ledger to see whether that agent closed it.
// When a non-verifier agent closes a task, a VERIFY task goes to the verifier;
// the verifier files DEFECT tasks back to the author on failure, and those are
// picked up by the same loop - so self-healing needs no special casing.

export type LeadOutcome = "complete" | "paused" | "stuck" | "planned";

export interface LeadOptions {
  goal?: string;
  planFile?: string;
  dryRun?: boolean;
  /** When a human decision blocks the run, wait for the answer instead of exiting. */
  wait?: boolean;
  /** Start even if files other than the ledger have uncommitted changes (they get committed with the first task). */
  allowDirty?: boolean;
  maxSteps?: number;
  log?: (line: string) => void;
}

export interface StepRecord {
  step: number;
  taskId: string;
  agent: AgentName;
  attempt: number;
  mode: DispatchResult["mode"];
  exitOk: boolean;
  closed: boolean;
  durationMs: number;
  costUsd?: number;
  logPath: string | null;
  summary: string;
  filed?: string;
}

export interface LeadResult {
  outcome: LeadOutcome;
  runId: string;
  message: string;
  steps: StepRecord[];
  planned: string[];
}

const DECISION_POLL_MS = 20_000;

function idNum(id: string): number {
  return Number(id.split("-")[1]) || 0;
}

function maxId(items: LedgerItem[], prefix: string): number {
  return items.filter((i) => i.id.startsWith(prefix + "-")).reduce((m, i) => Math.max(m, idNum(i.id)), 0);
}

function firstLine(item: LedgerItem): string {
  const line = item.body.split("\n")[0];
  return line.length > 90 ? line.slice(0, 89) + "…" : line;
}

function closedSafely(root: string, taskId: string): boolean {
  try {
    return isTaskDone(root, taskId);
  } catch {
    return false;
  }
}

// The lead commits every closed task's changes as one commit, so it must start
// from a clean tree or it would sweep someone's unrelated edits into an
// agent's task. Ledger edits are coordination state (e.g. a decision answered
// before a re-run) and are fine to carry into the next commit.
function assertCanCommit(root: string, allowDirty: boolean): void {
  const blocker = commitBlocker(root);
  if (blocker) {
    throw new Error(`coordo lead commits each task's work, but git is not usable here: ${blocker}\nFix git, or set "commit": false in .coordo/lead.json.`);
  }
  const dirty = uncommittedChanges(root).filter((line) => !line.endsWith(".coordo/ledger.md"));
  if (dirty.length > 0 && !allowDirty) {
    const list = dirty.slice(0, 8).map((l) => `  ${l}`).join("\n");
    throw new Error(`Uncommitted changes would be swept into the first task's commit:\n${list}\nCommit or stash them first, or pass --allow-dirty (e.g. to continue a paused run's partial work).`);
  }
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export async function runLead(root: string, config: LeadConfig, opts: LeadOptions = {}): Promise<LeadResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const runId = timestamp();
  const maxSteps = opts.maxSteps ?? config.maxSteps;
  const goalMode = Boolean(opts.goal || opts.planFile);
  const steps: StepRecord[] = [];
  let planned: string[] = [];

  // In goal mode the run owns only what it creates: the planned tasks plus any
  // VERIFY/DEFECT tasks and decisions opened after it started. Without a goal
  // it drives every open task addressed to an enabled agent.
  const initial = parseLedger(root);
  const everything = [...initial.decisionsNeeded, ...initial.tasks, ...initial.resolvedLog];
  const startTask = maxId(everything, "TASK");
  const startDec = maxId(everything, "DEC");
  const taskInScope = (t: LedgerItem) => !goalMode || idNum(t.id) > startTask;
  const decisionInScope = (d: LedgerItem) => !goalMode || idNum(d.id) > startDec;

  const finish = (outcome: LeadOutcome, message: string): LeadResult => {
    const result: LeadResult = { outcome, runId, message, steps, planned };
    if (!opts.dryRun) {
      const recordPath = path.join(runsDir(root), `${runId}.run.json`);
      writeFileSync(recordPath, JSON.stringify({ goal: opts.goal ?? null, ...result }, null, 2) + "\n");
    }
    log(`\n=== coordo lead: ${outcome} (run ${runId}) ===`);
    for (const s of steps) {
      const mark = s.closed ? "✓ closed" : "✗ open  ";
      const cost = s.costUsd !== undefined ? `  $${s.costUsd.toFixed(2)}` : "";
      log(`  ${s.taskId.padEnd(9)} → ${s.agent.padEnd(11)} ${mark}  ${formatDuration(s.durationMs)}${cost}${s.filed ? `  ↳ ${s.filed}` : ""}`);
    }
    log(message);
    return result;
  };

  if (!config.verifier) log("ℹ  No verifier configured: completed tasks will not be reviewed automatically.");
  if (config.commit && !opts.dryRun) assertCanCommit(root, Boolean(opts.allowDirty));
  const commit = (message: string): string | null => (config.commit ? commitAll(root, message) : null);

  if (goalMode) {
    log(`🧭 Planning${opts.goal ? `: ${opts.goal}` : ` from ${opts.planFile}`}`);
    const plan = await makePlan(root, opts.goal ?? `plan file ${opts.planFile}`, config, opts.planFile);
    plan.tasks.forEach((t, i) => log(`  ${i + 1}. [${t.agent}] ${t.title}`));
    if (plan.question) log(`  ? ${plan.question}`);
    if (plan.costUsd !== undefined) log(`  (planner cost $${plan.costUsd.toFixed(2)})`);
    if (opts.dryRun) return finish("planned", "Dry run: nothing written to the ledger, no agents dispatched.");

    planned = writePlan(root, opts.goal ?? `plan file ${opts.planFile}`, plan, runId, config);
    log(`  Wrote ${planned.join(", ")} to the ledger.`);
    const sha = commit(`coordo-lead: plan ${planned.join(", ")} (run ${runId})\n\nGoal: ${opts.goal ?? opts.planFile}`);
    if (sha) log(`  Committed the plan as ${sha}.`);
    if (plan.question) {
      notify(`coordo lead: the planner needs an answer on ${planned[0]}`);
      return finish("paused", `The planner asked ${config.human} a question (${planned[0]}). Answer it with coordo decision answer ${planned[0]} "...", then re-run coordo lead with the same goal.`);
    }
  }

  const attempts = new Map<string, number>();
  const lastFailure = new Map<string, string>();
  let step = 0;

  while (true) {
    const ledger = parseLedger(root);

    const blocking = ledger.decisionsNeeded.filter((d) => !isAgentAddress(config, d.to) && decisionInScope(d));
    if (blocking.length > 0) {
      const ids = blocking.map((d) => `${d.id} (to ${d.to})`).join(", ");
      if (opts.dryRun) return finish("paused", `Dry run: would pause on ${ids}.`);
      notify(`coordo lead paused: ${ids} needs an answer`);
      log(`\n⏸  Paused: ${ids} needs a human answer. Reply with: coordo decision answer <id> "<answer>"`);
      if (!opts.wait) return finish("paused", `Re-run coordo lead after answering ${ids}.`);
      await new Promise((r) => setTimeout(r, DECISION_POLL_MS));
      continue;
    }

    const open = ledger.tasks
      .filter((t) => config.agents.includes(t.to) && taskInScope(t))
      .sort((a, b) => idNum(a.id) - idNum(b.id));
    if (open.length === 0) {
      return finish("complete", steps.length === 0 ? "Nothing to do: no open tasks for enabled agents in scope." : "All tasks in scope are closed.");
    }
    const runnable = open.filter((t) => (attempts.get(t.id) ?? 0) < config.maxAttemptsPerTask);
    if (runnable.length === 0) {
      return finish("stuck", `Every open task in scope has used its ${config.maxAttemptsPerTask} attempts: ${open.map((t) => t.id).join(", ")}. Check the logs in .coordo/runs/.`);
    }

    if (opts.dryRun) {
      log("\nWould dispatch, in order (VERIFY/DEFECT follow-ups are created as work closes):");
      for (const t of runnable) {
        const how = await dispatch(t.to, "", { root, config, taskId: t.id, dryRun: true });
        log(`  ${t.id} → ${t.to}: ${firstLine(t)}\n      via ${how.summary}`);
      }
      return finish("planned", "Dry run: no agents dispatched.");
    }

    if (step >= maxSteps) {
      return finish("stuck", `Reached --max-steps ${maxSteps} with ${open.length} task(s) still open: ${open.map((t) => t.id).join(", ")}. Re-run to continue.`);
    }

    step++;
    const task = runnable[0];
    const agent: AgentName = task.to;
    const attempt = (attempts.get(task.id) ?? 0) + 1;
    attempts.set(task.id, attempt);
    log(`\n▶ step ${step}/${maxSteps}  ${task.id} → ${agent}  (attempt ${attempt}/${config.maxAttemptsPerTask})  ${firstLine(task)}`);

    let prompt = workerPrompt(task, agent, root, config);
    const previous = lastFailure.get(task.id);
    if (previous) prompt += `\n\nA previous attempt ended without closing ${task.id}. Its last message was:\n<<<\n${previous}\n>>>`;

    const result = await dispatch(agent, prompt, { root, config, taskId: task.id, log });
    const closed = closedSafely(root, task.id);
    const cost = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(2)}` : "";
    if (closed) {
      log(`  ✓ ${task.id} closed by ${agent} (${formatDuration(result.durationMs)}${cost})`);
      try {
        const sha = commit(`${task.id}: ${firstLine(task)}\n\nWork by ${agent}; committed by coordo-lead (run ${runId}).`);
        if (sha) log(`    committed ${sha}`);
      } catch (err) {
        steps.push({
          step, taskId: task.id, agent, attempt, mode: result.mode, exitOk: result.ok, closed,
          durationMs: result.durationMs, costUsd: result.costUsd, logPath: result.logPath, summary: result.summary,
        });
        return finish("stuck", `${task.id} closed, but committing its changes failed: ${(err as GitError).reason ?? (err as Error).message}\nThe changes are left in the working tree; fix the problem and commit them, then re-run.`);
      }
    } else {
      lastFailure.set(task.id, result.summary);
      log(`  ✗ ${task.id} still open after ${agent} ${result.ok ? "finished" : "failed"} (${formatDuration(result.durationMs)}${cost}): ${result.summary.split("\n")[0].slice(0, 200)}`);
    }
    if (result.logPath) log(`    log: ${path.relative(root, result.logPath)}`);

    let filed: string | undefined;
    if (closed && config.verifier && agent !== config.verifier && !isVerifyTask(task)) {
      const after = parseLedger(root);
      const alreadyFiled = [...after.tasks, ...after.resolvedLog].some((t) => t.body.startsWith(`${VERIFY_PREFIX}${task.id} `));
      if (!alreadyFiled) {
        filed = addTask(root, verifyTaskBody(task, config.verifier, config), "lead", config.verifier);
        log(`  ↳ filed ${filed}: ${VERIFY_PREFIX}${task.id} → ${config.verifier}`);
      }
    }

    steps.push({
      step, taskId: task.id, agent, attempt, mode: result.mode, exitOk: result.ok, closed,
      durationMs: result.durationMs, costUsd: result.costUsd, logPath: result.logPath, summary: result.summary, filed,
    });
  }
}
