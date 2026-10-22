/**
 * In-memory ContextStore (docs/specs/storage.md §1). Portable: no Node APIs.
 */
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
} from "@briarflow/core";
import type { ContextDocument, ContextListQuery, ContextStore, ContextSummary, Page, SaveContextOptions } from "@briarflow/core";
import type { IndexEntry } from "./internal/store-common.js";
import { assertContextId, indexEntryOf, lenientIndexEntry, serializeForSave } from "./internal/store-common.js";

interface Stored {
  text: string;
  entry: IndexEntry;
}

/**
 * Keeps contexts in memory, serialized (so `load` never shares objects with callers). Good for
 * tests, demos and short-lived processes; everything is lost when the process ends.
 *
 * All operations complete synchronously inside their promise, so revision checks and
 * flow-id uniqueness are atomic.
 *
 * @example
 * ```ts
 * const briar = createBriar({ store: new MemoryContextStore() });
 * ```
 */
export class MemoryContextStore implements ContextStore {
  readonly kind = "memory";
  #items = new Map<string, Stored>();
  #flowOwner = new Map<string, string>();
  #closed = false;

  async load(id: string): Promise<ContextDocument | undefined> {
    this.#check();
    const stored = typeof id === "string" ? this.#items.get(id) : undefined;
    if (!stored) return undefined;
    let doc: ContextDocument;
    try {
      doc = deserializeContext(stored.text);
    } catch (err) {
      throw new StoreCorruptError({ id }, { cause: err });
    }
    return doc;
  }

  async save(doc: ContextDocument, options: SaveContextOptions = {}): Promise<void> {
    this.#check();
    const text = serializeForSave(doc);
    const entry = indexEntryOf(doc);
    if (options.expectedRevision !== undefined) {
      const actual = this.#storedRevision(doc.id);
      if (actual !== options.expectedRevision) {
        throw new RevisionConflictError({ id: doc.id, name: doc.name, expected: options.expectedRevision, actual });
      }
    }
    for (const flow of entry.flows) {
      const owner = this.#flowOwner.get(flow.id);
      if (owner !== undefined && owner !== doc.id) throw new FlowIdConflictError({ flowId: flow.id, contextId: owner });
    }
    this.#set(doc.id, { text, entry });
  }

  async delete(id: string): Promise<boolean> {
    this.#check();
    if (typeof id !== "string" || !this.#items.has(id)) return false;
    this.#remove(id);
    return true;
  }

  async list(query?: ContextListQuery): Promise<Page<ContextSummary>> {
    this.#check();
    const q = normalizeListQuery(query);
    const matching: IndexEntry[] = [];
    for (const { entry } of this.#items.values()) {
      if (!isAfterCursor(entry, q.after)) continue;
      if (matchesContextSearch(entry, q.needle)) matching.push(entry);
    }
    matching.sort(compareContextOrder);
    return buildContextPage(matching, q);
  }

  async locateFlow(flowId: string): Promise<string | undefined> {
    this.#check();
    return this.#flowOwner.get(flowId);
  }

  /**
   * Test hook: stores `text` for `id` without validation (e.g. an older `formatVersion`
   * document, or corrupt data). `load` deserializes (and migrates) it.
   */
  async writeRaw(id: string, text: string): Promise<void> {
    this.#check();
    assertContextId(id);
    let entry: IndexEntry;
    try {
      const doc = deserializeContext(text);
      entry = doc.id === id ? indexEntryOf(doc) : lenientIndexEntry(id, text);
    } catch {
      entry = lenientIndexEntry(id, text);
    }
    this.#set(id, { text, entry });
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #check(): void {
    if (this.#closed) throw new StoreClosedError(this.kind);
  }

  #storedRevision(id: string): number {
    return this.#items.get(id)?.entry.revision ?? 0;
  }

  #set(id: string, stored: Stored): void {
    this.#remove(id);
    this.#items.set(id, stored);
    for (const flow of stored.entry.flows) if (!this.#flowOwner.has(flow.id)) this.#flowOwner.set(flow.id, id);
  }

  #remove(id: string): void {
    const old = this.#items.get(id);
    if (!old) return;
    this.#items.delete(id);
    for (const flow of old.entry.flows) if (this.#flowOwner.get(flow.id) === id) this.#flowOwner.delete(flow.id);
  }
}
