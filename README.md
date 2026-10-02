# Coordo Framework

**A shared, git-tracked ledger and an autonomous dispatcher that let several AI coding agents work on the same repo without you copy-pasting between them.**

This repository is the public architecture and reference implementation. It contains no personal project ledger or private Coordo history. Download it, install the CLI, and add it to any project you want multiple AI tools—or multiple roles inside one tool—to coordinate on.

Read the design first: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Use it to coordinate agents **across tools** (Claude Code, Codex, Antigravity, or any CLI) or **several roles inside one tool** (an `architect` on Opus, a `builder` on Sonnet and a `reviewer` on Haiku, all running through Claude Code).

```
you ──► coordo lead "add rate limiting to the API"
          │ plan: split the goal into ledger tasks, one per agent
          ▼
   .coordo/ledger.md  ◄── the only channel; plain markdown, committed to git
          │
          ├─► architect  (claude, opus)    writes the interface
          ├─► builder    (claude, sonnet)  implements it
          └─► reviewer   (claude, haiku)   verifies it, files DEFECT tasks on failure
```

## Why

Agents in different tools can't see each other's work. You end up relaying prompts by hand, and nobody can tell whether "done" was verified. coordo fixes this with two ideas:

1. **The ledger is the protocol.** Tasks and decisions live in `.coordo/ledger.md`, in git. A task is done only when an agent runs `coordo task done`, so progress is recorded and reviewable, never just claimed in chat.
2. **Every tool already reads a project instruction file.** `coordo init` adds a short pointer to `CLAUDE.md` and `AGENTS.md`, so agents check the ledger on their own. No daemon, no API between the tools.

## Install

Requires Node.js 20 or newer and git.

```bash
git clone https://github.com/RishabhhR/coordo-framework
cd coordo-framework
npm install          # installs dev tools and builds
npm install -g .     # puts `coordo` on your PATH
```

Check it works: `coordo --help`. Developed and tested on macOS, with CI configured for Linux; Windows is untested.

## Quickstart: manual mode (works with any tools)

```bash
cd your-project            # a git repo
coordo init                # creates .coordo/ledger.md and adds pointers to CLAUDE.md / AGENTS.md
git add -A && git commit -m "add coordo"

coordo task add "Add a /health endpoint with a test" --from you --to codex
coordo status              # open decisions first, then open tasks per agent, then checkpoints
```

Open Codex (or any agent) in the repo. Its instruction file tells it to run `coordo status`, claim work on the ledger, and close it with a verification note. When you come back:

```bash
coordo digest --as claude     # what changed since claude last checked
coordo task list --status all
```

You can also give two sessions of the *same* tool different names. Run one Claude Code session as `architect` and another as `builder` (each uses its own name for `--as` and `--from`) and they coordinate through the ledger exactly as two different tools would.

## Autonomous mode: `coordo lead`

`coordo lead` removes you from the relay. It plans a goal into ledger tasks, runs each agent headlessly on the task addressed to it, and keeps going until every task is closed and verified.

```bash
coordo lead "Add a multiply(a, b) helper with tests; npm test must pass"
coordo lead                        # no goal: drive the open agent tasks already on the ledger
coordo lead "<goal>" --dry-run     # show the plan and the commands; write nothing, run nothing
coordo plan "<goal>"               # only plan: write the tasks to the ledger
coordo dispatch codex TASK-012     # run one agent on one task (or on a quoted prompt)
```

How a run works:

