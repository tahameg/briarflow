/**
 * Store-internal helpers for ContextStore implementations (docs/specs/storage.md §1). The list
 * rules (query, search, order, pages) come from `@briarflow/core` (REQ-19).
 *
 * A copy of `common.ts` in `@briarflow/storage-fs` / `@briarflow/storage-sqlite` (stores do not
 * depend on each other or on the facade). Internal: not exported from the package entry.
 */
import { BriarError, CONTEXT_FORMAT, InvalidDocumentError, deserializeContext, isBriarError, isValidId, serializeContext } from "@briarflow/core";
import type { ContextDocument, ContextListEntry } from "@briarflow/core";

/**
 * Throws `BriarError("document.invalid_id")` unless `id` is a valid context id (REQ-15).
 * Used by public store methods that address a stored document by id (`pathFor`, `writeRaw`).
 */
export function assertContextId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !isValidId("context", id)) {
    throw new BriarError(
      "document.invalid_id",
      `Context id ${JSON.stringify(id)} is invalid: expected ctx_ followed by 1–60 of A–Z, a–z, 0–9, _ or -.`,
      { details: { id } },
    );
  }
}

/** What a store keeps in its list index for one context (core's `ContextListEntry`). */
export type IndexEntry = ContextListEntry;

/**
 * Checks a document passed to `save` and returns its serialized text.
 * Throws `InvalidDocumentError` (`store.invalid_document`) for anything that is not a
 * structurally valid context document (wrong `format`, bad id, non-JSON values, …).
 */
export function serializeForSave(doc: ContextDocument): string {
  const raw = doc as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidDocumentError("Only context documents can be saved: expected an object.");
  }
  const d = raw as Record<string, unknown>;
  if (d["format"] !== CONTEXT_FORMAT) {
    throw new InvalidDocumentError(`Only context documents can be saved: format must be "${CONTEXT_FORMAT}".`);
  }
  if (typeof d["id"] !== "string" || !isValidId("context", d["id"])) {
    throw new InvalidDocumentError(`Cannot save a context with id ${JSON.stringify(d["id"])}: expected ctx_ followed by 1–60 of A–Z, a–z, 0–9, _ or -.`, {
      details: { id: d["id"] },
    });
  }
  let text: string;
  try {
    text = serializeContext(doc);
    deserializeContext(text);
  } catch (err) {
    if (!isBriarError(err)) throw err;
    throw new InvalidDocumentError(`Cannot save context "${d["id"]}": ${err.message}`, { cause: err, details: { id: d["id"] } });
  }
  return text;
}

/** Index entry of a (valid) document. */
export function indexEntryOf(doc: ContextDocument): IndexEntry {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    flows: doc.flows.map((f) => ({ id: f.id, name: f.name })),
  };
}

/**
 * Lenient index entry for raw text written through a store's `writeRaw` hook (e.g. an older
 * format version): reads what it can, falls back to placeholders.
 */
export function lenientIndexEntry(id: string, text: string): IndexEntry {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // keep placeholders
  }
  const flows = Array.isArray(raw["flows"])
    ? (raw["flows"] as unknown[]).flatMap((f) => {
        const flow = f as Record<string, unknown> | null;
        return typeof flow === "object" && flow !== null && typeof flow["id"] === "string"
          ? [{ id: flow["id"], name: typeof flow["name"] === "string" ? flow["name"] : flow["id"] }]
          : [];
      })
    : [];
  return {
    id,
    name: typeof raw["name"] === "string" ? raw["name"] : id,
    description: typeof raw["description"] === "string" ? raw["description"] : undefined,
    revision: typeof raw["revision"] === "number" && Number.isInteger(raw["revision"]) ? raw["revision"] : 0,
    updatedAt: typeof raw["updatedAt"] === "string" ? raw["updatedAt"] : "1970-01-01T00:00:00.000Z",
    flows,
  };
}
