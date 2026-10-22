/**
 * Context persistence contract (docs/specs/storage.md §1). Conformance suite:
 * `describeContextStore` from `@briarflow/testing`.
 */
import type { ContextDocument } from "../documents/model.js";

/** One page of a list. `nextCursor` is present iff more items exist. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** List entry of a context. */
export interface ContextSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  /** In document order. */
  flows: { id: string; name: string }[];
}

/** Query of {@link ContextStore.list}. */
export interface ContextListQuery {
  /** Case-insensitive substring over name, description and flow names. Trimmed; empty = all. */
  search?: string;
  /** Default 50, clamped to 200; `< 1` or non-integer → `store.invalid_query`. */
  limit?: number;
  /** Opaque cursor from a previous `nextCursor` (same `search`). */
  cursor?: string;
}

/** Options of {@link ContextStore.save}. */
export interface SaveContextOptions {
  /** Stored revision must equal this (missing document = 0), else `RevisionConflictError`. */
  expectedRevision?: number;
}

/**
 * Stores context documents. Implementations persist with `serializeContext` and read with
 * `deserializeContext`; they never bump revisions.
 *
 * Errors: `RevisionConflictError`, `FlowIdConflictError`, `StoreCorruptError`,
 * `InvalidCursorError`, `InvalidQueryError`, `InvalidDocumentError`, `StoreClosedError`.
 *
 * @example
 * ```ts
 * await store.save(doc, { expectedRevision: doc.revision - 1 });
 * const again = await store.load(doc.id);
 * ```
 */
export interface ContextStore {
  /** Short name of the implementation: `"memory"`, `"fs"`, `"sqlite"`, … */
  readonly kind: string;
  /** Deep copy of the last saved document, or `undefined`. */
  load(id: string): Promise<ContextDocument | undefined>;
  /** Atomic upsert with optional revision check and flow-id uniqueness check. */
  save(doc: ContextDocument, options?: SaveContextOptions): Promise<void>;
  /** `true` if it existed. */
  delete(id: string): Promise<boolean>;
  /** Ordered by `updatedAt` desc, then `id` asc; keyset pagination. */
  list(query?: ContextListQuery): Promise<Page<ContextSummary>>;
  /** Id of the context that contains the flow, or `undefined`. Must be fast. */
  locateFlow(flowId: string): Promise<string | undefined>;
  /** Optional; idempotent. Later calls throw `store.closed`. */
  close?(): Promise<void>;
}
