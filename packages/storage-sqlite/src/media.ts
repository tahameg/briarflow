/**
 * SQLite media registry and last runs (docs/specs/media.md §2, §5). The bytes of `data`
 * entries (transient run artifacts) are kept in the same row as the entry.
 */
import Database from "better-sqlite3";
import { createIdGenerator, mediaExists, normalizeMediaEntry, ownerOf } from "@briarflow/core";
import type { Clock, IdGenerator, LastRun, LastRunStore, MediaEntry, MediaOwner, MediaRegistry, MediaSource, NewMediaEntry } from "@briarflow/core";
import { open } from "./vault.js";

/** Options of {@link SqliteMediaRegistry}. */
export interface SqliteMediaRegistryOptions {
  /** Database file (may be the context store's file) or `":memory:"`. */
  file: string;
  clock?: Clock;
  /** Ids are `idGenerator("med")`. */
  idGenerator?: IdGenerator;
}

interface EntryRow {
  id: string;
  mime: string;
  source: string;
  bytes: number | null;
  hash: string | null;
  meta: string | null;
  owner_run: string | null;
  owner_flow: string | null;
  owner_context: string | null;
  created_at: string;
}

const COLUMNS = "id, mime, source, bytes, hash, meta, owner_run, owner_flow, owner_context, created_at";

function entryOf(row: EntryRow): MediaEntry {
  return {
    id: row.id,
    mime: row.mime,
    source: JSON.parse(row.source) as MediaSource,
    ...(row.bytes === null ? {} : { bytes: row.bytes }),
    ...(row.hash === null ? {} : { hash: row.hash }),
    ...(row.meta === null ? {} : { meta: JSON.parse(row.meta) as NonNullable<MediaEntry["meta"]> }),
    ...(row.owner_run === null
      ? {}
      : { owner: ownerOf({ runId: row.owner_run, ...(row.owner_flow === null ? {} : { flowId: row.owner_flow }), ...(row.owner_context === null ? {} : { contextId: row.owner_context }) }) }),
    createdAt: row.created_at,
  };
}

/**
 * The media registry in SQLite. Implements `MediaRegistry`.
 *
 * @example
 * ```ts
 * const registry = new SqliteMediaRegistry({ file: "./data/briarflow.db" });
 * const media = createMedia({ registry, blobs: new FsMediaStore({ dir: "./data/media" }) });
 * ```
 */
