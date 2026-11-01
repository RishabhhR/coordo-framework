import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readState, writeState } from "./state.js";

export interface DeliberationTurn {
  speaker: string;
  timestamp: string;
  message: string;
  role?: "proposer" | "respondent" | "critic" | "arbiter";
  creditsUsed?: number;
}

export interface DecisionRecord {
  id: string; // e.g. "DEC-001"
  status: "open" | "deliberating" | "resolved" | "escalated";
  from: string;
  to: string;
  opened: string;
  resolvedAt?: string;
  resolvedBy?: string;
  question: string;
  context?: string;
  deliberation: DeliberationTurn[];
  optionsConsidered?: string[];
  rationale?: string;
  finalDecision?: string;
  creditsCost?: number;
}

export interface DecisionLedgerState {
  version: number;
  decisions: Record<string, DecisionRecord>;
}

export const DEFAULT_DECISION_LEDGER_STATE: DecisionLedgerState = {
  version: 1,
  decisions: {},
};

function customDecisionLedgerPath(projectRoot: string): string {
  return path.join(projectRoot, ".coordo", "decisions.json");
}

export function loadDecisionLedger(projectRoot: string): DecisionLedgerState {
  const custom = customDecisionLedgerPath(projectRoot);
  if (existsSync(custom)) {
    try {
      return JSON.parse(readFileSync(custom, "utf-8"));
    } catch {
      return structuredClone(DEFAULT_DECISION_LEDGER_STATE);
    }
  }
  const coordoState = readState(projectRoot);
  if (coordoState.decisions) {
    return structuredClone(coordoState.decisions);
  }
  return structuredClone(DEFAULT_DECISION_LEDGER_STATE);
}

export function saveDecisionLedger(projectRoot: string, state: DecisionLedgerState): void {
  const custom = customDecisionLedgerPath(projectRoot);
  if (existsSync(custom)) {
    writeFileSync(custom, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } else {
    const coordoState = readState(projectRoot);
    coordoState.decisions = state;
    writeState(projectRoot, coordoState);
  }
}

export function recordDecisionCreated(
  projectRoot: string,
  entry: {
    id: string;
    question: string;
    from: string;
    to: string;
    context?: string;
  }
): DecisionRecord {
  const state = loadDecisionLedger(projectRoot);
  const record: DecisionRecord = {
    id: entry.id,
    status: "open",
    from: entry.from,
    to: entry.to,
    opened: new Date().toISOString(),
    question: entry.question,
    context: entry.context,
    deliberation: [],
  };
  state.decisions[entry.id] = record;
  saveDecisionLedger(projectRoot, state);
  return record;
}

export function recordDeliberationTurn(
  projectRoot: string,
  id: string,
  turn: {
    speaker: string;
    message: string;
    role?: "proposer" | "respondent" | "critic" | "arbiter";
    creditsUsed?: number;
  }
): DecisionRecord {
  const state = loadDecisionLedger(projectRoot);
  let record = state.decisions[id];
  if (!record) {
    record = {
      id,
      status: "deliberating",
      from: turn.speaker,
      to: "default",
      opened: new Date().toISOString(),
      question: turn.message,
      deliberation: [],
    };
    state.decisions[id] = record;
  } else {
    record.status = "deliberating";
  }

  record.deliberation.push({
    speaker: turn.speaker,
    timestamp: new Date().toISOString(),
    message: turn.message,
    role: turn.role ?? "respondent",
    creditsUsed: turn.creditsUsed,
  });

  saveDecisionLedger(projectRoot, state);
  return record;
}

export function recordDecisionResolved(
  projectRoot: string,
  id: string,
  resolution: {
    answer: string;
    by: string;
    rationale?: string;
    optionsConsidered?: string[];
    creditsCost?: number;
  }
): DecisionRecord {
  const state = loadDecisionLedger(projectRoot);
  let record = state.decisions[id];
  const now = new Date().toISOString();

  if (!record) {
    record = {
      id,
      status: "resolved",
      from: "default",
      to: resolution.by,
      opened: now,
      resolvedAt: now,
      resolvedBy: resolution.by,
      question: resolution.answer,
      finalDecision: resolution.answer,
      rationale: resolution.rationale,
      optionsConsidered: resolution.optionsConsidered,
      creditsCost: resolution.creditsCost,
      deliberation: [],
    };
    state.decisions[id] = record;
  } else {
    record.status = "resolved";
    record.resolvedAt = now;
    record.resolvedBy = resolution.by;
    record.finalDecision = resolution.answer;
    if (resolution.rationale) record.rationale = resolution.rationale;
    if (resolution.optionsConsidered) record.optionsConsidered = resolution.optionsConsidered;
    if (resolution.creditsCost !== undefined) {
      record.creditsCost = Number(((record.creditsCost ?? 0) + resolution.creditsCost).toFixed(4));
    }
  }

  saveDecisionLedger(projectRoot, state);
  return record;
}

export function getDecisionRecord(projectRoot: string, id: string): DecisionRecord | null {
  const state = loadDecisionLedger(projectRoot);
  return state.decisions[id] ?? null;
}

export function listDecisionRecords(
  projectRoot: string,
  filter?: { status?: string }
): DecisionRecord[] {
  const state = loadDecisionLedger(projectRoot);
  const items = Object.values(state.decisions);
  if (!filter?.status || filter.status === "all") {
    return items;
  }
  return items.filter((d) => d.status === filter.status);
}

export function formatDecisionRecord(record: DecisionRecord): string {
  const lines: string[] = [
    `=== Decision ${record.id} ===`,
    `Status:   ${record.status}`,
    `From:     ${record.from} -> To: ${record.to}`,
    `Opened:   ${record.opened}`,
  ];
  if (record.resolvedAt) lines.push(`Resolved: ${record.resolvedAt} by ${record.resolvedBy ?? "unknown"}`);
  if (record.creditsCost !== undefined) lines.push(`Cost:     $${record.creditsCost.toFixed(3)} credits`);

  lines.push(`\nQuestion:\n  ${record.question}`);

  if (record.context) {
    lines.push(`\nContext:\n  ${record.context}`);
  }

  if (record.optionsConsidered && record.optionsConsidered.length > 0) {
    lines.push("\nOptions Considered:");
    for (const opt of record.optionsConsidered) {
      lines.push(`  - ${opt}`);
    }
  }

  if (record.rationale) {
    lines.push(`\nRationale:\n  ${record.rationale}`);
  }

  if (record.finalDecision) {
    lines.push(`\nResolution / Decision:\n  ${record.finalDecision}`);
  }

  if (record.deliberation && record.deliberation.length > 0) {
    lines.push("\nDeliberation Trail:");
    for (const turn of record.deliberation) {
      const cost = turn.creditsUsed !== undefined ? ` ($${turn.creditsUsed.toFixed(3)})` : "";
      lines.push(`  [${turn.timestamp}] <${turn.speaker}${turn.role ? ` as ${turn.role}` : ""}>${cost}:`);
      lines.push(`    ${turn.message.replace(/\n/g, "\n    ")}`);
    }
  }

  return lines.join("\n");
}