1. **Plan.** `claude -p` (read-only tools) reads the repo and returns up to `maxPlannedTasks` tasks, each assigned to the agent whose role fits. `--plan-file plan.json` (`{"tasks":[{"agent","title","description"}]}`) skips the LLM, and is how you plan without Claude. An ambiguous goal becomes a decision for you instead.
2. **Dispatch.** Each step runs the oldest open in-scope task through its agent's adapter, with the task, the ledger protocol and your test command in the prompt.
3. **Check the ledger, not the exit code.** A task counts as done only when the agent ran `coordo task done <id>`. Otherwise it is retried (with the previous attempt's last message) up to `maxAttemptsPerTask`.
4. **The lead commits, agents don't.** Sandboxed agents (Codex's `workspace-write`) can't write `.git`, so the lead commits the plan and each closed task as `TASK-x: <title>`. It refuses to start if files other than the ledger have uncommitted changes (`--allow-dirty` overrides). Set `"commit": false` to have agents commit instead.
5. **Verify and self-heal.** When a non-verifier agent closes a task, the lead files `VERIFY TASK-x` for the verifier. A failed check becomes `DEFECT in TASK-x` tasks addressed back to the author, which the same loop picks up and verifies again.
6. **Humans only for real decisions.** An open decision addressed to anyone who isn't an agent pauses the run (exit code 3). Answer with `coordo decision answer`, then re-run, or pass `--wait` to keep the lead polling.

Exit codes: `0` complete, `3` paused for a human, `4` stuck (attempts or `--max-steps` used up). Every dispatch is logged under `.coordo/runs/` (git-ignored).

## Agents: across tools, or several in one

An **agent** is a *name* (what a ledger item is addressed to) backed by an *adapter* (how coordo runs it). Configure agents in `.coordo/lead.json`. Every key is optional.

**Across tools.** The default is the three built-in names, each running its own CLI:

```json
{ "agents": ["claude", "codex", "antigravity"], "verifier": "claude", "testCommand": "npm test" }
```

**Several agents inside one tool.** Make `agents` an object. Each profile picks an adapter, a model, a role and standing instructions:

```json
{
  "testCommand": "npm test",
  "verifier": "reviewer",
  "agents": {
    "architect": { "adapter": "claude", "model": "opus",   "role": "interfaces and schemas",  "instructions": "Do not implement feature code." },
    "builder":   { "adapter": "claude", "model": "sonnet", "role": "implementation" },
    "reviewer":  { "adapter": "claude", "model": "haiku",  "role": "tests and verification", "instructions": "Never fix the author's code yourself." }
  }
}
```

Tasks are then addressed `--to architect`, and the planner assigns work by each profile's `role`. Here the `reviewer` verifies everyone else's work, so the author never marks its own homework. More in [`examples/`](examples): a [one-tool team](examples/lead.one-tool-team.json), a [cross-tool team](examples/lead.cross-tool-team.json), and a [mixed team](examples/lead.mixed-team.json) that also shows `command` and `handoff` agents.

### Adapters

| Adapter | Runs | Status |
|---|---|---|
| `claude` | `claude -p` with an allowlist of tools and a budget cap | Verified live end to end, including three profiles on different models in one run (architect and reviewer on Haiku, builder on Sonnet: about $0.50 for a toy task) |
| `codex` | `codex exec --sandbox workspace-write` (on `PATH`, else the copy bundled in ChatGPT.app on macOS) | Verified live end to end |
| `antigravity` | `agentapi new-conversation`, **only** from a terminal inside Antigravity | Falls back to `handoff` elsewhere; the headless path is untested |
| `command` | Any CLI you describe: `bin`, `args` with `{prompt}`, `{promptFile}`, `{root}` placeholders, or the prompt on stdin | Covered by tests with fake CLIs only; not verified against any specific third-party tool |
| `handoff` | Nothing: writes the prompt to `.coordo/runs/…prompt.md`, notifies you, and waits for the task to close | Tested |

### Config reference

| Key | Default | Meaning |
|---|---|---|
| `agents` | `["claude","codex","antigravity"]` | Array of built-in names, or an object of `name → profile` |
| `verifier` | `"claude"` | Agent that reviews every other agent's work; `null` skips verification. Defaults to `null` if `claude` isn't on the team |
| `human` | `"human"` | Name agents address human decisions to |
| `testCommand` | `null` | What agents run to verify; also allowlisted for claude |
| `commit` | `true` | The lead commits each closed task |
| `maxSteps` / `maxAttemptsPerTask` / `maxPlannedTasks` | `8` / `2` / `6` | Loop limits |
| `runTimeoutMinutes` / `pollSeconds` | `45` / `15` | Per-dispatch timeout; how often to re-read the ledger while waiting |
| `claude`, `codex`, `antigravity` | see `src/leadConfig.ts` | Defaults shared by every agent on that adapter (`bin`, `model`, `allowedTools`, `maxBudgetUsd`, `sandbox`, …) |

