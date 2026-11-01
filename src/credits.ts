import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LeadConfig } from "./leadConfig.js";
import { readState, writeState } from "./state.js";

export type CreditTransactionType = "task" | "decision" | "invoke" | "consult" | "plan" | "manual_add" | "transfer";

export interface CreditTransaction {
  id: string;
  timestamp: string;
  agent: string;
  amount: number; // positive = spent/deducted, negative = added
  type: CreditTransactionType;
  refId?: string;
  balanceAfter: number;
  note?: string;
}

export interface AgentCreditAccount {
  balance: number;
  spent: number;
  limit?: number;
}

export interface CreditState {
  enabled: boolean;
  defaultBalance: number;
  enforceLimits: boolean;
  costPerSecondEstimate: number;
  accounts: Record<string, AgentCreditAccount>;
  transactions: CreditTransaction[];
}

export const DEFAULT_CREDIT_STATE: CreditState = {
  enabled: true,
  defaultBalance: 100.0,
  enforceLimits: false,
  costPerSecondEstimate: 0.0005, // ~$0.03 per minute fallback estimate
  accounts: {},
  transactions: [],
};

function customCreditsPath(projectRoot: string): string {
  return path.join(projectRoot, ".coordo", "credits.json");
}

export function loadCredits(projectRoot: string, config?: LeadConfig): CreditState {
  const custom = customCreditsPath(projectRoot);
  let state: CreditState;

  if (existsSync(custom)) {
    try {
      state = JSON.parse(readFileSync(custom, "utf-8"));
    } catch {
      state = structuredClone(DEFAULT_CREDIT_STATE);
    }
  } else {
    const coordoState = readState(projectRoot);
    if (coordoState.credits) {
      state = structuredClone(coordoState.credits);
    } else {
      state = structuredClone(DEFAULT_CREDIT_STATE);
    }
  }

  // Merge config overrides if provided
  if (config?.credits) {
    if (typeof config.credits.enabled === "boolean") state.enabled = config.credits.enabled;
    if (typeof config.credits.defaultBalance === "number") state.defaultBalance = config.credits.defaultBalance;
    if (typeof config.credits.enforceLimits === "boolean") state.enforceLimits = config.credits.enforceLimits;
    if (typeof config.credits.costPerSecondEstimate === "number") state.costPerSecondEstimate = config.credits.costPerSecondEstimate;
  }

  // Ensure accounts exist for all known agents in config
  if (config?.agents) {
    for (const agent of config.agents) {
      if (!state.accounts[agent]) {
        state.accounts[agent] = {
          balance: state.defaultBalance,
          spent: 0,
          limit: state.defaultBalance,
        };
      }
    }
  }

  return state;
}

export function saveCredits(projectRoot: string, state: CreditState): void {
  const custom = customCreditsPath(projectRoot);
  if (existsSync(custom)) {
    writeFileSync(custom, JSON.stringify(state, null, 2) + "\n", "utf-8");
  } else {
    const coordoState = readState(projectRoot);
    coordoState.credits = state;
    writeState(projectRoot, coordoState);
  }
}

export function ensureAgentAccount(state: CreditState, agent: string): AgentCreditAccount {
  if (!state.accounts[agent]) {
    state.accounts[agent] = {
      balance: state.defaultBalance,
      spent: 0,
      limit: state.defaultBalance,
    };
  }
  return state.accounts[agent];
}

export function checkCreditAvailable(
  projectRoot: string,
  agent: string,
  minRequired: number = 0.001,
  config?: LeadConfig
): { ok: boolean; balance: number; reason?: string } {
  const state = loadCredits(projectRoot, config);
  if (!state.enabled) {
    return { ok: true, balance: Infinity };
  }
  const account = ensureAgentAccount(state, agent);
  if (state.enforceLimits && account.balance < minRequired) {
    return {
      ok: false,
      balance: account.balance,
      reason: `Agent '${agent}' has insufficient credits: ${account.balance.toFixed(3)} available, ${minRequired.toFixed(3)} required.`,
    };
  }
  return { ok: true, balance: account.balance };
}

