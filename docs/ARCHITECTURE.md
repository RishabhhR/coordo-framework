# Coordo Framework Architecture

Coordo is a local coordination layer for AI agents working in one Git repository. It does not try to replace Claude Code, Codex, Antigravity, or another agent runtime. It gives them a shared protocol for ownership, handoffs, decisions, verification, and checkpoints.

## The core idea

The repository is the shared workspace and Git is the audit trail. Coordo adds one small, human-readable ledger at `.coordo/ledger.md`:

```text
                one project repository
                         |
                 .coordo/ledger.md
             tasks, decisions, checkpoints
                         |
        +----------------+----------------+
        |                |                |
     Claude           Codex         Antigravity
     adapter          adapter          adapter
        |                |                |
        +--------- other CLI adapters --+
                         |
                  same working tree
```

The ledger is the coordination channel. There is no required daemon, hosted database, or vendor-specific API between tools.

## Two supported topologies

### 1. Agents across different tools

Use the built-in adapter names when each role lives in a different tool:

```json
{
  "agents": ["claude", "codex", "antigravity"],
  "verifier": "claude",
  "testCommand": "npm test"
}
```

Tasks can be addressed explicitly:

```bash
coordo task add "Define the API contract" --from lead --to codex
coordo task add "Implement the endpoint" --from lead --to antigravity
coordo task add "Run the test suite and review the diff" --from lead --to claude
```

Each agent reads the same ledger from the same checkout, so the handoff is visible without copying prompts between applications.

### 2. Several roles inside one tool

Use named profiles when multiple sessions of one tool should behave differently:

```json
{
  "testCommand": "npm test",
  "verifier": "reviewer",
  "agents": {
    "architect": {
      "adapter": "claude",
      "model": "opus",
      "role": "interfaces, schemas and module boundaries",
      "instructions": "Do not implement feature code."
    },
    "builder": {
      "adapter": "claude",
      "model": "sonnet",
      "role": "feature implementation"
    },
    "reviewer": {
      "adapter": "claude",
      "model": "haiku",
      "role": "tests, code review and verification",
      "instructions": "Report defects; do not silently rewrite the author's code."
    }
  }
}
```

The ledger addresses `architect`, `builder`, and `reviewer`, not the underlying CLI. This name-to-adapter separation is what lets one tool host several roles with different models and instructions.

## Runtime layers

```text
CLI (`src/cli.ts`)
  |
  +-- Ledger layer (`src/ledger.ts`)
  |     Markdown parser, task/decision IDs, status transitions
  |
  +-- State layer (`src/state.ts`)
  |     Local per-agent checkpoints in `.coordo/state.json`
  |
  +-- Git layer (`src/git.ts`)
  |     Digest, checkpoint, clean-tree and commit operations
  |
  +-- Profile layer (`src/leadConfig.ts`)
  |     Agent names, adapters, models, roles and validation
  |
  +-- Dispatch layer (`src/agents.ts`)
  |     Claude, Codex, Antigravity, generic command and handoff adapters
  |
  +-- Lead layer (`src/lead.ts`)
        Plan -> dispatch -> ledger completion -> verify -> defect/self-heal
```

### Ledger layer

The ledger is intentionally plain Markdown. People can inspect and edit it without a special viewer. `coordo task done` moves a task into the resolved log with a note, making the claim and its evidence part of Git history.

### Profile layer

An agent has two identities:

- **Name:** the address used in ledger entries, such as `architect` or `reviewer`.
- **Adapter:** the process runner, such as `claude`, `codex`, `antigravity`, `command`, or `handoff`.

This keeps role design independent from a specific provider. Profiles may also set model, role, standing instructions, binary, permission mode, tool allowlist, sandbox, and budget.

### Dispatch layer

Adapters are deliberately thin. They convert a prompt into a process invocation and return output. Completion is not inferred from an exit code; the lead re-reads the ledger and requires the agent to close the task.

The generic `command` adapter supports `{prompt}`, `{promptFile}`, and `{root}` substitutions, or sends the prompt on stdin when no prompt placeholder is used. The `handoff` adapter is the safe fallback when a tool has no supported headless CLI.

### Lead layer

`coordo lead` is a sequential state machine:

```text
goal / existing ledger
          |
       planner
          |
    scoped open tasks
          |
       dispatcher
          |
     agent process
          |
  task done on ledger?
       /          \
     no            yes
     |              |
 retry / stop   commit + VERIFY
                       |
                PASS or DEFECT
```

The lead can pause for human decisions, cap steps and attempts, refuse unrelated dirty work before committing, and file verification or defect tasks. The default is one agent at a time in one working tree; parallel worktrees are intentionally outside this reference implementation.

## Safety model

Coordo is a coordination layer, not a sandbox. Users remain responsible for the tools they authorize.

- Review `.coordo/lead.json` before running automation; it names executables and permissions.
- Treat ledger text as instructions that can steer agents. Review changes from untrusted contributors.
- Keep Claude's tool allowlist and Codex's sandbox narrow.
- Keep run logs out of Git; they can contain prompts and transcripts.
- Use `handoff` when a tool has no supported headless interface; do not scrape internal application tokens.
- Keep the local ledger and Git history as the source of truth. Any optional cloud viewer should be read-only.

## Extension points

To add an adapter:

1. Add its name to `ADAPTERS` and validate the profile keys.
2. Implement a pure command builder in `src/agents.ts`.
3. Define how output and completion are read.
4. Add fake-CLI tests in `tests/profiles.test.mjs`.
5. Document whether the real tool was tested.

To add a role:

1. Add a profile under `agents` in `.coordo/lead.json`.
2. Give it a narrow role and explicit standing instructions.
3. Address ledger tasks to that name.
4. Keep a separate reviewer when the change warrants independent verification.

## What Coordo is not

- It is not an LLM provider or model router.
- It is not a remote task database.
- It is not a permission bypass.
- It is not a guarantee that an agent's edits are safe.
- It is not a parallel build system; the lead currently serializes work in one checkout.

That small scope is intentional: the framework makes multi-agent collaboration legible and repeatable while leaving model choice, authorization, source control, and deployment authority with the user and their tools.
