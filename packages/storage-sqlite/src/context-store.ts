/**
 * SQLite ContextStore (docs/specs/storage.md §1) on `better-sqlite3`.
 */
import Database from "better-sqlite3";
import {
  BriarError,
  FlowIdConflictError,
  RevisionConflictError,
  StoreClosedError,
  StoreCorruptError,
  buildContextPage,
  deserializeContext,
  normalizeListQuery,
} from "@briarflow/core";
import type { ContextDocument, ContextListQuery, ContextStore, ContextSummary, Page, SaveContextOptions } from "@briarflow/core";
import type { IndexEntry } from "./common.js";
import { assertContextId, indexEntryOf, lenientIndexEntry, serializeForSave } from "./common.js";

/** Options of {@link SqliteContextStore}. */
export interface SqliteContextStoreOptions {
  /** Database file, or `":memory:"` for a private in-memory database. */
  file: string;
  /** How long to wait for a lock held by another connection, in ms. Default 5000. */
  busyTimeoutMs?: number;
}

/** One schema migration: `sql` runs inside a transaction, then `version` is recorded. */
interface SchemaMigration {
  version: number;
  sql: string;
}

/** Schema migrations, oldest first. Append only; never edit a released one. */
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE contexts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        revision    INTEGER NOT NULL,
        updated_at  TEXT NOT NULL,
        name_lc     TEXT NOT NULL,
        description_lc TEXT,
        flows_json  TEXT NOT NULL,
        document    TEXT NOT NULL
      );
      CREATE INDEX contexts_order ON contexts (updated_at DESC, id ASC);
      CREATE TABLE flows (
        flow_id    TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES contexts (id) ON DELETE CASCADE,
        position   INTEGER NOT NULL,
        name_lc    TEXT NOT NULL
      );
      CREATE INDEX flows_context ON flows (context_id);
    `,
  },
];

/** Latest schema version this library knows. */
export const SQLITE_SCHEMA_VERSION = SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]!.version;

interface ContextRow {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  updated_at: string;
  flows_json: string;
}

/**
 * Stores contexts in one SQLite database. Each context is a row holding the
 * `serializeContext` text plus indexed columns (`name`, `revision`, `updated_at`, lowercased
 * search fields); a `flows` table maps every flow id to its context (primary key = flow id),
 * which makes `locateFlow` an index lookup and enforces flow-id uniqueness.
 *
 * Revision checks, the flow-id check and the write run in one `BEGIN IMMEDIATE`
 * transaction, so they are atomic even across processes sharing the file (file databases
 * use WAL mode and a busy timeout). The schema is versioned in a `migrations` table and
 * upgraded on open.
 *
 * Uses `better-sqlite3`, whose calls are synchronous: each method blocks the event loop
 * for the duration of its query.
 *
 * @example
 * ```ts
 * const store = new SqliteContextStore({ file: "./data/briarflow.db" });
 * await store.save(doc, { expectedRevision: doc.revision - 1 });
 * ```
 */
export class SqliteContextStore implements ContextStore {
  readonly kind = "sqlite";
  readonly file: string;
  #db: Database.Database | undefined;
  #closed = false;

  constructor(options: SqliteContextStoreOptions) {
    this.file = options.file;
    const db = new Database(options.file);
    try {
      db.pragma(`busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
      if (options.file !== ":memory:" && options.file !== "") db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      migrate(db);
    } catch (err) {
      db.close();
      throw err;
    }
    this.#db = db;
  }

  async load(id: string): Promise<ContextDocument | undefined> {
    const db = this.#use();
    if (typeof id !== "string") return undefined;
    const row = db.prepare("SELECT document FROM contexts WHERE id = ?").get(id) as { document: string } | undefined;
    if (!row) return undefined;
    let doc: ContextDocument;
    try {
      doc = deserializeContext(row.document);
    } catch (err) {
      throw new StoreCorruptError({ id }, { cause: err });
    }
    if (doc.id !== id) {
      throw new StoreCorruptError({ id }, { cause: new Error(`The row of context "${id}" holds context "${doc.id}".`) });
    }
    return doc;
  }

  async save(doc: ContextDocument, options: SaveContextOptions = {}): Promise<void> {
    const db = this.#use();
    const text = serializeForSave(doc);
    const entry = indexEntryOf(doc);
    const expected = options.expectedRevision;
    db.transaction(() => {
      if (expected !== undefined) {
        const row = db.prepare("SELECT revision FROM contexts WHERE id = ?").get(doc.id) as { revision: number } | undefined;
        const actual = row?.revision ?? 0;
        if (actual !== expected) throw new RevisionConflictError({ id: doc.id, name: doc.name, expected, actual });
      }
      const owner = db.prepare("SELECT context_id FROM flows WHERE flow_id = ?");
      for (const flow of entry.flows) {
        const row = owner.get(flow.id) as { context_id: string } | undefined;
        if (row && row.context_id !== doc.id) throw new FlowIdConflictError({ flowId: flow.id, contextId: row.context_id });
      }
      writeRow(db, entry, text);
    }).immediate();
  }

  async delete(id: string): Promise<boolean> {
    const db = this.#use();
    if (typeof id !== "string") return false;
    return db.transaction(() => {
      db.prepare("DELETE FROM flows WHERE context_id = ?").run(id);
      return db.prepare("DELETE FROM contexts WHERE id = ?").run(id).changes > 0;
    }).immediate();
  }

  async list(query?: ContextListQuery): Promise<Page<ContextSummary>> {
    const q = normalizeListQuery(query);
    const db = this.#use();
    const where: string[] = [];
    const params: Record<string, string | number> = { limit: q.limit + 1 };
    if (q.after !== undefined) {
      where.push("(c.updated_at < @afterUpdatedAt OR (c.updated_at = @afterUpdatedAt AND c.id > @afterId))");
      params["afterUpdatedAt"] = q.after.updatedAt;
      params["afterId"] = q.after.id;
    }
    if (q.needle !== "") {
      // instr() is an exact (binary) substring test; both sides are lowercased in JS, which
      // matches the spec's toLowerCase() semantics for every script (SQLite's lower() and
      // LIKE only fold ASCII).
      where.push(
        "(instr(c.name_lc, @needle) > 0 OR instr(coalesce(c.description_lc, ''), @needle) > 0" +
          " OR EXISTS (SELECT 1 FROM flows f WHERE f.context_id = c.id AND instr(f.name_lc, @needle) > 0))",
      );
      params["needle"] = q.needle;
    }
    const sql =
      "SELECT c.id, c.name, c.description, c.revision, c.updated_at, c.flows_json FROM contexts c" +
      (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY c.updated_at DESC, c.id ASC LIMIT @limit";
    const rows = db.prepare(sql).all(params) as ContextRow[];
    return buildContextPage(rows.map(entryOfRow), q);
  }

  async locateFlow(flowId: string): Promise<string | undefined> {
    const db = this.#use();
    if (typeof flowId !== "string") return undefined;
    const row = db.prepare("SELECT context_id FROM flows WHERE flow_id = ?").get(flowId) as { context_id: string } | undefined;
    return row?.context_id;
  }

  /**
   * Test and repair hook: stores `text` as the document of `id` without validation (e.g. an
   * older `formatVersion` document, or deliberately corrupt data). Index columns are filled
   * from whatever fields can be read.
   */
  async writeRaw(id: string, text: string): Promise<void> {
    assertContextId(id);
    const db = this.#use();
    let entry: IndexEntry;
    try {
      const doc = deserializeContext(text);
      entry = doc.id === id ? indexEntryOf(doc) : lenientIndexEntry(id, text);
    } catch {
      entry = lenientIndexEntry(id, text);
    }
    db.transaction(() => {
      // Flows claimed by another context keep their owner.
      const owner = db.prepare("SELECT context_id FROM flows WHERE flow_id = ?");
      const flows = entry.flows.filter((f) => {
        const row = owner.get(f.id) as { context_id: string } | undefined;
        return !row || row.context_id === id;
      });
      writeRow(db, { ...entry, flows }, text);
    }).immediate();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
  }

  #use(): Database.Database {
    if (this.#closed || !this.#db) throw new StoreClosedError(this.kind);
    return this.#db;
  }
}

