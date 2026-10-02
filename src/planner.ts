import { readFileSync } from "node:fs";
import path from "node:path";
import { claudeCommand, parseClaudeOutput, runProcess, runsDir, timestamp } from "./agents.js";
import { addDecision, addTask, parseLedger } from "./ledger.js";
import type { AgentName, LeadConfig } from "./leadConfig.js";
import { plannerPrompt } from "./prompts.js";

export interface PlannedTask {
  agent: AgentName;
  title: string;
  description: string;
}

export interface Plan {
  tasks: PlannedTask[];
  /** Set when the planner needs a human to settle something before any work starts. */
  question?: string;
  costUsd?: number;
}

// Accepts the planner's reply with or without code fences or stray prose
// around the JSON object, then validates it against the enabled agents.
export function parsePlan(text: string, config: LeadConfig): Plan {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Planner reply contained no JSON object: ${text.trim().slice(0, 200)}`);
  }
  let raw: { tasks?: unknown; question?: unknown };
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Planner reply was not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw.tasks)) throw new Error(`Planner reply has no "tasks" array.`);

  const tasks = raw.tasks.map((t: any, i: number): PlannedTask => {
    const agent = String(t?.agent ?? "").trim().toLowerCase();
    if (!config.agents.includes(agent)) {
      throw new Error(`Planned task ${i + 1} is assigned to "${t?.agent}", which is not an enabled agent (${config.agents.join(", ")}).`);
    }
    const title = String(t?.title ?? "").trim();
    const description = String(t?.description ?? "").trim();
    if (!title || !description) throw new Error(`Planned task ${i + 1} is missing a title or description.`);
    return { agent, title, description };
  });
  if (tasks.length > config.maxPlannedTasks) {
    throw new Error(`Planner returned ${tasks.length} tasks; the limit is ${config.maxPlannedTasks} (maxPlannedTasks).`);
  }
  const question = typeof raw.question === "string" && raw.question.trim() ? raw.question.trim() : undefined;
  if (tasks.length === 0 && !question) throw new Error("Planner returned no tasks and no question.");
  return { tasks, question };
}

// Asks the planner agent for a plan, or reads one from --plan-file (same JSON
// shape) so a plan can be written by hand or replayed without an LLM call.
export async function makePlan(root: string, goal: string, config: LeadConfig, planFile?: string): Promise<Plan> {
  if (planFile) return parsePlan(readFileSync(path.resolve(planFile), "utf-8"), config);

  const ledger = parseLedger(root);
  const prompt = plannerPrompt(goal, config, [...ledger.decisionsNeeded, ...ledger.tasks]);
  const logPath = path.join(runsDir(root), `${timestamp()}-planner.log`);
  const result = await runProcess(claudeCommand(config, prompt, { planner: true }), root, logPath, config.runTimeoutMinutes * 60_000);
  if (result.error || result.timedOut || result.exitCode !== 0) {
    throw new Error(`Planner (claude) failed: ${result.error ?? (result.timedOut ? "timed out" : `exit ${result.exitCode}`)}. Log: ${logPath}`);
  }
  const out = parseClaudeOutput(result.stdout);
  if (out.isError) throw new Error(`Planner (claude) reported an error: ${out.summary.slice(0, 300)}. Log: ${logPath}`);
  return { ...parsePlan(out.summary, config), costUsd: out.costUsd };
}

// Writes the plan onto the ledger in order (the lead runs open tasks oldest
// first, so ledger order is execution order). Returns the new ids.
export function writePlan(root: string, goal: string, plan: Plan, runId: string, config: LeadConfig): string[] {
  if (plan.question) {
    return [addDecision(root, `${plan.question}\n\n(asked by the coordo-lead planner, run ${runId}, before planning: ${goal})`, "lead", config.human)];
  }
  return plan.tasks.map((t) =>
    addTask(root, `${t.title}\n${t.description}\n\n(planned by coordo-lead run ${runId} for goal: ${goal})`, "lead", t.agent)
  );
}
