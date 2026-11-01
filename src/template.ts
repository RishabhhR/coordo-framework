import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const LEDGER_TEMPLATE = `# Coordo Ledger

> Shared coordination ledger for the AI agents (and humans) working on this repo.
> Edit directly, or use the \`coordo\` CLI. Keep entries terse; link to files/commits for detail.

## Decisions Needed

## Tasks

## Resolved / Log
`;

const SNIPPET_MARKER_START = "<!-- coordo:start -->";
const SNIPPET_MARKER_END = "<!-- coordo:end -->";

// agentName is the identity to use for --as/--from. CLAUDE.md is only read by
// Claude Code, so it can say "claude"; AGENTS.md is read by many tools (Codex,
// Antigravity, Cursor, ...), so it asks each reader to use its own name.
function buildSnippet(agentName: string | null): string {
  const identity = agentName
    ? `You are \`${agentName}\`: use that name for \`--as\` and \`--from\`.`
    : "Use your own agent name for \`--as\` and \`--from\` (for example \`codex\`, \`antigravity\`, or the role name you were given, such as \`reviewer\`).";
  const as = agentName ?? "<your-agent-name>";
  return `${SNIPPET_MARKER_START}
## Multi-Agent Coordination (coordo)
Several AI agents work on this project, in different tools or as different roles inside one tool. They coordinate through Coordo. ${identity}

At the start of a session:
1. Run \`coordo status --as ${as}\` — leads with any open decisions blocking work.
2. Run \`coordo digest --as ${as}\` — shows what changed since you last checked.

If \`.coordo/config.json\` says \`\"backend\": \"mongo\"\`, Mongo is the canonical private ledger. Do not edit \`.coordo/ledger.md\` directly or commit coordination entries; it is a read-only migration archive. Use the CLI with your explicit identity (\`--as\` / \`--from\`) for all task and decision writes. Never print, log, commit, paste, or deploy Mongo credentials. If Mongo is unavailable, stop and report the blocker rather than falling back to local ledger writes. In Git-backed projects without that config, use \`coordo task\` / \`coordo decision\` as usual.

**Development protocol (ledger-first, always):**
1. **Before writing any code**, add a \`coordo task\` describing the piece you intend to build, which files it touches, and your approach — after first checking it is actually doable (read the relevant code). If \`coordo status\` shows another agent already claimed an overlapping task, pick something else or raise a \`coordo decision\` instead of duplicating.
2. In Git-backed mode, commit the ledger claim to git **before** starting the code change. In Mongo mode, the CLI write is the claim; do not edit or commit the archive.
3. Do the work; commit the code referencing the task id (e.g. "TASK-007: ...").
4. Mark it \`coordo task done <id> --note "..."\` with what changed, which files, and how it was verified.
5. **Review other agents' completed work**: when \`coordo digest --as ${as}\` shows their commits, read the diff, and record the review outcome as a note or a new task/decision if you find problems. Don't silently rewrite their code — raise a decision first.

Before ending a session (or after a handoff-worthy change), run \`coordo checkpoint --as ${as}\`. Checkpoints and \`digest\` remain Git history metadata; task and decision state comes from the configured backend.
${SNIPPET_MARKER_END}`;
}

export function injectSnippet(filePath: string, agentName: string | null): void {
  const snippet = buildSnippet(agentName);
  let content = "";
  if (existsSync(filePath)) {
    content = readFileSync(filePath, "utf-8");
  }

  const startIdx = content.indexOf(SNIPPET_MARKER_START);
  const endIdx = content.indexOf(SNIPPET_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing snippet block in place
    content = content.slice(0, startIdx) + snippet + content.slice(endIdx + SNIPPET_MARKER_END.length);
  } else {
    // Append snippet block to end of file
    if (content && !content.endsWith("\n")) content += "\n";
    content += "\n" + snippet + "\n";
  }

  writeFileSync(filePath, content, "utf-8");
}

export function initializeProject(projectRoot: string): void {
  const coordoDir = path.join(projectRoot, ".coordo");
  if (!existsSync(coordoDir)) {
    mkdirSync(coordoDir, { recursive: true });
  }

  const ledgerPath = path.join(coordoDir, "ledger.md");
  if (!existsSync(ledgerPath)) {
    writeFileSync(ledgerPath, LEDGER_TEMPLATE, "utf-8");
  }

  // Update gitignore
  const gitignorePath = path.join(projectRoot, ".gitignore");
  let gitignoreContent = "";
  if (existsSync(gitignorePath)) {
    gitignoreContent = readFileSync(gitignorePath, "utf-8");
  }
  if (!gitignoreContent.includes(".coordo/state.json")) {
    if (gitignoreContent && !gitignoreContent.endsWith("\n")) gitignoreContent += "\n";
    gitignoreContent += ".coordo/state.json\n";
    writeFileSync(gitignorePath, gitignoreContent, "utf-8");
  }

  // Inject snippets into CLAUDE.md and AGENTS.md
  injectSnippet(path.join(projectRoot, "CLAUDE.md"), "claude");
  injectSnippet(path.join(projectRoot, "AGENTS.md"), null);
}
