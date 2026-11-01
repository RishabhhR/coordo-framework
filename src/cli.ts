#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { initializeProject } from "./template.js";
import { 
  parseLedger, 
  addDecision, 
  answerDecision, 
  addTask,
  resolveTask,
  migrateMongo,
  syncMongo,
  analyticsMongo
} from "./ledger.js";
import { readState, getCheckpoint, setCheckpoint } from "./state.js";
import { getGitHead, runGitDigest } from "./git.js";
import { loadLeadConfig, resolveProfile } from "./leadConfig.js";
import { dispatch } from "./agents.js";
import { isVerifyTask, rawPrompt, workerPrompt, consultPrompt } from "./prompts.js";
import { makePlan, writePlan } from "./planner.js";
import { runLead } from "./lead.js";
import { checkMongo, ensureMongoIndexes } from "./mongo.js";
import { routeModel } from "./modelRouter.js";
import { loadCredits, addCredits, transferCredits, checkCreditAvailable, deductCredits, estimateCost } from "./credits.js";
import { getDecisionRecord, listDecisionRecords, formatDecisionRecord, recordDeliberationTurn } from "./decisionLedger.js";

// Flags that never take a value, so `--dry-run "<goal>"` doesn't swallow the goal.
const BOOLEAN_FLAGS = new Set(["full", "dry-run", "wait", "allow-dirty", "auto-decide"]);

// Exit codes for `coordo lead` so scripts can tell why it stopped.
const LEAD_EXIT_CODES = { complete: 0, planned: 0, paused: 3, stuck: 4 } as const;

