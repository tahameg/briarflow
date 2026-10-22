/**
 * Folds run events into per-node status for the canvas.
 */
import type { RunEvent, RunResult, RunStatus, SerializedError } from "@briarflow/core";

/** Canvas status of one node in a run. */
export type NodeRunStatus = "running" | "done" | "cached" | "failed" | "skipped";

/** What the canvas shows for one node. */
export interface NodeRunState {
  readonly status: NodeRunStatus;
  /** 1-based attempt while running / retrying. */
  readonly attempt?: number;
  /** Last progress fraction in [0, 1] (running only). */
  readonly progress?: number;
  /** Last progress message, or the retry reason. */
  readonly message?: string;
  /** `true` after a `node.retrying` until the next attempt starts. */
  readonly retrying?: boolean;
  readonly outputs?: Readonly<Record<string, unknown>>;
  readonly durationMs?: number;
  readonly error?: SerializedError;
  /** `node.skipped` reason and upstream cause. */
  readonly skipReason?: "upstream_failed" | "cancelled";
  readonly cause?: string;
}

/**
 * Run status in the store: the run's own status, plus `starting` (request sent) and
 * `rejected` (the backend refused to create the run; see `error`).
 */
export type EditorRunStatus = RunStatus | "starting" | "rejected";

/** The store's view of the current run. Replaced immutably on every event. */
export interface RunState {
  /** `undefined` while `starting` or after `rejected`. */
  readonly runId: string | undefined;
  readonly flowId: string;
  readonly status: EditorRunStatus;
  /** Per node id. Nodes that have not started are absent. */
  readonly nodes: Readonly<Record<string, NodeRunState>>;
  /** Last applied event `seq` (-1 before the first). */
  readonly lastSeq: number;
  /** Applied events in order (for event logs). */
  readonly events: readonly RunEvent[];
  readonly result?: RunResult;
  /** Rejection or run-level error. */
  readonly error?: SerializedError;
}

/** Applies one run event. Returns the same object for events already applied. */
export function reduceRunEvent(state: RunState, event: RunEvent): RunState {
  if (event.seq <= state.lastSeq) return state;
  const base = { ...state, lastSeq: event.seq, events: [...state.events, event] };
  const setNode = (nodeId: string, next: NodeRunState): RunState => ({ ...base, nodes: { ...state.nodes, [nodeId]: next } });
  switch (event.type) {
    case "run.started":
      return { ...base, status: "running" };
    case "node.started":
      return setNode(event.nodeId, { status: "running", attempt: event.attempt });
    case "node.progress": {
      const prev = state.nodes[event.nodeId];
      const next: NodeRunState = { ...(prev ?? {}), status: "running", progress: event.fraction };
      if (event.message !== undefined) return setNode(event.nodeId, { ...next, message: event.message });
      return setNode(event.nodeId, next);
    }
    case "node.retrying":
      return setNode(event.nodeId, {
        status: "running",
        attempt: event.attempt,
        retrying: true,
        message: event.error.message,
        error: event.error,
      });
    case "node.completed":
      return setNode(event.nodeId, {
        status: event.cached ? "cached" : "done",
        outputs: event.outputs,
        durationMs: event.durationMs,
      });
    case "node.failed":
      return setNode(event.nodeId, { status: "failed", error: event.error });
    case "node.skipped":
      return setNode(event.nodeId, {
        status: "skipped",
        skipReason: event.reason,
        ...(event.cause === undefined ? {} : { cause: event.cause }),
      });
    case "run.completed":
      return completeRun(base, event.result);
  }
}

/** Marks the run finished with `result` (also used when the result arrives without events). */
export function completeRun(state: RunState, result: RunResult): RunState {
  const next: RunState = { ...state, runId: result.runId, status: result.status, result };
  return result.error ? { ...next, error: result.error } : next;
}
