import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";

// ---- Concurrency lock (fixes the read-modify-write race that silently dropped entries) ----
// Zero-dependency mutex via O_EXCL lockfile. Every mutating op runs its full
// parse -> modify -> serialize under this lock, so two concurrent `coordo` processes
// can't both read the same ledger and clobber each other's append.
function withLock<T>(projectRoot: string, fn: () => T): T {
  const lockPath = path.join(projectRoot, ".coordo", "ledger.lock");
  const start = Date.now();
  const TIMEOUT_MS = 15000;
  const STALE_MS = 60000;
  let fd: number | undefined;
  while (true) {
    try {
      fd = openSync(lockPath, "wx"); // atomic create-if-not-exists
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Lock is held. Reclaim it if it's stale (a previous process died mid-op).
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) { unlinkSync(lockPath); continue; }
      } catch { /* lock vanished between checks; loop and retry */ }
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error(`Could not acquire coordo ledger lock after ${TIMEOUT_MS}ms. If no other coordo process is running, delete ${lockPath}.`);
      }
      // Synchronous sleep (20-50ms jitter) without busy-spinning.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

// ---- Body sanitization (fixes markdown-header forgery from user/agent-supplied text) ----
// A body line beginning with "## " or "### " would be re-parsed as a new section or
// item header, letting task/decision text forge phantom ledger entries. Escape any
// leading run of >=2 '#' with a backslash: markdown still renders it as '#'s, but
// line.startsWith("## "/"### ") no longer matches, so it stays inert data.
function sanitizeBody(text: string): string {
  return (text ?? "").replace(/^(#{2,})(\s)/gm, "\\$1$2");
}

// ---- Conflict-marker detection (fixes coordo silently parsing a git-conflicted ledger) ----
function assertNoConflictMarkers(content: string, ledgerPath: string): void {
  if (/^(<{7}|={7}|>{7})(\s|$)/m.test(content)) {
    throw new Error(
      `Ledger at ${ledgerPath} contains unresolved git conflict markers (<<<<<<< / ======= / >>>>>>>). ` +
      `Resolve the merge conflict before running coordo, or entries may be read incorrectly.`
    );
  }
}

export interface LedgerItem {
  id: string;
  status: string;
  from: string;
  to: string;
  opened: string;
  metadata: Record<string, string>;
  body: string;
}

export interface Ledger {
  decisionsNeeded: LedgerItem[];
  tasks: LedgerItem[];
  resolvedLog: LedgerItem[];
  intro: string;
}

const HEADER_REGEX = /^###\s+\[([A-Z]+-\d+)\]\s+(.+)$/;

export function parseLedger(projectRoot: string): Ledger {
  const ledgerPath = path.join(projectRoot, ".coordo", "ledger.md");
  if (!existsSync(ledgerPath)) {
    throw new Error(`Ledger file not found at ${ledgerPath}. Run 'coordo init' first.`);
  }

  const content = readFileSync(ledgerPath, "utf-8");
  assertNoConflictMarkers(content, ledgerPath);
  const lines = content.split(/\r?\n/);

  const decisionsNeeded: LedgerItem[] = [];
  const tasks: LedgerItem[] = [];
  const resolvedLog: LedgerItem[] = [];
  let introLines: string[] = [];

  let currentSection: "intro" | "decisions" | "tasks" | "resolved" = "intro";
  let currentItem: LedgerItem | null = null;
  let currentItemBodyLines: string[] = [];

  const flushCurrentItem = () => {
    if (currentItem) {
      currentItem.body = currentItemBodyLines.join("\n").trim();
      if (currentSection === "decisions") decisionsNeeded.push(currentItem);
      else if (currentSection === "tasks") tasks.push(currentItem);
      else if (currentSection === "resolved") resolvedLog.push(currentItem);
      currentItem = null;
      currentItemBodyLines = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (line.startsWith("## ")) {
      flushCurrentItem();
      if (trimmed === "## Decisions Needed") {
        currentSection = "decisions";
      } else if (trimmed === "## Tasks") {
        currentSection = "tasks";
      } else if (trimmed === "## Resolved / Log") {
        currentSection = "resolved";
      } else {
        introLines.push(line);
      }
      continue;
    }

    if (line.startsWith("### ")) {
      flushCurrentItem();
      const match = line.match(HEADER_REGEX);
      if (match) {
        const id = match[1];
        const rest = match[2];
        const tags = rest.split(/\s+/);
        const metadata: Record<string, string> = {};
        for (const tag of tags) {
          const colonIdx = tag.indexOf(":");
          if (colonIdx !== -1) {
            const key = tag.slice(0, colonIdx);
            const value = tag.slice(colonIdx + 1);
            metadata[key] = value;
          }
        }

        currentItem = {
          id,
          status: metadata.status || "open",
          from: metadata.from || "default",
          to: metadata.to || "default",
          opened: metadata.opened || new Date().toISOString(),
          metadata,
          body: ""
        };
        continue;
      }
    }

    if (currentSection === "intro") {
      introLines.push(line);
    } else if (currentItem) {
      currentItemBodyLines.push(line);
    }
  }

  flushCurrentItem();

  return {
    decisionsNeeded,
    tasks,
    resolvedLog,
    intro: introLines.join("\n").trim()
  };
}

export function serializeItem(item: LedgerItem): string {
  const parts = [`### [${item.id}]`];
  parts.push(`status:${item.status}`);
  parts.push(`from:${item.from}`);
  parts.push(`to:${item.to}`);
  parts.push(`opened:${item.opened}`);

  for (const [key, val] of Object.entries(item.metadata)) {
    if (["status", "from", "to", "opened"].includes(key)) continue;
    parts.push(`${key}:${val}`);
  }

  return `${parts.join(" ")}\n${item.body}\n`;
}

export function serializeLedger(projectRoot: string, ledger: Ledger): void {
  const ledgerPath = path.join(projectRoot, ".coordo", "ledger.md");
  let output = "";
  if (ledger.intro) {
    output += ledger.intro + "\n\n";
  } else {
    output += "# Coordo Ledger\n\n";
  }

  output += "## Decisions Needed\n\n";
  for (const item of ledger.decisionsNeeded) {
    output += serializeItem(item) + "\n";
  }

  output += "## Tasks\n\n";
  for (const item of ledger.tasks) {
    output += serializeItem(item) + "\n";
  }

  output += "## Resolved / Log\n\n";
  for (const item of ledger.resolvedLog) {
    output += serializeItem(item) + "\n";
  }

  writeFileSync(ledgerPath, output, "utf-8");
}

export function allocateId(ledger: Ledger, prefix: "DEC" | "TASK"): string {
  const allItems = [...ledger.decisionsNeeded, ...ledger.tasks, ...ledger.resolvedLog];
  let maxNum = 0;
  for (const item of allItems) {
    if (item.id.startsWith(prefix + "-")) {
      const numPart = item.id.slice(prefix.length + 1);
      const num = parseInt(numPart, 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  return `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
}

export function addDecision(
  projectRoot: string,
  question: string,
  from: string,
  to: string,
  context?: string
): string {
  return withLock(projectRoot, () => {
    const ledger = parseLedger(projectRoot);
    const id = allocateId(ledger, "DEC");
    let body = `**Question:** ${sanitizeBody(question)}`;
    if (context) {
      body += `\n\nContext: ${sanitizeBody(context)}`;
    }
    const item: LedgerItem = {
      id,
      status: "open",
      from,
      to,
      opened: new Date().toISOString().slice(0, 16) + "Z",
      metadata: {
        status: "open",
        from,
        to,
        opened: new Date().toISOString().slice(0, 16) + "Z"
      },
      body
    };
    ledger.decisionsNeeded.unshift(item);
    serializeLedger(projectRoot, ledger);
    return id;
  });
}

export function answerDecision(
  projectRoot: string,
  id: string,
  answer: string,
  by?: string
): void {
  withLock(projectRoot, () => {
    const ledger = parseLedger(projectRoot);
    const index = ledger.decisionsNeeded.findIndex(item => item.id === id);
    if (index === -1) {
      throw new Error(`Open decision with ID ${id} not found.`);
    }
    const item = ledger.decisionsNeeded.splice(index, 1)[0];
    item.status = "resolved";
    item.metadata.status = "resolved";

    const resolver = by || item.to;
    const time = new Date().toISOString().slice(0, 16) + "Z";
    item.body += `\n\n**Answer (by ${resolver}, ${time}):** ${sanitizeBody(answer)}`;

    ledger.resolvedLog.unshift(item);
    serializeLedger(projectRoot, ledger);
  });
}

export function addTask(
  projectRoot: string,
  description: string,
  from: string,
  to: string
): string {
  return withLock(projectRoot, () => {
    const ledger = parseLedger(projectRoot);
    const id = allocateId(ledger, "TASK");
    const item: LedgerItem = {
      id,
      status: "open",
      from,
      to,
      opened: new Date().toISOString().slice(0, 16) + "Z",
      metadata: {
        status: "open",
        from,
        to,
        opened: new Date().toISOString().slice(0, 16) + "Z"
      },
      body: sanitizeBody(description)
    };
    ledger.tasks.unshift(item);
    serializeLedger(projectRoot, ledger);
    return id;
  });
}

export function resolveTask(
  projectRoot: string,
  id: string,
  note?: string
): void {
  withLock(projectRoot, () => {
    const ledger = parseLedger(projectRoot);
    const index = ledger.tasks.findIndex(item => item.id === id);
    if (index === -1) {
      throw new Error(`Open task with ID ${id} not found.`);
    }
    const item = ledger.tasks.splice(index, 1)[0];
    item.status = "done";
    item.metadata.status = "done";

    if (note) {
      const time = new Date().toISOString().slice(0, 16) + "Z";
      item.body += `\n\n**Done Note (${time}):** ${sanitizeBody(note)}`;
    }

    ledger.resolvedLog.unshift(item);
    serializeLedger(projectRoot, ledger);
  });
}
