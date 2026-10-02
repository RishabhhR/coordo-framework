# Changelog

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
