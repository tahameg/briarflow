/**
 * Transport between the editor store and wherever documents live (a REST server through
 * `@briarflow/client`, or an in-process backend in tests and offline apps).
 */
import type { Command } from "@briarflow/authoring";
import type { BriarClient, NodeTypesInfo } from "@briarflow/client";
import type { ContextDocument, Diagnostic, Run } from "@briarflow/core";

/** Body of {@link EditorBackend.apply}. */
export interface BackendApplyInput {
  /** Revision the commands were made against. */
  baseRevision: number;
  commands: readonly Command[];
}

/** Response of {@link EditorBackend.apply}. */
export interface BackendApplyResult {
  /** The backend's revision after the batch (unchanged when `changed` is false). */
  revision: number;
  changed: boolean;
  /** Optional: the backend's diagnostics after the batch (the store uses its own). */
  diagnostics?: Diagnostic[];
}

/** Options of {@link EditorBackend.run}. */
export interface BackendRunOptions {
  useCache?: boolean;
  signal?: AbortSignal;
}

/**
 * What the editor store needs from a backend.
 *
 * Error contract of `apply` (anything else counts as a transient sync failure):
 * - a stale `baseRevision` throws an error with `code === "store.revision_conflict"`
 *   (`RevisionConflictError` from the client);
 * - a rejected command throws an error whose `details.commandIndex` is a number
 *   (`CommandError` from the client or from `@briarflow/authoring`).
 *
 * @example
 * ```ts
 * const backend = clientBackend(createBriarClient({ baseUrl: "http://localhost:3000/api/v1" }));
 * const store = createEditorStore({ backend, contextId: "ctx_1" });
 * ```
 */
export interface EditorBackend {
  /** The full current document. */
  load(contextId: string, signal?: AbortSignal): Promise<ContextDocument>;
  /** Applies a command batch made against `baseRevision`. */
  apply(contextId: string, input: BackendApplyInput, signal?: AbortSignal): Promise<BackendApplyResult>;
  /** Packs, node descriptors and pack types available to the context. */
  nodeTypes(signal?: AbortSignal): Promise<NodeTypesInfo>;
  /** Starts a run of a flow on the backend. */
  run(flowId: string, inputs: Record<string, unknown>, options?: BackendRunOptions): Promise<Run>;
}

/**
 * Adapts a `BriarClient` to {@link EditorBackend}.
 *
 * @example
 * ```ts
 * const store = createEditorStore({ backend: clientBackend(client), contextId: "ctx_1" });
 * ```
 */
export function clientBackend(client: BriarClient): EditorBackend {
  const sig = (signal?: AbortSignal) => (signal ? { signal } : {});
  return {
    load: (contextId, signal) => client.contexts.get(contextId, sig(signal)),
    async apply(contextId, input, signal) {
      const r = await client.contexts.apply(contextId, { baseRevision: input.baseRevision, commands: input.commands }, sig(signal));
      return { revision: r.revision, changed: r.changed, diagnostics: r.diagnostics };
    },
    nodeTypes: (signal) => client.nodeTypes.list(sig(signal)),
    run: (flowId, inputs, options = {}) =>
      client.flows.run(flowId, inputs, {
        ...(options.useCache === undefined ? {} : { useCache: options.useCache }),
        ...sig(options.signal),
      }),
  };
}

/** True for a stale-revision error (`store.revision_conflict`). */
export function isRevisionConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "store.revision_conflict";
}

/** True for a rejected command batch (an error with a numeric `details.commandIndex`). */
export function isCommandRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const details = (err as { details?: unknown }).details;
  return typeof details === "object" && details !== null && typeof (details as { commandIndex?: unknown }).commandIndex === "number";
}
