# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for them. You can expect an acknowledgement within a few days; this is a small, volunteer-run project.

## Trust model

coordo coordinates AI agents that can edit files and run commands. It is not a sandbox.

- **`.coordo/lead.json` is executable configuration.** It can name binaries (`bin`, and the `command` adapter) that `coordo lead` and `coordo dispatch` will run. Treat it like a `Makefile`: don't run `coordo lead` in a repository you don't trust, and review changes to `lead.json` in pull requests.
- **The ledger is instructions.** Task and decision text is placed in agents' prompts. Anyone who can write to `.coordo/ledger.md` can steer your agents, which is a prompt-injection surface. Review ledger changes from outside contributors.
- **Agent permissions are yours to set.** Headless Claude runs with `acceptEdits` and an explicit `allowedTools` list; Codex runs in `workspace-write`; coordo never enables a mode that bypasses permissions or sandboxes. Anything you add to `allowedTools` or `args` widens what an unattended agent may do.
- **Run logs may contain sensitive text.** `.coordo/runs/` stores full prompts and agent transcripts. It ignores itself in git; keep it that way.
- **Don't scrape credentials.** For tools with no supported headless interface, coordo uses `handoff` rather than reaching into another application's internal tokens, and contributions should keep to that.

## Cloud viewer

The optional viewer can display private repositories' ledgers. Its `GITHUB_TOKEN` is for GitHub access, not viewer authentication, so deploy it behind Vercel Deployment Protection or another login. Use a fine-grained token with read-only Contents access to only the repositories you list.
