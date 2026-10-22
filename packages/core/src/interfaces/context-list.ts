/**
 * Helpers for `ContextStore.list` implementations (docs/specs/storage.md §1.4): query
 * normalization, search matching, list order, keyset position and page building. Shared by
 * the memory, fs and sqlite stores and available to third-party stores.
 */
import { InvalidQueryError } from "../errors.js";
import type { ContextListQuery, ContextSummary, Page } from "./context-store.js";
import type { CursorPosition } from "./cursor.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

/** Default `list` page size. */
export const CONTEXT_LIST_DEFAULT_LIMIT = 50;
/** Larger `limit`s are clamped to this. */
export const CONTEXT_LIST_MAX_LIMIT = 200;

/** What a store needs to know about a context to list it: its summary plus the description. */
export interface ContextListEntry extends ContextSummary {
  description?: string | undefined;
}

/** A validated `list` query. */
export interface NormalizedListQuery {
  /** 1…200 (default 50). */
  limit: number;
  /** Trimmed search; `""` = no filter. Goes into cursors. */
  search: string;
  /** Lowercased `search`, for {@link matchesContextSearch}. */
  needle: string;
  /** Decoded cursor position; entries must come strictly after it. */
  after: CursorPosition | undefined;
}

/**
 * Validates a `list` query: `limit` must be a whole number ≥ 1 (clamped to 200) and `search` a
 * string, else `InvalidQueryError` (`store.invalid_query`); the cursor is decoded and must
 * belong to the same search, else `InvalidCursorError` (`store.invalid_cursor`).
 *
 * @example
 * ```ts
 * const q = normalizeListQuery(query);
 * const entries = all.filter((e) => matchesContextSearch(e, q.needle) && isAfterCursor(e, q.after)).sort(compareContextOrder);
 * return buildContextPage(entries, q);
 * ```
 */
export function normalizeListQuery(query: ContextListQuery | undefined): NormalizedListQuery {
  const q = query ?? {};
  let limit = CONTEXT_LIST_DEFAULT_LIMIT;
  if (q.limit !== undefined) {
    if (typeof q.limit !== "number" || !Number.isInteger(q.limit) || q.limit < 1) {
      throw new InvalidQueryError(`list limit must be a whole number >= 1 (got ${JSON.stringify(q.limit)}).`, { details: { limit: q.limit } });
    }
    limit = Math.min(q.limit, CONTEXT_LIST_MAX_LIMIT);
  }
  if (q.search !== undefined && typeof q.search !== "string") {
    throw new InvalidQueryError(`list search must be a string (got ${JSON.stringify(q.search)}).`, { details: { search: q.search } });
  }
  const search = (q.search ?? "").trim();
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, search);
  return { limit, search, needle: search.toLowerCase(), after };
}

/**
 * Case-insensitive substring match (JS `toLowerCase`) on name, description and flow names.
 * An empty needle matches everything.
 */
export function matchesContextSearch(entry: Pick<ContextListEntry, "name" | "description" | "flows">, needle: string): boolean {
  if (needle === "") return true;
  if (entry.name.toLowerCase().includes(needle)) return true;
  if (entry.description !== undefined && entry.description.toLowerCase().includes(needle)) return true;
  return entry.flows.some((f) => f.name.toLowerCase().includes(needle));
}

/** List order for `Array.prototype.sort`: `updatedAt` descending, then `id` ascending (plain string comparison). */
export function compareContextOrder(a: { updatedAt: string; id: string }, b: { updatedAt: string; id: string }): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** True when `entry` comes strictly after the cursor position in list order (always true without one). */
export function isAfterCursor(entry: { updatedAt: string; id: string }, after: CursorPosition | undefined): boolean {
  return after === undefined || compareContextOrder(entry, after) > 0;
}

/**
 * Builds a page from entries that are already filtered, sorted with
 * {@link compareContextOrder} and positioned after the cursor. Pass at least `limit + 1`
 * entries when more exist, so `nextCursor` can be set. Items are fresh `ContextSummary`
 * objects (no description, no shared arrays).
 */
export function buildContextPage(sorted: readonly ContextListEntry[], query: NormalizedListQuery): Page<ContextSummary> {
  const items: ContextSummary[] = sorted.slice(0, query.limit).map((e) => ({
    id: e.id,
    name: e.name,
    revision: e.revision,
    updatedAt: e.updatedAt,
    flows: e.flows.map((f) => ({ id: f.id, name: f.name })),
  }));
  const page: Page<ContextSummary> = { items };
  const last = items[items.length - 1];
  if (sorted.length > query.limit && last !== undefined) {
    page.nextCursor = encodeCursor({ updatedAt: last.updatedAt, id: last.id, search: query.search });
  }
  return page;
}