export function deductCredits(
  projectRoot: string,
  agent: string,
  amount: number,
  type: CreditTransactionType,
  refId?: string,
  note?: string,
  config?: LeadConfig
): { ok: boolean; transaction?: CreditTransaction; balance: number; error?: string } {
  const state = loadCredits(projectRoot, config);
  const account = ensureAgentAccount(state, agent);

  if (state.enabled && state.enforceLimits && account.balance < amount) {
    return {
      ok: false,
      balance: account.balance,
      error: `Insufficient credits for agent '${agent}': required ${amount.toFixed(3)}, available ${account.balance.toFixed(3)}`,
    };
  }

  account.balance = Number((account.balance - amount).toFixed(4));
  account.spent = Number((account.spent + amount).toFixed(4));

  const txId = `TX-${String(state.transactions.length + 1).padStart(4, "0")}`;
  const transaction: CreditTransaction = {
    id: txId,
    timestamp: new Date().toISOString(),
    agent,
    amount: Number(amount.toFixed(4)),
    type,
    refId,
    balanceAfter: account.balance,
    note,
  };

  state.transactions.unshift(transaction);
  saveCredits(projectRoot, state);

  return { ok: true, transaction, balance: account.balance };
}

export function addCredits(
  projectRoot: string,
  agent: string,
  amount: number,
  note?: string,
  config?: LeadConfig
): { transaction: CreditTransaction; balance: number } {
  const state = loadCredits(projectRoot, config);
  const targets = agent === "all" ? Object.keys(state.accounts) : [agent];

  let lastTx!: CreditTransaction;
  for (const a of targets) {
    const account = ensureAgentAccount(state, a);
    account.balance = Number((account.balance + amount).toFixed(4));
    if (account.limit !== undefined) {
      account.limit = Number((account.limit + amount).toFixed(4));
    }

    const txId = `TX-${String(state.transactions.length + 1).padStart(4, "0")}`;
    lastTx = {
      id: txId,
      timestamp: new Date().toISOString(),
      agent: a,
      amount: -Number(amount.toFixed(4)), // negative = credit added
      type: "manual_add",
      balanceAfter: account.balance,
      note: note ?? `Added ${amount.toFixed(2)} credits`,
    };
    state.transactions.unshift(lastTx);
  }

  saveCredits(projectRoot, state);
  const bal = state.accounts[agent]?.balance ?? state.defaultBalance;
  return { transaction: lastTx, balance: bal };
}

export function transferCredits(
  projectRoot: string,
  fromAgent: string,
  toAgent: string,
  amount: number,
  note?: string,
  config?: LeadConfig
): { ok: boolean; fromBalance: number; toBalance: number; error?: string } {
  const state = loadCredits(projectRoot, config);
  const fromAcc = ensureAgentAccount(state, fromAgent);
  const toAcc = ensureAgentAccount(state, toAgent);

  if (state.enforceLimits && fromAcc.balance < amount) {
    return {
      ok: false,
      fromBalance: fromAcc.balance,
      toBalance: toAcc.balance,
      error: `Agent '${fromAgent}' has insufficient balance (${fromAcc.balance.toFixed(2)}) to transfer ${amount.toFixed(2)} credits.`,
    };
  }

  fromAcc.balance = Number((fromAcc.balance - amount).toFixed(4));
  fromAcc.spent = Number((fromAcc.spent + amount).toFixed(4));
  toAcc.balance = Number((toAcc.balance + amount).toFixed(4));

  const ts = new Date().toISOString();
  state.transactions.unshift({
    id: `TX-${String(state.transactions.length + 1).padStart(4, "0")}`,
    timestamp: ts,
    agent: fromAgent,
    amount,
    type: "transfer",
    balanceAfter: fromAcc.balance,
    note: note ?? `Transfer to ${toAgent}`,
  });

  state.transactions.unshift({
    id: `TX-${String(state.transactions.length + 1).padStart(4, "0")}`,
    timestamp: ts,
    agent: toAgent,
    amount: -amount,
    type: "transfer",
    balanceAfter: toAcc.balance,
    note: note ?? `Transfer from ${fromAgent}`,
  });

  saveCredits(projectRoot, state);
  return { ok: true, fromBalance: fromAcc.balance, toBalance: toAcc.balance };
}

export function estimateCost(durationMs: number, actualCostUsd?: number, fallbackPerSecond: number = 0.0005): number {
  if (actualCostUsd !== undefined && actualCostUsd > 0) {
    return Number(actualCostUsd.toFixed(4));
  }
  const seconds = Math.max(1, durationMs / 1000);
  return Number((seconds * fallbackPerSecond).toFixed(4));
}