export class SqliteMediaRegistry implements MediaRegistry {
  readonly kind = "sqlite";
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: SqliteMediaRegistryOptions) {
    this.#db = open(options.file);
    this.#clock = options.clock ?? (() => new Date());
    this.#ids = options.idGenerator ?? createIdGenerator();
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS media_entries (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        source TEXT NOT NULL,
        data BLOB,
        bytes INTEGER,
        hash TEXT,
        meta TEXT,
        owner_run TEXT,
        owner_flow TEXT,
        owner_context TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_entries_owner ON media_entries (owner_context, owner_flow, owner_run);
    `);
  }

  async add(input: NewMediaEntry, data?: Uint8Array): Promise<MediaEntry> {
    const n = normalizeMediaEntry(input, data);
    const entry: MediaEntry = { ...n, id: n.id ?? this.#ids("med"), createdAt: this.#clock().toISOString() };
    const r = this.#db
      .prepare(`INSERT OR IGNORE INTO media_entries (${COLUMNS}, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        entry.id,
        entry.mime,
        JSON.stringify(entry.source),
        entry.bytes ?? null,
        entry.hash ?? null,
        entry.meta === undefined ? null : JSON.stringify(entry.meta),
        entry.owner?.runId ?? null,
        entry.owner?.flowId ?? null,
        entry.owner?.contextId ?? null,
        entry.createdAt,
        data === undefined ? null : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      );
    if (r.changes === 0) throw mediaExists(entry.id);
    return entry;
  }

  async get(id: string): Promise<MediaEntry | undefined> {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM media_entries WHERE id = ?`).get(id) as EntryRow | undefined;
    return row ? entryOf(row) : undefined;
  }

  async data(id: string): Promise<Uint8Array | undefined> {
    const row = this.#db.prepare("SELECT data FROM media_entries WHERE id = ?").get(id) as { data: Buffer | null } | undefined;
    return row?.data ? new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    return this.#db.prepare("DELETE FROM media_entries WHERE id = ?").run(id).changes > 0;
  }

  async adopt(ids: readonly string[], owner: MediaOwner): Promise<void> {
    const update = this.#db.prepare("UPDATE media_entries SET owner_run = ?, owner_flow = ?, owner_context = ? WHERE id = ? AND owner_run IS NOT NULL");
    this.#db.transaction(() => {
      for (const id of ids) update.run(owner.runId, owner.flowId ?? null, owner.contextId ?? null, id);
    })();
  }

  async owners(): Promise<MediaOwner[]> {
    const rows = this.#db
      .prepare("SELECT DISTINCT owner_run, owner_flow, owner_context FROM media_entries WHERE owner_run IS NOT NULL")
      .all() as Pick<EntryRow, "owner_run" | "owner_flow" | "owner_context">[];
    return rows.map((r) =>
      ownerOf({ runId: r.owner_run as string, ...(r.owner_flow === null ? {} : { flowId: r.owner_flow }), ...(r.owner_context === null ? {} : { contextId: r.owner_context }) }),
    );
  }

  async deleteOwned(match: Partial<MediaOwner>): Promise<string[]> {
    const where = ["owner_run IS NOT NULL"];
    const args: string[] = [];
    for (const [key, column] of [["runId", "owner_run"], ["flowId", "owner_flow"], ["contextId", "owner_context"]] as const) {
      const v = match[key];
      if (v === undefined) continue;
      where.push(`${column} = ?`);
      args.push(v);
    }
    return this.#db.transaction(() => {
      const ids = (this.#db.prepare(`SELECT id FROM media_entries WHERE ${where.join(" AND ")}`).all(...args) as { id: string }[]).map((r) => r.id);
      this.#db.prepare(`DELETE FROM media_entries WHERE ${where.join(" AND ")}`).run(...args);
      return ids;
    })();
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * The last run of each flow in SQLite. Implements `LastRunStore`.
 *
 * @example
 * ```ts
 * const lastRuns = new SqliteLastRunStore({ file: "./data/briarflow.db" });
 * ```
 */
export class SqliteLastRunStore implements LastRunStore {
  readonly kind = "sqlite";
  readonly #db: Database.Database;

  constructor(options: { file: string }) {
    this.#db = open(options.file);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS last_runs (context_id TEXT NOT NULL, flow_id TEXT NOT NULL, run_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (context_id, flow_id))",
    );
  }

  async get(contextId: string, flowId: string): Promise<LastRun | undefined> {
    const row = this.#db.prepare("SELECT record FROM last_runs WHERE context_id = ? AND flow_id = ?").get(contextId, flowId) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as LastRun) : undefined;
  }

  async set(run: LastRun): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO last_runs (context_id, flow_id, run_id, record) VALUES (?, ?, ?, ?) ON CONFLICT(context_id, flow_id) DO UPDATE SET run_id = excluded.run_id, record = excluded.record",
      )
      .run(run.contextId, run.flowId, run.runId, JSON.stringify(run));
  }

  async delete(contextId: string, flowId: string): Promise<boolean> {
    return this.#db.prepare("DELETE FROM last_runs WHERE context_id = ? AND flow_id = ?").run(contextId, flowId).changes > 0;
  }

  async list(): Promise<LastRun[]> {
    return (this.#db.prepare("SELECT record FROM last_runs").all() as { record: string }[]).map((r) => JSON.parse(r.record) as LastRun);
  }

  close(): void {
    this.#db.close();
  }
}
