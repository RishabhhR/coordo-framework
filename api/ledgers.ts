import { getConfiguredRepositories, parseLedger, type RepositoryConfig } from "../src/viewer.js";

interface VercelRequest {
  method?: string;
}

interface VercelResponse {
  setHeader(name: string, value: string): VercelResponse;
  status(code: number): VercelResponse;
  json(value: unknown): void;
  end(): void;
}

interface RepositoryView {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  ledgerUrl: string;
  status: "ok" | "unavailable";
  error?: string;
  decisions: ReturnType<typeof parseLedger>["decisions"];
  tasks: ReturnType<typeof parseLedger>["tasks"];
}

function githubLedgerUrl(repository: RepositoryConfig): string {
  return `https://github.com/${repository.owner}/${repository.repo}/blob/${repository.branch}/.coordo/ledger.md`;
}

async function fetchLedger(repository: RepositoryConfig, token: string | undefined): Promise<RepositoryView> {
  const ledgerUrl = githubLedgerUrl(repository);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/.coordo/ledger.md?ref=${encodeURIComponent(repository.branch)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "coordo-cloud-viewer"
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      const error = response.status === 401 || response.status === 403
        ? "GitHub access denied."
        : response.status === 404
          ? "Ledger not found."
          : response.status === 429
            ? "GitHub rate limit reached."
            : "Ledger unavailable.";
      return {
        ...repository,
        ledgerUrl,
        status: "unavailable",
        error,
        decisions: [],
        tasks: []
      };
    }

    const payload = await response.json() as { content?: unknown; encoding?: unknown };
    if (payload.encoding !== "base64" || typeof payload.content !== "string" || payload.content.length > 1_500_000) {
      throw new Error("Unexpected GitHub contents response.");
    }
    const content = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
    const parsed = parseLedger(content);
    return { ...repository, ledgerUrl, status: "ok", ...parsed };
  } catch {
    return {
      ...repository,
      ledgerUrl,
      status: "unavailable",
      error: "Ledger unavailable.",
      decisions: [],
      tasks: []
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const repositories = getConfiguredRepositories();
  const token = process.env.GITHUB_TOKEN?.trim();
  const results = await Promise.all(repositories.map(repository => fetchLedger(repository, token)));
  res.status(200).json({ generatedAt: new Date().toISOString(), repositories: results });
}
