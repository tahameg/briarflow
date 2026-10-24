/**
 * Folds run events into per-node status for the canvas.
 */
import type { LastRun, RunEvent, RunResult, RunStatus, SerializedError } from "@briarflow/core";

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
  /** Loaded from the flow's last run (`backend.lastRun`), not watched live. */
  readonly restored?: boolean;
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

/**
 * The canvas view of a flow's last run, as the server kept it. `undefined` for a run that is
 * still going (its record has no node results yet).
 */
export function runStateFromLastRun(last: LastRun): RunState | undefined {
  if (last.status === "running") return undefined;
  const nodes: Record<string, NodeRunState> = {};
  for (const [id, n] of Object.entries(last.nodes)) {
    if (n.state === "completed") {
      nodes[id] = { status: n.cached ? "cached" : "done", ...(n.outputs ? { outputs: n.outputs } : {}), ...(n.durationMs === undefined ? {} : { durationMs: n.durationMs }) };
    } else if (n.state === "failed") {
      nodes[id] = { status: "failed", ...(n.error ? { error: n.error } : {}) };
    } else {
      nodes[id] = { status: "skipped", ...(n.skipReason ? { skipReason: n.skipReason } : {}), ...(n.cause === undefined ? {} : { cause: n.cause }) };
    }
  }
  const base = { runId: last.runId, flowId: last.flowId, nodes, lastSeq: -1, events: [], restored: true } as const;
  if (last.status === "interrupted") {
    return { ...base, status: "failed", error: { code: "run.interrupted", message: "The server stopped while this run was going." } };
  }
  const state: RunState = { ...base, status: last.status, ...(last.result ? { result: last.result } : {}) };
  return last.result?.error ? { ...state, error: last.result.error } : state;
}
