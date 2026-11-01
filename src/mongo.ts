import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MongoClient, type ClientSession, type Collection, type Db } from "mongodb";
import type { Ledger, LedgerItem } from "./ledger.js";
import { mongoAgent } from "./storage.js";
import { describeMongoFailure } from "./mongoErrors.js";
import { describeSyncCollisions, itemFingerprint, planSync, type SyncCollision } from "./syncPlan.js";

interface MongoEnv {
  COORDO_MONGO_HOST?: string;
  COORDO_MONGO_DB?: string;
  COORDO_MONGO_USER_CLAUDE?: string;
  COORDO_MONGO_PASS_CLAUDE?: string;
  COORDO_MONGO_USER_CODEX?: string;
  COORDO_MONGO_PASS_CODEX?: string;
  COORDO_MONGO_USER_ANTIGRAVITY?: string;
  COORDO_MONGO_PASS_ANTIGRAVITY?: string;
}

interface StoredItem extends LedgerItem {
  entryKey: string;
  ledgerId: string;
  section: "decisions" | "tasks" | "resolved";
  order: number;
}

interface LedgerDocument {
  _id: string;
  schemaVersion: 1;
  intro: string;
  source: { migratedAt: string; migratedFrom: string };
  sourceArchive?: string;
}

function readMongoEnv(): MongoEnv {
  const file = path.join(homedir(), ".config", "coordo", "mongo.env");
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    throw new Error(`Mongo credentials file not found at ${file}.`);
  }
  const env: MongoEnv = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i) as keyof MongoEnv;
    if (key in env || key.startsWith("COORDO_MONGO_")) env[key] = line.slice(i + 1);
  }
  return env;
}

