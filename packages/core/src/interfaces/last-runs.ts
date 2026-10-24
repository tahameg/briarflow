/**
 * The last run of each flow (docs/specs/media.md §5): what the run made, kept until the next run
 * of the flow replaces it, so previews survive reloads and unchanged media nodes are carried
 * over instead of run again.
 */
import type { SerializedError } from "../errors.js";
import type { RunResult, TerminalRunStatus } from "../run/types.js";

/** What the last run recorded for one node. */
export interface LastRunNode {
  state: "completed" | "failed" | "skipped";
  outputs?: Record<string, unknown>;
  error?: SerializedError;
  /** Taken from the cache or carried over from the run before. */
  cached?: boolean;
  durationMs?: number;
  skipReason?: "upstream_failed" | "cancelled";
  /** Node id an upstream failure came from. */
  cause?: string;
  /** Reuse key of a node that makes media (runtime.md §6): same key → same result. */
  key?: string;
}

/**
 * The last run of a flow. `interrupted`: the server stopped while it was running.
 */
export interface LastRun {
  runId: string;
  contextId: string;
  flowId: string;
  /** Revision of the context document the run executed. */
  revision: number;
  status: "running" | TerminalRunStatus | "interrupted";
  /** ISO; when the run was requested. */
  requestedAt: string;
  finishedAt?: string;
  inputs: Record<string, unknown>;
  /** By node id. Nodes that did not finish are absent. */
  nodes: Record<string, LastRunNode>;
  result?: RunResult;
}

/**
 * Keeps one {@link LastRun} per flow.
 *
 * @example
 * ```ts
 * await lastRuns.set(record);
 * const last = await lastRuns.get(contextId, flowId);
 * ```
 */
export interface LastRunStore {
  readonly kind: string;
  get(contextId: string, flowId: string): Promise<LastRun | undefined>;
  /** Replaces the flow's record. */
  set(run: LastRun): Promise<void>;
  /** `true` if it existed. */
  delete(contextId: string, flowId: string): Promise<boolean>;
  /** Every record (startup clean-up). */
  list(): Promise<LastRun[]>;
  close?(): void | Promise<void>;
}

/**
 * Last runs in memory.
 *
 * @example
 * ```ts
 * const lastRuns = createMemoryLastRuns();
 * ```
 */
export function createMemoryLastRuns(): LastRunStore {
  const runs = new Map<string, string>();
  const key = (contextId: string, flowId: string) => JSON.stringify([contextId, flowId]);
  return {
    kind: "memory",
    async get(contextId, flowId) {
      const text = runs.get(key(contextId, flowId));
      return text === undefined ? undefined : (JSON.parse(text) as LastRun);
    },
    async set(run) {
      runs.set(key(run.contextId, run.flowId), JSON.stringify(run));
    },
    async delete(contextId, flowId) {
      return runs.delete(key(contextId, flowId));
    },
    async list() {
      return [...runs.values()].map((text) => JSON.parse(text) as LastRun);
    },
  };
}
