/**
 * File-system ContextStore (docs/specs/storage.md §1): one JSON file per context.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  FlowIdConflictError,
  RevisionConflictError,
  StoreClosedError,
  StoreCorruptError,
  buildContextPage,
  compareContextOrder,
  deserializeContext,
  isAfterCursor,
  matchesContextSearch,
  normalizeListQuery,
  isValidId,
} from "@briarflow/core";
import type { ContextDocument, ContextListQuery, ContextStore, ContextSummary, Page, SaveContextOptions } from "@briarflow/core";
import type { IndexEntry } from "./common.js";
import { assertContextId, indexEntryOf, lenientIndexEntry, serializeForSave } from "./common.js";

/** Options of {@link FsContextStore}. */
export interface FsContextStoreOptions {
  /** Directory holding one `<contextId>.json` file per context. Created if missing. */
  dir: string;
  /** `fsync` each file before renaming it into place. Default `true`; tests may turn it off. */
  durable?: boolean;
}

const FILE_PATTERN = /^(ctx_[A-Za-z0-9_-]{1,60})\.json$/;

/**
 * Stores each context as `<dir>/<id>.json` (the output of `serializeContext`). Writes are
 * atomic: the text goes to a temporary file in the same directory, is fsynced and renamed
 * over the old file, so readers never see a half-written document.
 *
 * `list` and `locateFlow` use an in-memory index built from the directory on first use.
 *
 * **One writer process per directory.** Saves and deletes of this instance are serialized,
 * which makes revision checks and flow-id uniqueness atomic within the process. Changes
 * made by other processes are seen by `load` and by the revision check of `save` (both read
 * the file), but the index (`list`, `locateFlow`, flow-id conflicts) only sees them after
 * {@link FsContextStore.refresh}. Two processes writing the same directory can lose updates.
 *
 * A file that cannot be deserialized makes `load` throw `StoreCorruptError`; it still
 * appears in `list` with whatever fields could be read, so it can be found and deleted.
 *
 * @example
 * ```ts
 * const store = new FsContextStore({ dir: "./data/contexts" });
 * await store.save(doc, { expectedRevision: doc.revision - 1 });
 * ```
 */