A profile may set `adapter`, `role`, `instructions`, `model`, `bin`, `args`, and the adapter-specific keys above. Names must be lowercase letters, digits, `-` or `_`. Unknown adapters, a verifier that isn't on the team, or a `command` agent without `bin` are rejected with an explanation.

## The ledger

`.coordo/ledger.md` is plain markdown you can read and edit by hand:

```markdown
## Decisions Needed

### [DEC-001] status:open from:builder to:architect opened:2026-10-02T09:00Z
**Question:** Should rate limits be per-IP or per-token?

## Tasks

### [TASK-004] status:open from:lead to:builder opened:2026-10-02T09:05Z
Implement the limiter in src/limiter.ts against the interface in src/types.ts. Acceptance: npm test passes.
```

Closing a task moves it to `## Resolved / Log` with the agent's note. Because it is in git, the history of who decided and verified what comes for free.

## Commands

```
coordo init                                  scaffold .coordo/ and inject the instruction-file snippets
coordo status                                open decisions (never truncated), task counts, checkpoint staleness
coordo task add "<desc>" --from <n> --to <n> | list [--status open|done|all] [--to <n>] | done <id> [--note "..."]
coordo decision add "<question>" --from <n> --to <n> [--context "..."] | answer <id> "<answer>" [--by <n>] | list
coordo digest --as <name> [--full]           what changed in git since your last checkpoint
coordo checkpoint --as <name> [--ref <sha>]  record HEAD as your checkpoint
coordo lead | plan | dispatch                see above
```

## Trust model and safety

- **Treat `.coordo/lead.json` and the ledger as executable input**, like a `Makefile` or `package.json` scripts. `lead.json` can name binaries to run, and the ledger text is fed to agents as instructions. Only run `coordo lead` in repositories you trust.
- coordo never uses a mode that bypasses permissions or sandboxes. Headless Claude runs with `acceptEdits` and an explicit tool allowlist, and Codex runs in `workspace-write`. Widen `allowedTools` deliberately.
- Each run is capped (`maxSteps`, `maxAttemptsPerTask`, `maxBudgetUsd`, timeouts). Run logs in `.coordo/runs/` can contain whole prompts and transcripts, so that folder ignores itself in git.
- coordo does not sandbox the agents or review their work for you. Read what lands in your history.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Optional: cloud viewer

A small read-only Vercel app (`public/index.html`, `api/ledgers.ts`) shows open work across several repos from other devices. It reads each `.coordo/ledger.md` through the GitHub API; ledger data stays in git and nothing is written. Set `COORDO_REPOS` (`owner/repo,owner/other`, or JSON with labels and branches) and, for private repos, an encrypted read-only `GITHUB_TOKEN`. **Put the deployment behind Vercel Deployment Protection or other authentication first.** `GITHUB_TOKEN` is not viewer authentication, and the viewer shows private ledgers.

## Limitations

- The lead is **sequential**: one agent at a time in one working tree. Parallel agents (git worktrees) are not implemented.
- Planning needs the `claude` CLI. Without it, write the plan yourself with `--plan-file`.
- Desktop notifications are macOS only; elsewhere the lead rings the terminal bell.
- The ledger is a markdown file with no locking, so two agents writing at the same moment can drop an entry. Write sequentially and check that your entry persisted. `coordo lead` runs agents one at a time, which avoids it.

## Development

```bash
npm install
npm test          # builds, then runs the node:test suites (real CLI, fake agents, no tokens spent)
npm run install-local   # symlink your working copy as `coordo`
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
