import type { LedgerItem } from "./ledger.js";
import { resolveProfile, type AgentName, type LeadConfig } from "./leadConfig.js";

// Prompt text coordo-lead sends to agents. Kept in one place so the protocol
// every agent is held to (claim nothing in chat, close work on the ledger) is
// stated identically everywhere.

export const VERIFY_PREFIX = "VERIFY ";

export function workerPrompt(task: LedgerItem, agent: AgentName, root: string, config: LeadConfig): string {
  const verifyStep = config.testCommand
    ? `run \`${config.testCommand}\` and make sure it passes`
    : "run the project's tests, or the closest real check available";
  const profile = resolveProfile(config, agent);
  const standing = profile.instructions ? `\nSTANDING INSTRUCTIONS FOR ${agent}:\n${profile.instructions}\n` : "";
  return `You are ${agent}, a worker agent dispatched headlessly by coordo-lead in the repository ${root}.
Your role on this team: ${profile.role}.
Nobody is watching this session live: do not ask questions in chat, use the ledger.
${standing}
YOUR ASSIGNMENT: ${task.id} in .coordo/ledger.md (from ${task.from}):
<<<
${task.body}
>>>

Protocol:
1. Run \`coordo status\` and skim .coordo/ledger.md for context. Follow this repo's CLAUDE.md / AGENTS.md conventions.
2. Do only what ${task.id} asks.
3. Before claiming completion, ${verifyStep}.
4. ${config.commit
    ? `Do not commit: coordo-lead commits your changes under ${task.id} once you close it.`
    : `Commit your changes with a message starting "${task.id}: ".`}
5. When finished, run: coordo task done ${task.id} --note "<what changed, which files, how you verified it>"
6. Peer agent collaboration:
   - To consult a peer agent without human interference, run: coordo consult <agent> "<question>" --from ${agent}
   - To invoke a peer agent directly to execute a sub-task, run: coordo invoke <agent> "<subtask prompt>"
   - Check credit balances with: coordo credit status
7. If only a human can unblock you (e.g. policy/budget approval), run: coordo decision add "<question>" --from ${agent} --to ${config.human}
   and stop WITHOUT marking the task done.
8. If you cannot finish, do not mark the task done; explain why in your final message.`;
}

export function decisionWorkerPrompt(decision: LedgerItem, agent: AgentName, root: string, config: LeadConfig): string {
  const profile = resolveProfile(config, agent);
  const standing = profile.instructions ? `\nSTANDING INSTRUCTIONS FOR ${agent}:\n${profile.instructions}\n` : "";
  return `You are ${agent}, an autonomous technical decision-maker dispatched headlessly by coordo-lead in the repository ${root}.
Your role on this team: ${profile.role}.
Nobody is watching this session live: make an autonomous technical decision based on the codebase to reduce human interference.
${standing}
DECISION NEEDED: ${decision.id} (from ${decision.from} to ${agent}):
<<<
${decision.body}
>>>

Protocol:
1. Inspect the codebase and consider the architecture, trade-offs, and alternatives.
2. If you need quick input from another agent, you can consult them:
   coordo consult <other_agent> "<specific question>" --from ${agent}
3. Formulate a definitive decision with explicit rationale and options considered.
4. Close this decision by running:
   coordo decision answer ${decision.id} "<your concise decision/answer>" --by ${agent} --rationale "<why this choice was made, trade-offs evaluated>" --options "<option A, option B>"
5. If only a human can answer (e.g. external legal or business approval), run:
   coordo decision add "<question>" --from ${agent} --to ${config.human}
   and stop WITHOUT marking ${decision.id} answered.`;
}

export function consultPrompt(question: string, caller: string, agent: AgentName, root: string, context?: string): string {
  return `You are ${agent}, consulted directly by peer agent ${caller} in the repository ${root}.
QUESTION FROM ${caller}:
<<<
${question}
>>>
${context ? `\nCONTEXT:\n<<<\n${context}\n>>>\n` : ""}

Provide a concise, direct consultation response:
1. Recommended approach or architectural direction.
2. Trade-offs and why this is preferred.
Be specific, reference actual codebase files or conventions, and conclude with actionable advice.`;
}

export function rawPrompt(prompt: string, agent: AgentName, root: string): string {
  return `You are ${agent}, dispatched headlessly by coordo-lead in the repository ${root}.
This repo coordinates agents through .coordo/ledger.md; run \`coordo status\` first for context.

${prompt}`;
}

export function verifyTaskBody(task: LedgerItem, verifier: AgentName, config: LeadConfig): string {
  const tests = config.testCommand ? `\`${config.testCommand}\`` : "the project's tests";
  return `${VERIFY_PREFIX}${task.id} (completed by ${task.to}; filed by coordo-lead)
Check ${task.to}'s work on ${task.id} against what that task asked for:
- Read ${task.id} and its done note in .coordo/ledger.md (Resolved / Log), then its commits: git log --grep "${task.id}" and git show.
- Run ${tests}, and check each claim in the done note against the code.
- If everything holds: mark this VERIFY task done with a note starting "PASS:" and the evidence.
- For each real defect: coordo task add "DEFECT in ${task.id}: <what is wrong, how to reproduce, which files>" --from ${verifier} --to ${task.to}
  then mark this VERIFY task done with a note starting "FAIL:" listing the DEFECT task ids.
Do not fix ${task.to}'s code yourself.`;
}

export function isVerifyTask(item: LedgerItem): boolean {
  return item.body.startsWith(VERIFY_PREFIX + "TASK-");
}

export function plannerPrompt(goal: string, config: LeadConfig, openItems: LedgerItem[]): string {
  const workers = config.agents.map((a) => `- ${a}: ${resolveProfile(config, a).role}`).join("\n");
  const verify = config.verifier
    ? `Every completed task is verified automatically by ${config.verifier}, so do not add separate review tasks.`
    : "No automatic verification runs, so include explicit acceptance checks in each task.";
  const open = openItems.length
    ? openItems.map((i) => `- ${i.id} (to ${i.to}): ${i.body.split("\n")[0].slice(0, 160)}`).join("\n")
    : "(none)";
  return `You are the PLANNER for coordo-lead, an autonomous multi-agent loop.
Break the GOAL below into at most ${config.maxPlannedTasks} atomic tasks for this repository, each assigned to exactly one worker.
Tasks run one at a time in the order you list them, so order them by dependency.

Workers and what each is best at:
${workers}

Rules:
- Read the repo first (README, CLAUDE.md / AGENTS.md, the relevant source) so every task names real files.
- Each description says what to change, which files, and the acceptance criteria that prove it works.
- Choose each worker by matching the task to the listed role. Coordo's model router separately selects a model for that worker's adapter; do not put model names in the plan.
- ${verify}
- Do not modify any files and do not run coordo commands - you only plan.
- If the goal is ambiguous in a way only a human can settle, return {"tasks": [], "question": "<the question>"}.

Open ledger items (do not duplicate them):
${open}

GOAL: ${goal}

Reply with ONLY one JSON object, no prose and no code fences:
{"tasks":[{"agent":"${config.agents.join("|")}","title":"<short title>","description":"<what, which files, acceptance criteria>"}]}`;
}
