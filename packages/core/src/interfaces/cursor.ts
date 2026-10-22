/**
 * Keyset cursor helpers for `ContextStore.list` implementations (docs/specs/storage.md §1.4,
 * §4). A cursor is base64url JSON of `{ updatedAt, id, search }`.
 */
import { InvalidCursorError } from "../errors.js";

/** Position after which the next page starts, plus the search it belongs to. */
export interface CursorPosition {
  updatedAt: string;
  id: string;
  /** Normalized (trimmed) search, `""` for none. */
  search: string;
}

/**
 * Encodes a cursor (base64url, no padding).
 *
 * @example
 * ```ts
 * const nextCursor = encodeCursor({ updatedAt: last.updatedAt, id: last.id, search });
 * ```
 */
export function encodeCursor(position: CursorPosition): string {
  const json = JSON.stringify({ updatedAt: position.updatedAt, id: position.id, search: position.search });
  let binary = "";
  for (const b of new TextEncoder().encode(json)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes a cursor. Throws `InvalidCursorError` (`store.invalid_cursor`) when it is malformed
 * or, if `expectedSearch` is given, belongs to another (normalized) search.
 *
 * @example
 * ```ts
 * const after = query.cursor ? decodeCursor(query.cursor, search) : undefined;
 * ```
 */
export function decodeCursor(cursor: string, expectedSearch?: string): CursorPosition {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new InvalidCursorError();
  }
  const p = parsed as Partial<CursorPosition> | null;
  if (typeof p !== "object" || p === null || typeof p.updatedAt !== "string" || typeof p.id !== "string" || typeof p.search !== "string") {
    throw new InvalidCursorError();
  }
  if (expectedSearch !== undefined && expectedSearch.trim() !== p.search.trim()) throw new InvalidCursorError();
  return { updatedAt: p.updatedAt, id: p.id, search: p.search };
}