function connectionUri(): string {
  const env = readMongoEnv();
  const agent = mongoAgent();
  const key = agent.toUpperCase() as "CLAUDE" | "CODEX" | "ANTIGRAVITY";
  const host = env.COORDO_MONGO_HOST;
  const db = env.COORDO_MONGO_DB;
  const user = env[`COORDO_MONGO_USER_${key}`];
  const pass = env[`COORDO_MONGO_PASS_${key}`];
  if (!host || !db || !user || !pass) throw new Error(`mongo.env is missing a value for ${agent}.`);
  return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${db}?retryWrites=true&w=majority&appName=coordo-${agent}`;
}

export class MongoLedgerStore {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly items: Collection<StoredItem>;
  private readonly ledgers: Collection<LedgerDocument>;
  private readonly counters: Collection<{ _id: string; value: number }>;

  private constructor(private readonly ledgerId: string, client: MongoClient, db: Db) {
    this.client = client;
    this.db = db;
    this.items = db.collection<StoredItem>("ledger_items");
    this.ledgers = db.collection<LedgerDocument>("ledgers");
    this.counters = db.collection<{ _id: string; value: number }>("ledger_counters");
  }

  static async open(ledgerId: string): Promise<MongoLedgerStore> {
    const client = new MongoClient(connectionUri(), {
      appName: `coordo-${mongoAgent()}`,
      connectTimeoutMS: 8000,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 15000,
      waitQueueTimeoutMS: 8000,
      maxPoolSize: 10,
      minPoolSize: 0,
      retryWrites: true,
    });
    try {
      await client.connect();
      const db = client.db();
      const store = new MongoLedgerStore(ledgerId, client, db);
      return store;
    } catch (err) {
      await client.close().catch(() => {});
      throw new Error(describeMongoFailure((err as Error).message, mongoAgent()));
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async ping(): Promise<void> {
    await this.db.command({ ping: 1 });
  }

  async ensureIndexes(): Promise<void> {
    await this.items.createIndex({ ledgerId: 1, entryKey: 1 }, { unique: true });
    await this.items.createIndex({ ledgerId: 1, section: 1, order: -1 });
  }

  private async session<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  }

  async exists(): Promise<boolean> {
    return Boolean(await this.ledgers.findOne({ _id: this.ledgerId }, { projection: { _id: 1 } }));
  }

  async analytics(): Promise<Record<string, unknown>> {
    const ledgerExists = await this.exists();
    if (!ledgerExists) throw new Error(`Mongo ledger '${this.ledgerId}' is not initialized.`);
    const totalItems = await this.items.countDocuments({ ledgerId: this.ledgerId });
    const groupCounts = async (field: "section" | "status") => this.items.aggregate<{ _id: string; count: number }>([
      { $match: { ledgerId: this.ledgerId } },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    const routing = await this.items.aggregate<{ _id: { from: string; to: string }; count: number }>([
      { $match: { ledgerId: this.ledgerId } },
      { $group: { _id: { from: "$from", to: "$to" }, count: { $sum: 1 } } },
      { $sort: { "_id.from": 1, "_id.to": 1 } },
    ]).toArray();
    return {
      ledgerId: this.ledgerId,
      ledgerExists,
      totalItems,
      bySection: Object.fromEntries((await groupCounts("section")).map(({ _id, count }) => [_id, count])),
      byStatus: Object.fromEntries((await groupCounts("status")).map(({ _id, count }) => [_id, count])),
      byRoute: routing.map(({ _id, count }) => ({ from: _id.from, to: _id.to, count })),
    };
  }

  async read(): Promise<Ledger> {
    const doc = await this.ledgers.findOne({ _id: this.ledgerId });
    if (!doc) throw new Error(`Mongo ledger '${this.ledgerId}' is not initialized. Run 'coordo mongo migrate --as <agent>'.`);
    const all = await this.items.find({ ledgerId: this.ledgerId }).sort({ section: 1, order: -1 }).toArray();
    const clean = (section: StoredItem["section"]): LedgerItem[] => all.filter((item) => item.section === section).map(({ _id, entryKey: _entryKey, ledgerId, section: _section, order, ...item }) => item);
    return { intro: doc.intro, decisionsNeeded: clean("decisions"), tasks: clean("tasks"), resolvedLog: clean("resolved") };
  }

  async migrate(ledger: Ledger, sourceDescription: string, sourceArchive: string): Promise<{ items: number }> {
    // Migration is an explicit setup operation, so initialize the schema here
    // rather than paying DDL costs on every ordinary CLI connection.
    await this.ensureIndexes();
    const now = new Date().toISOString();
    const sections: Array<[StoredItem["section"], LedgerItem[]]> = [
      ["decisions", ledger.decisionsNeeded],
      ["tasks", ledger.tasks],
      ["resolved", ledger.resolvedLog],
    ];
    const items: StoredItem[] = [];
    const maxCounters = new Map<string, number>();
    for (const [section, values] of sections) {
      const total = values.length;
      values.forEach((item, index) => {
        items.push({ ...item, entryKey: `${section}:${index}`, ledgerId: this.ledgerId, section, order: total - index });
        const prefix = item.id.split("-")[0];
        const number = Number(item.id.split("-")[1]);
        if (/^(TASK|DEC)$/.test(prefix) && Number.isInteger(number)) maxCounters.set(prefix, Math.max(maxCounters.get(prefix) ?? 0, number));
      });
    }
    await this.session(async (session) => {
      if (await this.ledgers.findOne({ _id: this.ledgerId }, { session })) {
        throw new Error(`Mongo ledger '${this.ledgerId}' already exists; migration is not destructive and will not overwrite it.`);
      }
      await this.ledgers.insertOne({ _id: this.ledgerId, schemaVersion: 1, intro: ledger.intro, source: { migratedAt: now, migratedFrom: sourceDescription }, sourceArchive }, { session });
      if (items.length) await this.items.insertMany(items, { session, ordered: true });
      for (const [prefix, value] of maxCounters) {
        await this.counters.updateOne({ _id: `${this.ledgerId}:${prefix}` }, { $max: { value } }, { upsert: true, session });
      }
      for (const section of ["decisions", "tasks", "resolved"] as const) {
        const max = sections.find(([name]) => name === section)?.[1].length ?? 0;
        await this.counters.updateOne({ _id: `${this.ledgerId}:order:${section}` }, { $max: { value: max } }, { upsert: true, session });
      }
    });
    return { items: items.length };
  }

  async sync(ledger: Ledger, sourceArchive: string): Promise<{ added: number; skipped: number }> {
    if (!(await this.exists())) throw new Error(`Mongo ledger '${this.ledgerId}' is not initialized; run 'coordo mongo migrate --as <agent>'.`);
    const existing = await this.items.find({ ledgerId: this.ledgerId }).toArray();
    const sections: Array<[StoredItem["section"], LedgerItem[]]> = [
      ["decisions", ledger.decisionsNeeded],
      ["tasks", ledger.tasks],
      ["resolved", ledger.resolvedLog],
    ];
    // Decide everything first and write nothing until the plan is clean (see planSync).
    const known: LedgerItem[] = [...existing];
    const planned: Array<{ section: StoredItem["section"]; item: LedgerItem }> = [];
    const collisions: SyncCollision<LedgerItem>[] = [];
    let skipped = 0;
    for (const [section, values] of sections) {
      const plan = planSync(known, values);
      skipped += plan.staleCopies.length;
      collisions.push(...plan.collisions);
      for (const item of plan.additions) { known.push(item); planned.push({ section, item }); }
    }
    if (collisions.length) throw new Error(describeSyncCollisions(collisions));
    const additions: StoredItem[] = [];
    for (const { section, item } of planned) {
      additions.push({
        ...item,
        entryKey: `sync:${section}:${itemFingerprint(item)}`,
        ledgerId: this.ledgerId,
        section,
        order: await this.nextCounter(`${this.ledgerId}:order:${section}`),
      });
    }
    if (additions.length) await this.items.insertMany(additions, { ordered: true });
    for (const { item } of planned) {
      const [prefix, numberText] = item.id.split("-");
      const number = Number(numberText);
      if (/^(TASK|DEC)$/.test(prefix) && Number.isInteger(number)) {
        await this.counters.updateOne({ _id: `${this.ledgerId}:${prefix}` }, { $max: { value: number } }, { upsert: true });
      }
    }
    await this.ledgers.updateOne({ _id: this.ledgerId }, { $set: { sourceArchive } });
    return { added: additions.length, skipped };
  }

  private async nextCounter(key: string): Promise<number> {
    const result = await this.counters.findOneAndUpdate({ _id: key }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" });
    if (!result) throw new Error(`Could not allocate Mongo counter ${key}.`);
    return result.value;
  }

  private async nextId(prefix: "TASK" | "DEC"): Promise<string> {
    return `${prefix}-${String(await this.nextCounter(`${this.ledgerId}:${prefix}`)).padStart(3, "0")}`;
  }

  async add(section: "tasks" | "decisions", body: string, from: string, to: string): Promise<string> {
    const prefix = section === "tasks" ? "TASK" : "DEC";
    const id = await this.nextId(prefix);
    const opened = new Date().toISOString().slice(0, 16) + "Z";
    const status = "open";
    const item: StoredItem = {
      id, status, from, to, opened,
      metadata: { status, from, to, opened },
      body, entryKey: `${section}:${id}`, ledgerId: this.ledgerId, section,
      order: await this.nextCounter(`${this.ledgerId}:order:${section}`),
    };
    await this.items.insertOne(item);
    return id;
  }

  async answerDecision(id: string, answer: string, by: string): Promise<void> {
    const time = new Date().toISOString().slice(0, 16) + "Z";
    const order = await this.nextCounter(`${this.ledgerId}:order:resolved`);
    const result = await this.items.updateOne(
      { ledgerId: this.ledgerId, id, section: "decisions", status: "open" },
      [{ $set: { section: "resolved", status: "resolved", "metadata.status": "resolved", order, body: { $concat: ["$body", `\n\n**Answer (by ${by}, ${time}):** ${answer}`] } } }] as any
    );
    if (result.matchedCount === 0) throw new Error(`Open decision with ID ${id} not found.`);
  }

  async resolveTask(id: string, note?: string): Promise<void> {
    const time = new Date().toISOString().slice(0, 16) + "Z";
    const order = await this.nextCounter(`${this.ledgerId}:order:resolved`);
    const update = note
      ? [{ $set: { section: "resolved", status: "done", "metadata.status": "done", order, body: { $concat: ["$body", `\n\n**Done Note (${time}):** ${note}`] } } }]
      : { $set: { section: "resolved", status: "done", "metadata.status": "done", order } };
    const result = await this.items.updateOne({ ledgerId: this.ledgerId, id, section: "tasks", status: "open" }, update as any);
    if (result.matchedCount === 0) throw new Error(`Open task with ID ${id} not found.`);
  }
}

export async function withMongoLedger<T>(ledgerId: string, fn: (store: MongoLedgerStore) => Promise<T>): Promise<T> {
  const store = await MongoLedgerStore.open(ledgerId);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

export async function checkMongo(ledgerId: string): Promise<{ ok: true; ledgerId: string; roundTripMs: number }> {
  const store = await MongoLedgerStore.open(ledgerId);
  const started = Date.now();
  try {
    await store.ping();
    return { ok: true, ledgerId, roundTripMs: Date.now() - started };
  } finally {
    await store.close();
  }
}

export async function ensureMongoIndexes(ledgerId: string): Promise<void> {
  await withMongoLedger(ledgerId, (store) => store.ensureIndexes());
}
