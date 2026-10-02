export interface RepositoryConfig {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface ViewerItem {
  id: string;
  status: string;
  from: string;
  to: string;
  opened: string;
  body: string;
  summary: string;
}

export interface ParsedLedger {
  decisions: ViewerItem[];
  tasks: ViewerItem[];
}

const MAX_LEDGER_CHARS = 1_000_000;
const MAX_ITEMS = 500;
// No built-in repositories: the viewer shows only what COORDO_REPOS lists.
const NO_REPOSITORIES: RepositoryConfig[] = [];

function repository(id: string, label: string, owner: string, repo: string, branch = "main"): RepositoryConfig {
  return { id, label, owner, repo, branch };
}

function safeRepositoryPart(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) return null;
  return value;
}

function parseRepository(value: unknown, index: number): RepositoryConfig | null {
  if (typeof value === "string") {
    const [owner, repo] = value.split("/");
    if (!safeRepositoryPart(owner) || !safeRepositoryPart(repo)) return null;
    return repository(`${owner}-${repo}`, `${owner}/${repo}`, owner, repo);
  }

  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const owner = safeRepositoryPart(candidate.owner);
  const repo = safeRepositoryPart(candidate.repo);
  if (!owner || !repo) return null;

  const branch = safeRepositoryPart(candidate.branch) || "main";
  const id = safeRepositoryPart(candidate.id) || `${owner}-${repo}-${index}`;
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label.trim().slice(0, 120)
    : `${owner}/${repo}`;
  return repository(id, label, owner, repo, branch);
}

export function getConfiguredRepositories(raw = process.env.COORDO_REPOS): RepositoryConfig[] {
  if (!raw?.trim()) return NO_REPOSITORIES;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const configured = parsed.map(parseRepository).filter((item): item is RepositoryConfig => item !== null);
      if (configured.length > 0) return configured;
    }
  } catch {
    // Also accept a simple comma-separated owner/repo list for easy Vercel setup.
  }

  const configured = raw
    .split(",")
    .map((item, index) => parseRepository(item.trim(), index))
    .filter((item): item is RepositoryConfig => item !== null);
  return configured.length > 0 ? configured : NO_REPOSITORIES;
}

const ITEM_HEADER = /^###\s+\[((?:TASK|DEC)-\d+)\]\s*(.*)$/i;

function parseMetadata(rest: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const token of rest.split(/\s+/)) {
    const separator = token.indexOf(":");
    if (separator <= 0) continue;
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (value) metadata[key] = value.slice(0, 200);
  }
  return metadata;
}

function makeItem(id: string, rest: string, bodyLines: string[]): ViewerItem {
  const metadata = parseMetadata(rest);
  const body = bodyLines.join("\n").trim().slice(0, 20_000);
  const summary = body.split(/\r?\n/).map(line => line.trim()).find(Boolean) || "No description provided.";
  return {
    id: id.toUpperCase(),
    status: metadata.status || "open",
    from: metadata.from || "default",
    to: metadata.to || "default",
    opened: metadata.opened || "",
    body,
    summary: summary.slice(0, 280)
  };
}

/**
 * Parse hand-edited Coordo markdown defensively. Unknown sections and malformed
 * headers are ignored, while valid neighboring entries remain renderable.
 */
export function parseLedger(content: string): ParsedLedger {
  const decisions: ViewerItem[] = [];
  const tasks: ViewerItem[] = [];
  const lines = content.slice(0, MAX_LEDGER_CHARS).split(/\r?\n/);
  let section: "decisions" | "tasks" | "resolved" | "other" = "other";
  let current: { id: string; rest: string; body: string[] } | null = null;

  const flush = () => {
    if (!current || decisions.length + tasks.length >= MAX_ITEMS) {
      current = null;
      return;
    }
    const item = makeItem(current.id, current.rest, current.body);
    if (section === "decisions" && item.id.startsWith("DEC-")) decisions.push(item);
    if (section === "tasks" && item.id.startsWith("TASK-")) tasks.push(item);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      const heading = line.trim().toLowerCase();
      section = heading === "## decisions needed"
        ? "decisions"
        : heading === "## tasks"
          ? "tasks"
          : heading === "## resolved / log"
            ? "resolved"
            : "other";
      continue;
    }

    if (line.startsWith("### ")) {
      flush();
      const match = line.match(ITEM_HEADER);
      if (match) current = { id: match[1], rest: match[2], body: [] };
      continue;
    }

    if (current) current.body.push(line);
  }
  flush();
  return { decisions, tasks };
}
