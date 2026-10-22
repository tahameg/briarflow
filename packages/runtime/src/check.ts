/**
 * Pre-flight check of a run request (runtime.md §2.1 steps 2–4) without starting a run.
 */
import type { ContextDocument, NodeCatalog, SerializedError } from "@briarflow/core";
import { prepare } from "./prepare.js";

/** Result of {@link checkRunRequest}. */
export type RunRequestCheck = { ok: true } | { ok: false; error: SerializedError };

/**
 * Runs the same validation as the start of `engine.run` (flow exists, flow is valid, inputs
 * match the signature) and returns the error a run would fail with. Used by the facade and
 * the REST API to answer `422 run.invalid_flow` / `run.invalid_inputs` before creating a run.
 *
 * @example
 * ```ts
 * const check = checkRunRequest(doc, "flow_p", catalog, { topic: "cats" });
 * if (!check.ok) console.log(check.error.code); // "run.invalid_inputs"
 * ```
 */
export function checkRunRequest(doc: ContextDocument, flowId: string, catalog: NodeCatalog, inputs: unknown = {}): RunRequestCheck {
  const prepared = prepare(doc, flowId, catalog, inputs);
  return prepared.ok ? { ok: true } : { ok: false, error: prepared.error };
}