function writeRow(db: Database.Database, entry: IndexEntry, text: string): void {
  db.prepare(
    `INSERT INTO contexts (id, name, description, revision, updated_at, name_lc, description_lc, flows_json, document)
     VALUES (@id, @name, @description, @revision, @updatedAt, @nameLc, @descriptionLc, @flowsJson, @document)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, description = excluded.description, revision = excluded.revision,
       updated_at = excluded.updated_at, name_lc = excluded.name_lc, description_lc = excluded.description_lc,
       flows_json = excluded.flows_json, document = excluded.document`,
  ).run({
    id: entry.id,
    name: entry.name,
    description: entry.description ?? null,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    nameLc: entry.name.toLowerCase(),
    descriptionLc: entry.description?.toLowerCase() ?? null,
    flowsJson: JSON.stringify(entry.flows),
    document: text,
  });
  db.prepare("DELETE FROM flows WHERE context_id = ?").run(entry.id);
  // OR IGNORE: a document listing the same flow id twice (a validation error, not a store one)
  // still saves; the first occurrence is indexed.
  const insert = db.prepare("INSERT OR IGNORE INTO flows (flow_id, context_id, position, name_lc) VALUES (?, ?, ?, ?)");
  entry.flows.forEach((flow, i) => insert.run(flow.id, entry.id, i, flow.name.toLowerCase()));
}

function entryOfRow(row: ContextRow): IndexEntry {
  let flows: { id: string; name: string }[] = [];
  try {
    flows = JSON.parse(row.flows_json) as { id: string; name: string }[];
  } catch {
    // leave empty; load() reports the corruption
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    revision: row.revision,
    updatedAt: row.updated_at,
    flows,
  };
}

function migrate(db: Database.Database): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = db.prepare("SELECT max(version) AS v FROM migrations").get() as { v: number | null };
    const current = row.v ?? 0;
    if (current > SQLITE_SCHEMA_VERSION) {
      throw new BriarError(
        "store.unsupported_schema",
        `This database uses schema version ${current}; this @briarflow/storage-sqlite supports up to ${SQLITE_SCHEMA_VERSION}. Update Briarflow.`,
        { details: { schemaVersion: current, supported: SQLITE_SCHEMA_VERSION } },
      );
    }
    const record = db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)");
    for (const m of SCHEMA_MIGRATIONS) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      record.run(m.version, new Date().toISOString());
    }
  }).immediate();
}
