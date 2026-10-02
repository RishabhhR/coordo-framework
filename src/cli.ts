#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { initializeProject } from "./template.js";
import { 
  parseLedger, 
  addDecision, 
  answerDecision, 
  addTask, 
  resolveTask 
} from "./ledger.js";
import { readState, getCheckpoint, setCheckpoint } from "./state.js";
import { getGitHead, runGitDigest } from "./git.js";
import { loadLeadConfig, resolveProfile } from "./leadConfig.js";
import { dispatch } from "./agents.js";
import { rawPrompt, workerPrompt } from "./prompts.js";
import { makePlan, writePlan } from "./planner.js";
import { runLead } from "./lead.js";

// Flags that never take a value, so `--dry-run "<goal>"` doesn't swallow the goal.
const BOOLEAN_FLAGS = new Set(["full", "dry-run", "wait", "allow-dirty"]);

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
coordo — a shared ledger and dispatcher that lets several AI coding agents work on one repo

Usage:
  coordo <command> [options]

Commands:
  init                                                    Initialize .coordo directory and snippet pointers.
  status                                                  Show open decisions, open task counts, and checkpoint status.
  task add "<description>" --from <name> --to <name>       Add a new open task.
  task list [--status open|done|all] [--to <name>]        List tasks.
  task done <id> [--note "<done note>"]                   Mark a task as completed.
  decision add "<question>" --from <name> --to <name>     Add a new decision question.
  decision answer <id> "<answer>" [--by <name>]           Answer an open decision question.
  decision list [--status open|resolved|all]              List decisions.
  digest [--as <name>] [--full]                           Show Git logs or diffs since the caller's last checkpoint.
  checkpoint [--as <name>] [--ref <sha>]                  Record current HEAD (or custom ref) as caller's checkpoint.

Autonomous lead (config: .coordo/lead.json, logs: .coordo/runs/):
  lead ["<goal>"] [--plan-file <json>] [--max-steps N] [--wait] [--allow-dirty] [--dry-run]
                                                          Plan the goal into ledger tasks, then run the agents until
                                                          every task is closed and verified. Without a goal, drives
                                                          the open tasks already on the ledger. Alias: auto.
  plan "<goal>" [--plan-file <json>] [--dry-run]          Only plan: write the goal's tasks to the ledger.
  dispatch <agent> <TASK-ID|"prompt"> [--dry-run]
                                                          Run one agent headlessly on one task or prompt.

Options:
  --as <name>      Assert caller identity (defaults to "default").
  --from <name>    Sender identity.
  --to <name>      Recipient identity.
  --status <val>   Filter by status (open, done, resolved, all).
  --note <msg>     Add a closure note.
  --ref <sha>      Specify custom git SHA ref.
  --full           Show full git diff instead of summary stat logs.
  --dry-run        Show what lead/plan/dispatch would do without writing the ledger or running agents.
  --wait           lead: when a human decision blocks the run, wait for the answer instead of exiting.
  --allow-dirty    lead: start even with uncommitted changes (they are committed with the first closed task).

Exit codes for lead: 0 complete, 3 paused on a human decision, 4 stuck (attempts or --max-steps used up).
`);
}

async function main() {
  const root = findProjectRoot();
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  
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
        const ledger = parseLedger(root);
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
        for (const t of ledger.tasks) {
          counts[t.to] = (counts[t.to] || 0) + 1;
        }
        if (ledger.tasks.length === 0) {
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
          const id = addTask(root, desc, from, to);
          console.log(`✅ Allocated ${id} for new task.`);
        } else if (sub === "list") {
          const targetStatus = (flags.status as string) || "open";
          const targetTo = flags.to as string | undefined;
          const ledger = parseLedger(root);
          
          let items = targetStatus === "open" 
            ? ledger.tasks 
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
          resolveTask(root, id, note);
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
          const id = addDecision(root, question, from, to, context);
          console.log(`✅ Allocated ${id} for new decision.`);
        } else if (sub === "answer") {
          const id = positionals[2];
          const ans = positionals[3];
          if (!id || !ans) throw new Error("Usage: coordo decision answer <id> \"<answer>\" [--by <name>]");
          const by = flags.by as string | undefined;
          answerDecision(root, id, ans, by);
          console.log(`✅ Resolved decision ${id} with answer.`);
        } else if (sub === "list") {
          const targetStatus = (flags.status as string) || "open";
          const ledger = parseLedger(root);
          
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
          console.log("Unknown decision command. Supported: add, list, answer");
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
        resolveProfile(config, agent); // throws a helpful error for an unknown agent name
        let prompt: string;
        let taskId: string | undefined;
        if (/^TASK-\d+$/.test(target)) {
          const task = parseLedger(root).tasks.find((t) => t.id === target);
          if (!task) throw new Error(`Open task ${target} not found.`);
          taskId = task.id;
          prompt = workerPrompt(task, agent, root, config);
        } else {
          prompt = rawPrompt(target, agent, root);
        }
        const result = await dispatch(agent, prompt, { root, config, taskId, dryRun: !!flags["dry-run"] });
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

      case "plan": {
        const goal = positionals[1];
        const planFile = flags["plan-file"] as string | undefined;
        if (!goal && !planFile) throw new Error('Usage: coordo plan "<goal>" [--plan-file <json>] [--dry-run]');
        const config = loadLeadConfig(root);
        const plan = await makePlan(root, goal ?? `plan file ${planFile}`, config, planFile);
        plan.tasks.forEach((t, i) => console.log(`${i + 1}. [${t.agent}] ${t.title}\n   ${t.description.replace(/\n/g, "\n   ")}`));
        if (plan.question) console.log(`? ${plan.question}`);
        if (flags["dry-run"]) {
          console.log("\nDry run: nothing written to the ledger.");
          break;
        }
        const ids = writePlan(root, goal ?? `plan file ${planFile}`, plan, "manual", config);
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
