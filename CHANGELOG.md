# Changelog

## 0.4.1

- **Peer calls no longer report false success.** `dispatch`, `invoke` and `consult` now distinguish a real answer, a pending handoff and a failure, with exit codes 0, 3 and 1. Before, handing a prompt to a human, or merely starting an Antigravity conversation, reported success with exit 0. (TASK-057)
- **`consult --auto-decide` only resolves a decision with a real answer.** It used to record whatever came back, including "prompt written to ...", a crashed CLI's error text, an API error or an empty reply. On anything else it now records nothing.
- Nothing is charged when no agent ran. A failed `invoke` now says failed, not finished.

## 0.4.0

- **Autonomous agent-to-agent decisions in `coordo lead`.** Decisions addressed to enabled agents are dispatched autonomously to the recipient to deliberate and resolve with explicit rationale, bypassing human pauses unless addressed to a human.
- **Inter-agent invocation & consultation.** `coordo invoke <agent> "<prompt>"` allows agents to programmatically dispatch peer agents. `coordo consult <agent> "<question>"` supports direct technical deliberation with `--auto-decide`.
- **Credit & budget accounting.** Tracks compute/token expenditure across agents in `.coordo/state.json`, supports `coordo credit status`, `add`, `transfer`, `history`, and optional limit enforcement (`enforceLimits`).
- **Decision-making ledger.** Captures problem statements, options considered, trade-offs, and rationale with `coordo decision show <id>` and `coordo decision log`.

## 0.3.1

- **Mongo connection errors say what is wrong.** TLS alert 80 (every Atlas node dropping the handshake) now reports that this machine's public IP is most likely not on the Atlas Network Access list instead of "check cluster availability"; bad credentials name the agent and where its credential lives; timeouts and DNS failures get their own advice. Messages never echo hosts, URIs or IP addresses. (TASK-046)
- **The bundled Codex is found wherever ChatGPT.app keeps it.** Probes `Resources/codex-cli/bin/codex` and the older `Resources/codex` (also under `~/Applications`), requires an executable file, and when nothing is found says where it looked and that `codex.bin` in `.coordo/lead.json` fixes it. (TASK-021)
- **`coordo mongo sync` can no longer corrupt the ledger.** It skips stale archive copies of items Mongo already holds, refuses (writing nothing) when an archive entry reuses an ID for a different task, and decides everything before writing. (TASK-045)
- Test: the `lead --dry-run` assertion accepts the optional "routed" line that model-router adds.

## 0.3.0

- **Agent profiles.** `agents` in `.coordo/lead.json` can be an object of named profiles (`adapter`, `model`, `role`, `instructions`, …), so one tool can play several agents, such as an architect, a builder and a reviewer all running through Claude Code. The list form and built-in names work as before.
- **New adapters:** `command` (run any CLI) and `handoff` (a human relays the prompt).
- A team without `claude` now loads and runs unverified instead of failing on the default verifier; `coordo lead` says so.
- `coordo dispatch` and the planner accept any configured agent name; unknown names list the known ones.
- `coordo init` writes tool-neutral snippets: `AGENTS.md` (read by many tools) asks each agent to use its own name for `--as`.
- The cloud viewer no longer ships built-in repositories; set `COORDO_REPOS`.
- Packaging for public release: MIT license, `files`/`engines`/`repository` metadata, cross-platform build scripts, CI on Node 20 and 22, examples, and a rewritten README.

## 0.2.0

- `coordo lead`, `plan` and `dispatch`: plan a goal into ledger tasks, run agents headlessly, file VERIFY tasks, self-heal through DEFECT tasks.

## 0.1.0

- Shared ledger (`.coordo/ledger.md`), tasks, decisions, per-agent git checkpoints and digests, `init` snippets, and a read-only cloud viewer.