export class FsContextStore implements ContextStore {
  readonly kind = "fs";
  readonly dir: string;
  readonly #durable: boolean;
  #index = new Map<string, IndexEntry>();
  #flowOwner = new Map<string, string>();
  #ready: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: FsContextStoreOptions) {
    this.dir = options.dir;
    this.#durable = options.durable ?? true;
  }

  /** Path of the file that holds a context (whether or not it exists). */
  pathFor(id: string): string {
    assertContextId(id);
    return join(this.dir, `${id}.json`);
  }

  async load(id: string): Promise<ContextDocument | undefined> {
    await this.#open();
    if (typeof id !== "string" || !isValidId("context", id)) return undefined;
    const text = await readText(this.pathFor(id));
    if (text === undefined) return undefined;
    return parseStored(id, text);
  }

  async save(doc: ContextDocument, options: SaveContextOptions = {}): Promise<void> {
    await this.#open();
    const text = serializeForSave(doc);
    const entry = indexEntryOf(doc);
    await this.#exclusive(async () => {
      if (options.expectedRevision !== undefined) {
        const actual = await this.#storedRevision(doc.id);
        if (actual !== options.expectedRevision) {
          throw new RevisionConflictError({ id: doc.id, name: doc.name, expected: options.expectedRevision, actual });
        }
      }
      for (const flow of entry.flows) {
        const owner = this.#flowOwner.get(flow.id);
        if (owner !== undefined && owner !== doc.id) throw new FlowIdConflictError({ flowId: flow.id, contextId: owner });
      }
      await this.#writeAtomic(doc.id, text);
      this.#setEntry(entry);
    });
  }

  async delete(id: string): Promise<boolean> {
    await this.#open();
    if (typeof id !== "string" || !isValidId("context", id)) return false;
    return this.#exclusive(async () => {
      let existed = true;
      try {
        await unlink(this.pathFor(id));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        existed = false;
      }
      this.#removeEntry(id);
      return existed;
    });
  }

  async list(query?: ContextListQuery): Promise<Page<ContextSummary>> {
    const q = normalizeListQuery(query);
    await this.#open();
    const matching: IndexEntry[] = [];
    for (const entry of this.#index.values()) {
      if (!isAfterCursor(entry, q.after)) continue;
      if (matchesContextSearch(entry, q.needle)) matching.push(entry);
    }
    matching.sort(compareContextOrder);
    return buildContextPage(matching, q);
  }

  async locateFlow(flowId: string): Promise<string | undefined> {
    await this.#open();
    return this.#flowOwner.get(flowId);
  }

  /** Rebuilds the index from the directory (picks up changes made by other processes). */
  async refresh(): Promise<void> {
    await this.#open();
    await this.#exclusive(() => this.#rebuild());
  }

  /**
   * Test and repair hook: writes `text` as the stored file of `id` without any validation
   * (e.g. an older `formatVersion` document, or deliberately corrupt data).
   */
  async writeRaw(id: string, text: string): Promise<void> {
    assertContextId(id);
    await this.#open();
    await this.#exclusive(async () => {
      await this.#writeAtomic(id, text);
      this.#setEntry(entryFromText(id, text));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue.catch(() => {});
  }

  // ------------------------------------------------------------------ internals

  #open(): Promise<void> {
    if (this.#closed) return Promise.reject(new StoreClosedError(this.kind));
    this.#ready ??= this.#exclusive(async () => {
      await mkdir(this.dir, { recursive: true });
      await this.#rebuild();
    });
    return this.#ready.then(() => {
      if (this.#closed) throw new StoreClosedError(this.kind);
    });
  }

  async #rebuild(): Promise<void> {
    const index = new Map<string, IndexEntry>();
    const owners = new Map<string, string>();
    const names = (await readdir(this.dir)).sort();
    for (const name of names) {
      const m = FILE_PATTERN.exec(name);
      if (!m) continue;
      const id = m[1]!;
      const text = await readText(join(this.dir, name));
      if (text === undefined) continue;
      const entry = entryFromText(id, text);
      index.set(id, entry);
      for (const flow of entry.flows) if (!owners.has(flow.id)) owners.set(flow.id, id);
    }
    this.#index = index;
    this.#flowOwner = owners;
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #storedRevision(id: string): Promise<number> {
    const text = await readText(this.pathFor(id));
    if (text === undefined) return 0;
    return parseStored(id, text).revision;
  }

  async #writeAtomic(id: string, text: string): Promise<void> {
    const target = this.pathFor(id);
    const tmp = join(this.dir, `.${id}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(text, "utf8");
        if (this.#durable) await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  #setEntry(entry: IndexEntry): void {
    this.#removeEntry(entry.id);
    this.#index.set(entry.id, entry);
    for (const flow of entry.flows) if (!this.#flowOwner.has(flow.id)) this.#flowOwner.set(flow.id, entry.id);
  }

  #removeEntry(id: string): void {
    const old = this.#index.get(id);
    if (!old) return;
    this.#index.delete(id);
    for (const flow of old.flows) if (this.#flowOwner.get(flow.id) === id) this.#flowOwner.delete(flow.id);
  }
}

function parseStored(id: string, text: string): ContextDocument {
  let doc: ContextDocument;
  try {
    doc = deserializeContext(text);
  } catch (err) {
    throw new StoreCorruptError({ id }, { cause: err });
  }
  if (doc.id !== id) {
    throw new StoreCorruptError({ id }, { cause: new Error(`The file of context "${id}" holds context "${doc.id}".`) });
  }
  return doc;
}

function entryFromText(id: string, text: string): IndexEntry {
  try {
    const doc = deserializeContext(text);
    if (doc.id === id) return indexEntryOf(doc);
  } catch {
    // corrupt or unreadable: index what can be read
  }
  return lenientIndexEntry(id, text);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
