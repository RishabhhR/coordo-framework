# Contributing

Thanks for helping. coordo is small on purpose: zero runtime dependencies, plain markdown as the data format, and tests that run the real CLI against fake agents.

## Setup

```bash
git clone https://github.com/RishabhhR/coordo-framework && cd coordo-framework
npm install
npm test            # builds, then runs tests/*.test.mjs with node:test
npm run install-local   # optional: make `coordo` on your PATH run this working copy
```

Node 20+ is required. Tests spend no tokens: `tests/lead.test.mjs` and `tests/profiles.test.mjs` replace real agents with fake CLIs that call the real `coordo` binary, and some tests skip themselves if `git` isn't usable.

## Making a change

- Add or update a test with every behaviour change. A good test should fail if you break the behaviour; try breaking it once.
- Keep zero runtime dependencies (`node:` built-ins only). `typescript` and `@types/node` are dev-only.
- Match the surrounding code's style and comment density.
- If you change `.coordo/lead.json` handling, update the config reference in the README and the files in `examples/` (a test loads every example through the real validator).

## Adding an adapter

An adapter turns a prompt into a process. In `src/agents.ts`:

1. Add the adapter name to `ADAPTERS` in `src/leadConfig.ts` and whatever profile keys it needs (validate them in `normalizeAgents`).
2. Write a pure `xCommand(profile, …)` that returns `{ bin, args, stdin }` (or `null` when the tool isn't available, which makes the agent fall back to `handoff`). It must not write files; dry-run relies on that.
3. Add a case to `dispatch()` for how to read its result. Completion is always decided by the ledger, never by the exit code.
4. Test it with a fake CLI in `tests/profiles.test.mjs`. In the README adapter table, say honestly whether it has been verified against the real tool.

If you cannot test an adapter against the real tool, say so in the PR rather than implying it works.

## Working with agents on this repo

This repo uses coordo to coordinate its own agents, so `CLAUDE.md` and `AGENTS.md` ask them to claim work on the ledger first. Human contributors can ignore that and open a normal pull request.

## Reporting bugs

Open an issue with the command you ran, your `.coordo/lead.json` (remove anything private), the output, and your OS and Node version. For security issues, see [SECURITY.md](SECURITY.md) instead.
