import { createHash } from "node:crypto";
import type { LedgerItem } from "./ledger.js";

export function itemFingerprint(item: LedgerItem): string {
  return createHash("sha256").update(JSON.stringify([item.id, item.status, item.from, item.to, item.opened, item.metadata, item.body])).digest("hex");
}

export interface SyncCollision<T extends LedgerItem> { item: T; existing: LedgerItem }
export interface SyncPlan<T extends LedgerItem> { additions: T[]; staleCopies: T[]; collisions: SyncCollision<T>[] }

const sameTask = (a: LedgerItem, b: LedgerItem) => a.from === b.from && a.to === b.to && a.opened === b.opened;

/**
 * Decide what `mongo sync` may import from the Markdown archive into Mongo.
 *  - already in Mongo (same fingerprint): nothing to do.
 *  - same task (id, from, to, opened) but a different status or body: a STALE COPY. Mongo is canonical,
 *    so it is skipped; importing it would resurrect work that was closed in Mongo.
 *  - same id but a different task: a COLLISION. Importing it would make one ID mean two things.
 *  - an id Mongo has never seen: a genuine addition.
 */
export function planSync<T extends LedgerItem>(existing: LedgerItem[], archive: T[]): SyncPlan<T> {
  const known = new Set(existing.map(itemFingerprint));
  const byId = new Map<string, LedgerItem[]>();
  for (const item of existing) byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
  const plan: SyncPlan<T> = { additions: [], staleCopies: [], collisions: [] };
  for (const item of archive) {
    const fingerprint = itemFingerprint(item);
    if (known.has(fingerprint)) continue;
    known.add(fingerprint);
    const sameId = byId.get(item.id) ?? [];
    if (!sameId.length) plan.additions.push(item);
    else if (sameId.some((other) => sameTask(other, item))) plan.staleCopies.push(item);
    else plan.collisions.push({ item, existing: sameId[0] });
  }
  return plan;
}

export function describeSyncCollisions(collisions: Array<SyncCollision<LedgerItem>>): string {
  const title = (item: LedgerItem) => (item.body.split("\n")[0] ?? "").slice(0, 60);
  const first = collisions[0];
  return `Refusing to sync: ${collisions.length} archive entr${collisions.length === 1 ? "y reuses an ID that already means" : "ies reuse IDs that already mean"} a different task in Mongo `
    + `(first: ${first.item.id} "${title(first.item)}" vs Mongo ${first.existing.id} "${title(first.existing)}"). Importing would make one ID mean two things. `
    + `Import such entries under fresh IDs and treat the archive as closed (docs/mongo-operations.md, "Archived markdown ledgers"). Nothing was written.`;
}
