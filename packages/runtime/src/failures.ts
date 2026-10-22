/**
 * Internal: turning thrown values into node failures (docs/specs/node-api.md §6, runtime.md §5).
 */
import { isBriarError, NodeError, serializeError, type SerializedError } from "@briarflow/core";

/** A failed attempt or node, ready to emit. */
export interface NodeFailure {
  error: SerializedError;
  retryable: boolean;
  retryAfterMs?: number;
}

const NEVER_RETRIED = new Set(["node.invalid_input", "node.invalid_output", "node.missing_secret", "node.cancelled"]);

/** A failure from a code and message (engine-made errors). */
export function failure(code: string, message: string, nodeId: string, options: { details?: unknown; retryable?: boolean } = {}): NodeFailure {
  const err = new NodeError(code, message, options.details === undefined ? {} : { details: options.details });
  const retryable = options.retryable ?? err.retryable;
  return { error: { ...err.toJSON(), retryable, nodeId }, retryable: retryable && !NEVER_RETRIED.has(code) };
}

function retryAfter(details: unknown): number | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const v = (details as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Classifies anything a node threw: `NodeError`s keep their code; a `TypeError` thrown by
 * `ctx.fetch` becomes retryable `node.unavailable`; anything else becomes `node.failed` with
 * the original message (Briarflow errors are kept as `cause`).
 */
export function classify(thrown: unknown, nodeId: string, fetchErrors: WeakSet<object>): NodeFailure {
  if (isBriarError(thrown) && typeof (thrown as { retryable?: unknown }).retryable === "boolean") {
    const serialized = serializeError(thrown);
    const retryable = (thrown as unknown as { retryable: boolean }).retryable;
    const out: NodeFailure = {
      error: { ...serialized, retryable, nodeId },
      retryable: retryable && !NEVER_RETRIED.has(thrown.code),
    };
    const after = retryAfter(thrown.details);
    if (after !== undefined) out.retryAfterMs = after;
    return out;
  }
  if (thrown instanceof TypeError && fetchErrors.has(thrown)) {
    return failure("node.unavailable", `Network request failed: ${thrown.message}`, nodeId, { retryable: true });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const err = new NodeError("node.failed", message, isBriarError(thrown) ? { cause: thrown } : {});
  return { error: { ...err.toJSON(), nodeId }, retryable: false };
}