function findProjectRoot(): string {
  let curr = process.cwd();
  while (true) {
    if (existsSync(path.join(curr, ".git")) || existsSync(path.join(curr, ".coordo")) || existsSync(path.join(curr, "package.json"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) {
      return process.cwd();
    }
    curr = parent;
  }
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!BOOLEAN_FLAGS.has(name) && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[name] = args[i + 1];
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function formatAge(openedStr: string): string {
  try {
    const opened = new Date(openedStr);
    const diffMs = Date.now() - opened.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  } catch {
    return openedStr;
  }
}

function printHelp() {
  console.log(`
coordo — a shared ledger, credit manager, and autonomous dispatcher for multi-agent teams

Usage:
  coordo <command> [options]

Commands:
  init                                                    Initialize .coordo directory and snippet pointers.
  status                                                  Show open decisions, open task counts, and checkpoint status.
  task add "<description>" --from <name> --to <name>       Add a new open task.
  task list [--status open|done|all] [--to <name>]        List tasks.
  task done <id> [--note "<done note>"]                   Mark a task as completed.
  decision add "<question>" --from <name> --to <name>     Add a new decision question.
  decision answer <id> "<answer>" [--by <name>]           Answer an open decision question with optional rationale.
  decision list [--status open|resolved|all]              List decisions.
  decision show <id>                                      Show decision detail, rationale, and deliberation trail.
  decision log                                            Display audit log of agent decision-making.
  digest [--as <name>] [--full]                           Show Git logs or diffs since the caller's last checkpoint.
  checkpoint [--as <name>] [--ref <sha>]                  Record current HEAD (or custom ref) as caller's checkpoint.

Inter-agent communication & Invocation:
  invoke <agent> "<prompt>" [--task-id <id>] [--dry-run]  Programmatically invoke a peer agent headlessly.
  consult <agent> "<question>" [--from <caller>]          Consult a peer agent, deliberate, and record rationale.
                                                          Use --auto-decide to resolve into a ledger decision.

Credit & budget management:
  credit status                                           Show agent credit balances, limits, and total spent.
  credit add <agent|all> <amount> [--note <msg>]          Add credits to an agent or all agents.
  credit transfer <from> <to> <amount> [--note <msg>]     Transfer credits from one agent to another.
  credit history [--agent <name>]                         Show transaction ledger of credit deductions.

Autonomous lead (config: .coordo/lead.json, logs: .coordo/runs/):
  lead ["<goal>"] [--plan-file <json>] [--max-steps N] [--wait] [--allow-dirty] [--dry-run]
                                                          Plan the goal into ledger tasks, then run the agents until
                                                          every task and decision is closed and verified.
  plan "<goal>" [--plan-file <json>] [--dry-run]          Only plan: write the goal's tasks to the ledger.
  dispatch <agent> <TASK-ID|"prompt"> [--dry-run]
                                                          Run one agent headlessly on one task or prompt.

Storage backend:
  mongo migrate [--ledger-id <id>]                        Import the current Markdown ledger into Mongo once.
  mongo sync [--ledger-id <id>]                           Capture newer archive entries after migration.
  mongo analytics [--ledger-id <id>]                      Read aggregate health metrics from Mongo.
  mongo check [--ledger-id <id>]                          Run a read-only Mongo ping and report latency.
  mongo ensure-indexes [--ledger-id <id>]                 Create the Coordo indexes (explicit maintenance operation).
  mongo export [--out <file>]                            Explicitly export the Mongo ledger for backup.

Options:
  --as <name>        Assert caller identity (defaults to "default").
  --from <name>      Sender identity.
  --to <name>        Recipient identity.
  --status <val>     Filter by status (open, done, resolved, all).
  --note <msg>       Add a closure or transaction note.
  --rationale <msg>  Add explicit decision rationale.
  --options <opts>   Comma-separated list of options considered.
  --ref <sha>        Specify custom git SHA ref.
  --full             Show full git diff instead of summary stat logs.
  --auto-decide      Automatically allocate and resolve decision from consultation.
  --dry-run          Show what would run without executing or writing to disk.
  --wait             lead: when a human decision blocks the run, wait for the answer instead of exiting.
  --allow-dirty      lead: start even with uncommitted changes (they are committed with the first closed task).

Exit codes for lead: 0 complete, 3 paused on a human decision, 4 stuck (attempts or --max-steps used up).
`);
}

async function main() {
  const root = findProjectRoot();
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const identity = (flags.as ?? flags.from) as string | undefined;
  if (identity) process.env.COORDO_AGENT = identity;
  
  if (positionals.length === 0) {
    printHelp();
    return;
  }

  const cmd = positionals[0];

  try {
    switch (cmd) {
      case "init": {
        initializeProject(root);
        console.log("✅ Coordo project initialized successfully!");
        console.log("   .coordo/ledger.md   the shared ledger (commit it)");
        console.log("   CLAUDE.md, AGENTS.md  now tell Claude Code and AGENTS.md-aware tools to use it");
        console.log('\nNext: coordo task add "<what to build>" --from you --to <agent>');
        console.log("      coordo lead --dry-run   (to let agents run the open tasks; see .coordo/lead.json options in the README)");
        break;
      }

      case "status": {
        const ledger = await parseLedger(root);
        console.log("=== Coordo Status ===\n");
        console.log("💡 Decisions Needed:");
        if (ledger.decisionsNeeded.length === 0) {
          console.log("  No open decisions.");
        } else {
          for (const item of ledger.decisionsNeeded) {
            console.log(`\n### [${item.id}] status:${item.status} from:${item.from} to:${item.to} opened:${item.opened}`);
            console.log(item.body);
          }
        }

        console.log("\n📋 Open Tasks Count:");
        const counts: Record<string, number> = {};
        const openTasks = ledger.tasks.filter((t) => t.status === "open");
        for (const t of openTasks) {
          counts[t.to] = (counts[t.to] || 0) + 1;
        }
        if (openTasks.length === 0) {
          console.log("  No open tasks.");
        } else {
          for (const [to, count] of Object.entries(counts)) {
            console.log(`  to ${to}: ${count} open tasks`);
          }
        }

        console.log("\n📍 Checkpoints:");
        const state = readState(root);
        try {
          const head = getGitHead(root);
          console.log(`  Current git HEAD: ${head.slice(0, 7)}`);
          if (Object.keys(state.checkpoints).length === 0) {
            console.log("  No checkpoints recorded.");
          } else {
            for (const [as, sha] of Object.entries(state.checkpoints)) {
              const staleness = sha === head ? " (up to date)" : " (stale)";
              console.log(`  ${as}: ${sha.slice(0, 7)}${staleness}`);
            }
          }
        } catch (err) {
          const message = (err as Error).message;
          console.log(/unknown revision|ambiguous argument 'HEAD'|does not have any commits/.test(message)
            ? "  No commits yet: checkpoints start once the repo has its first commit."
            : `  Could not fetch Git checkpoints status: ${message}`);
        }
        break;
      }

      case "task": {
        const sub = positionals[1];
        if (sub === "add") {
          const desc = positionals[2];
          if (!desc) throw new Error("Missing task description.");
          const from = (flags.from as string) || "default";
          const to = (flags.to as string) || "default";
          const id = await addTask(root, desc, from, to);
          console.log(`✅ Allocated ${id} for new task.`);
        } else if (sub === "list") {
          const targetStatus = (flags.status as string) || "open";
          const targetTo = flags.to as string | undefined;
          const ledger = await parseLedger(root);
          
          let items = targetStatus === "open" 
            ? ledger.tasks.filter((t) => t.status === "open")
            : targetStatus === "done" 
              ? ledger.resolvedLog.filter(t => t.id.startsWith("TASK"))
              : [...ledger.tasks, ...ledger.resolvedLog.filter(t => t.id.startsWith("TASK"))];

          if (targetTo) {
            items = items.filter(t => t.to === targetTo);
          }

          if (items.length === 0) {
            console.log("No matching tasks found.");
          } else {
            for (const item of items) {
              const firstLine = item.body.split("\n")[0];
              console.log(`${item.id.padEnd(9)} status:${item.status.padEnd(9)} from:${item.from.padEnd(12)} to:${item.to.padEnd(12)} opened:${formatAge(item.opened).padEnd(10)} | ${firstLine}`);
            }
          }
        } else if (sub === "done") {
          const id = positionals[2];
          if (!id) throw new Error("Missing task ID (e.g. TASK-001).");
          const note = flags.note as string | undefined;
          await resolveTask(root, id, note);
          console.log(`✅ Marked task ${id} as done.`);
        } else {
          console.log("Unknown task command. Supported: add, list, done");
        }
        break;
      }

      case "decision": {
        const sub = positionals[1];
        if (sub === "add") {
          const question = positionals[2];
          if (!question) throw new Error("Missing decision question.");
          const from = (flags.from as string) || "default";
          const to = (flags.to as string) || "default";
          const context = flags.context as string | undefined;
          const id = await addDecision(root, question, from, to, context);
          console.log(`✅ Allocated ${id} for new decision.`);
        } else if (sub === "answer") {
          const id = positionals[2];
          const ans = positionals[3];
          if (!id || !ans) throw new Error("Usage: coordo decision answer <id> \"<answer>\" [--by <name>] [--rationale <msg>] [--options <opts>]");
          const by = flags.by as string | undefined;
          const rationale = flags.rationale as string | undefined;
          const rawOptions = flags.options as string | undefined;
          const options = rawOptions ? rawOptions.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
          const creditsCost = flags["credits-cost"] !== undefined ? Number(flags["credits-cost"]) : undefined;
          await answerDecision(root, id, ans, by, { rationale, options, creditsCost });
          console.log(`✅ Resolved decision ${id} with answer.`);
        } else if (sub === "show") {
          const id = positionals[2];
          if (!id) throw new Error("Usage: coordo decision show <id>");
          const record = getDecisionRecord(root, id);
          if (record) {
            console.log(formatDecisionRecord(record));
          } else {
            const ledger = await parseLedger(root);
            const item = [...ledger.decisionsNeeded, ...ledger.resolvedLog].find((d) => d.id === id);
            if (!item) throw new Error(`Decision ${id} not found.`);
            console.log(`=== Decision ${item.id} ===\nStatus: ${item.status}\nFrom: ${item.from} -> To: ${item.to}\nOpened: ${item.opened}\n\n${item.body}`);
          }
        } else if (sub === "log") {
          const records = listDecisionRecords(root);
          if (records.length === 0) {
            console.log("No decisions recorded in decision ledger.");
          } else {
            console.log("=== Autonomous Decision-Making Ledger ===\n");
            for (const r of records) {
              const rationaleSnippet = r.rationale ? ` | Rationale: ${r.rationale.slice(0, 70)}…` : "";
              const cost = r.creditsCost !== undefined ? ` [$${r.creditsCost.toFixed(3)}]` : "";
              console.log(`${r.id.padEnd(9)} [${r.status.padEnd(10)}] from:${r.from.padEnd(11)} to:${r.to.padEnd(11)}${cost} | ${r.question.split("\n")[0].slice(0, 50)}${rationaleSnippet}`);
            }
          }
        } else if (sub === "turn" || sub === "debate") {
          const id = positionals[2];
          const msg = positionals[3];
          if (!id || !msg) throw new Error('Usage: coordo decision turn <id> "<message>" --from <agent> [--role <proposer|respondent|critic>]');
          const from = (flags.from as string) || (flags.as as string) || "default";
          const role = flags.role as "proposer" | "respondent" | "critic" | "arbiter" | undefined;
          recordDeliberationTurn(root, id, { speaker: from, message: msg, role });
          console.log(`✅ Recorded deliberation turn on ${id} by ${from}.`);
        } else if (sub === "list") {
          const targetStatus = (flags.status as string) || "open";
          const ledger = await parseLedger(root);
          
          const items = targetStatus === "open"
            ? ledger.decisionsNeeded
            : targetStatus === "resolved"
              ? ledger.resolvedLog.filter(d => d.id.startsWith("DEC"))
              : [...ledger.decisionsNeeded, ...ledger.resolvedLog.filter(d => d.id.startsWith("DEC"))];

          if (items.length === 0) {
            console.log("No matching decisions found.");
          } else {
            for (const item of items) {
              const questionLine = item.body.split("\n")[0];
              console.log(`${item.id.padEnd(9)} status:${item.status.padEnd(9)} from:${item.from.padEnd(12)} to:${item.to.padEnd(12)} opened:${formatAge(item.opened).padEnd(10)} | ${questionLine}`);
            }
          }
        } else {
          console.log("Unknown decision command. Supported: add, list, show, log, turn, answer");
        }
        break;
      }

      case "digest": {
        const as = (flags.as as string) || "default";
        const full = !!flags.full;
        const sha = getCheckpoint(root, as);
        const digestText = runGitDigest(root, sha, full);
        console.log(digestText);
        break;
      }

      case "checkpoint": {
        const as = (flags.as as string) || "default";
        const refInput = flags.ref as string | undefined;
        const ref = refInput || getGitHead(root);
        setCheckpoint(root, as, ref);
        console.log(`✅ Recorded checkpoint for '${as}' at ${ref.slice(0, 7)}.`);
        break;
      }

      case "dispatch": {
        const agent = positionals[1];
        const target = positionals[2];
        if (!agent || !target) throw new Error('Usage: coordo dispatch <agent> <TASK-ID|"prompt"> [--dry-run]');
        const config = loadLeadConfig(root);
        const profile = resolveProfile(config, agent); // throws a helpful error for an unknown agent name
        let prompt: string;
        let routeTask = target;
        let routeContext = "";
        let taskId: string | undefined;
        if (/^TASK-\d+$/.test(target)) {
          const task = (await parseLedger(root)).tasks.find((t) => t.id === target);
          if (!task) throw new Error(`Open task ${target} not found.`);
          taskId = task.id;
          prompt = workerPrompt(task, agent, root, config);
          routeTask = isVerifyTask(task) ? `Review and verify ${task.body.split("\n")[0]}` : task.body.split("\n")[0];
          routeContext = task.body;
        } else {
          prompt = rawPrompt(target, agent, root);
        }
        const routing = config.modelRouter.enabled && !profile.model
          ? await routeModel(routeTask, routeContext, profile.adapter, config.modelRouter, { cwd: root })
          : undefined;
        const model = routing?.decision?.model;
        if (routing?.decision) {
          console.log(`model-router → ${routing.decision.provider}/${routing.decision.model} (${routing.decision.tier}; ${routing.decision.reasons.join("; ")})`);
        } else if (routing && "warning" in routing) {
          console.log(`model-router unavailable; using configured model for ${agent}: ${routing.warning}`);
        } else if (profile.model) {
          console.log(`model pinned by ${agent} profile: ${profile.model}`);
        }
        const result = await dispatch(agent, prompt, { root, config, taskId, model, dryRun: !!flags["dry-run"] });
        if (result.mode === "dry-run") {
          console.log(`Would run: ${result.summary}\n--- prompt ---\n${prompt}`);
          break;
        }
        console.log(`${result.ok ? "✅" : "❌"} ${agent} (${result.mode}) ${result.ok ? "finished" : "failed"}${result.costUsd !== undefined ? `, $${result.costUsd.toFixed(2)}` : ""}`);
        if (result.summary) console.log(result.summary);
        if (result.logPath) console.log(`Log: ${result.logPath}`);
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case "invoke": {
        const agent = positionals[1];
        const promptText = positionals[2];
        if (!agent || !promptText) throw new Error('Usage: coordo invoke <agent> "<prompt>" [--task-id <id>] [--from <caller>] [--dry-run]');
        const config = loadLeadConfig(root);
        const caller = (flags.from as string) || (flags.as as string) || "agent";
        
        if (config.credits?.enabled && config.credits?.enforceLimits) {
          const check = checkCreditAvailable(root, caller, 0.001, config);
          if (!check.ok) {
            throw new Error(`Caller '${caller}' has insufficient credits: ${check.balance.toFixed(3)} remaining.`);
          }
        }

        resolveProfile(config, agent);
        const prompt = rawPrompt(promptText, agent, root);
        const taskId = flags["task-id"] as string | undefined;

        console.log(`🤖 Invoking ${agent} (from ${caller})...`);
        const result = await dispatch(agent, prompt, { root, config, taskId, dryRun: !!flags["dry-run"] });

        if (result.mode === "dry-run") {
          console.log(`Would invoke ${agent}: ${result.summary}`);
          break;
        }

        const cost = estimateCost(result.durationMs, result.costUsd, config.credits?.costPerSecondEstimate);
        deductCredits(root, caller, cost, "invoke", taskId, `Invoked ${agent}`, config);

        console.log(`${result.ok ? "✅" : "❌"} ${agent} finished (${result.durationMs}ms, $${cost.toFixed(3)} credits)`);
        if (result.summary) console.log(`\n${result.summary}`);
        if (!result.ok) process.exitCode = 1;
        break;
      }

      case "consult": {
        const agent = positionals[1];
        const question = positionals[2];
        if (!agent || !question) throw new Error('Usage: coordo consult <agent> "<question>" [--from <caller>] [--context "<context>"] [--auto-decide] [--dry-run]');
        const config = loadLeadConfig(root);
        const caller = (flags.from as string) || (flags.as as string) || "peer";
        const context = flags.context as string | undefined;
        const autoDecide = !!flags["auto-decide"];

        if (config.credits?.enabled && config.credits?.enforceLimits) {
          const check = checkCreditAvailable(root, caller, 0.001, config);
          if (!check.ok) {
            throw new Error(`Caller '${caller}' has insufficient credits: ${check.balance.toFixed(3)} remaining.`);
          }
        }

        console.log(`💬 ${caller} consulting ${agent} on: "${question}"`);
        const prompt = consultPrompt(question, caller, agent, root, context);
        const result = await dispatch(agent, prompt, { root, config, dryRun: !!flags["dry-run"] });

        if (result.mode === "dry-run") {
          console.log(`Would consult ${agent}: ${result.summary}`);
          break;
        }

        const cost = estimateCost(result.durationMs, result.costUsd, config.credits?.costPerSecondEstimate);
        deductCredits(root, caller, cost, "consult", undefined, `Consultation with ${agent}`, config);

        if (autoDecide) {
          const decId = await addDecision(root, question, caller, agent, context);
          await answerDecision(root, decId, result.summary, agent, {
            rationale: `Direct autonomous consultation between ${caller} and ${agent}`,
            creditsCost: cost,
          });
          console.log(`\n✅ Recorded and answered decision ${decId} in ledger.`);
        }

        console.log(`\n=== Consultation Response from ${agent} ===`);
        console.log(result.summary);
        console.log(`\n(Cost: $${cost.toFixed(3)} credits | Duration: ${result.durationMs}ms)`);
        break;
      }

      case "credit": {
        const sub = positionals[1];
        const config = loadLeadConfig(root);
        if (sub === "status" || sub === "list" || !sub) {
          const state = loadCredits(root, config);
          console.log("=== Coordo Agent Credits ===\n");
          console.log(`Tracking: ${state.enabled ? "enabled" : "disabled"} | Limits Enforced: ${state.enforceLimits ? "yes" : "no"}\n`);
          console.log("Agent".padEnd(16) + "Balance".padEnd(14) + "Spent".padEnd(14) + "Limit".padEnd(14) + "Status");
          console.log("-".repeat(68));
          let totalSpent = 0;
          for (const [name, acc] of Object.entries(state.accounts)) {
            totalSpent += acc.spent;
            const status = acc.balance <= 0 ? "EXHAUSTED" : acc.balance < 5 ? "LOW" : "OK";
            console.log(
              name.padEnd(16) +
              `$${acc.balance.toFixed(2)}`.padEnd(14) +
              `$${acc.spent.toFixed(2)}`.padEnd(14) +
              (acc.limit !== undefined ? `$${acc.limit.toFixed(2)}` : "unlimited").padEnd(14) +
              status
            );
          }
          console.log("-".repeat(68));
          console.log(`Total Expended Across All Agents: $${totalSpent.toFixed(2)}`);
        } else if (sub === "add") {
          const target = positionals[2];
          const amountStr = positionals[3];
          if (!target || !amountStr) throw new Error("Usage: coordo credit add <agent|all> <amount> [--note <note>]");
          const amount = Number(amountStr);
          if (isNaN(amount) || amount <= 0) throw new Error("Amount must be a positive number.");
          const note = flags.note as string | undefined;
          const { balance } = addCredits(root, target, amount, note, config);
          console.log(`✅ Added ${amount.toFixed(2)} credits to '${target}'. New balance: $${balance.toFixed(2)}`);
        } else if (sub === "transfer") {
          const from = positionals[2];
          const to = positionals[3];
          const amountStr = positionals[4];
          if (!from || !to || !amountStr) throw new Error("Usage: coordo credit transfer <from> <to> <amount> [--note <note>]");
          const amount = Number(amountStr);
          if (isNaN(amount) || amount <= 0) throw new Error("Amount must be a positive number.");
          const note = flags.note as string | undefined;
          const res = transferCredits(root, from, to, amount, note, config);
          if (!res.ok) throw new Error(res.error);
          console.log(`✅ Transferred ${amount.toFixed(2)} credits from '${from}' ($${res.fromBalance.toFixed(2)}) to '${to}' ($${res.toBalance.toFixed(2)}).`);
        } else if (sub === "history") {
          const state = loadCredits(root, config);
          const filterAgent = (flags.agent as string) || positionals[2];
          let txs = state.transactions;
          if (filterAgent) txs = txs.filter((t) => t.agent === filterAgent);
          if (txs.length === 0) {
            console.log("No credit transactions recorded.");
          } else {
            console.log(`=== Credit Transactions (${txs.length}) ===\n`);
            for (const t of txs.slice(0, 30)) {
              const sign = t.amount < 0 ? "+" : "-";
              const amt = Math.abs(t.amount).toFixed(3);
              const ref = t.refId ? ` [${t.refId}]` : "";
              const note = t.note ? ` (${t.note})` : "";
              console.log(`${t.id.padEnd(8)} ${t.timestamp.slice(0, 16)} ${t.agent.padEnd(12)} ${sign}$${amt.padEnd(8)} bal:$${t.balanceAfter.toFixed(2)}${ref}${note}`);
            }
          }
        } else {
          console.log("Unknown credit command. Supported: status, add, transfer, history");
        }
        break;
      }

      case "mongo": {
        const sub = positionals[1];
        if (sub === "migrate") {
          const ledgerId = (flags["ledger-id"] as string) || "personal";
          const result = await migrateMongo(root, ledgerId);
          console.log(`✅ Migrated ${result.items} historical ledger items to Mongo ledger '${ledgerId}'.`);
        } else if (sub === "sync") {
          const ledgerId = (flags["ledger-id"] as string) || "personal";
          const result = await syncMongo(root, ledgerId);
          console.log(`✅ Added ${result.added} newer parsed ledger items to Mongo ledger '${ledgerId}' and refreshed its archive.${result.skipped ? ` Skipped ${result.skipped} stale archive copies of items Mongo already holds (Mongo is canonical).` : ""}`);
        } else if (sub === "analytics") {
          const ledgerId = (flags["ledger-id"] as string) || "personal";
          console.log(JSON.stringify(await analyticsMongo(ledgerId), null, 2));
        } else if (sub === "check") {
          const ledgerId = (flags["ledger-id"] as string) || "personal";
          const result = await checkMongo(ledgerId);
          console.log(`✅ Mongo reachable; ping ${result.roundTripMs}ms (ledger '${result.ledgerId}').`);
        } else if (sub === "ensure-indexes") {
          const ledgerId = (flags["ledger-id"] as string) || "personal";
          await ensureMongoIndexes(ledgerId);
          console.log(`✅ Coordo indexes ensured for ledger '${ledgerId}'.`);
        } else if (sub === "export") {
          const ledger = await parseLedger(root);
          const output = JSON.stringify(ledger, null, 2) + "\n";
          const out = flags.out as string | undefined;
          if (out) {
            const { writeFileSync } = await import("node:fs");
            const destination = path.resolve(out);
            writeFileSync(destination, output, "utf-8");
            console.log(`✅ Exported Mongo ledger to ${destination}.`);
          } else {
            process.stdout.write(output);
          }
        } else {
          console.log("Unknown mongo command. Supported: migrate, sync, analytics, check, ensure-indexes, export");
        }
        break;
      }

      case "plan": {
        const goal = positionals[1];
        const planFile = flags["plan-file"] as string | undefined;
        if (!goal && !planFile) throw new Error('Usage: coordo plan "<goal>" [--plan-file <json>] [--dry-run]');
        const config = loadLeadConfig(root);
        const plan = await makePlan(root, goal ?? `plan file ${planFile}`, config, planFile);
        plan.tasks.forEach((t, i) => console.log(`${i + 1}. [${t.agent}] ${t.title}\n   ${t.description.replace(/\n/g, "\n   ")}`));
        if (plan.question) console.log(`? ${plan.question}`);
        if (plan.modelRoute) console.log(`planner model-router → ${plan.modelRoute.provider}/${plan.modelRoute.model} (${plan.modelRoute.tier}; ${plan.modelRoute.reasons.join("; ")})`);
        else if (plan.modelRouteWarning) console.log(`planner model-router unavailable; using configured model: ${plan.modelRouteWarning}`);
        if (flags["dry-run"]) {
          console.log("\nDry run: nothing written to the ledger.");
          break;
        }
        const ids = await writePlan(root, goal ?? `plan file ${planFile}`, plan, "manual", config);
        console.log(`\n✅ Wrote ${ids.join(", ")} to the ledger.`);
        break;
      }

      case "lead":
      case "auto": {
        const config = loadLeadConfig(root);
        const maxSteps = flags["max-steps"] !== undefined ? Number(flags["max-steps"]) : undefined;
        if (maxSteps !== undefined && !(Number.isInteger(maxSteps) && maxSteps > 0)) {
          throw new Error("--max-steps must be a positive integer.");
        }
        const result = await runLead(root, config, {
          goal: positionals[1],
          planFile: flags["plan-file"] as string | undefined,
          dryRun: !!flags["dry-run"],
          wait: !!flags.wait,
          allowDirty: !!flags["allow-dirty"],
          maxSteps,
        });
        process.exitCode = LEAD_EXIT_CODES[result.outcome];
        break;
      }

      default: {
        console.log(`Unknown command: ${cmd}`);
        printHelp();
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
