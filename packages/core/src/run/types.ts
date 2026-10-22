/**
 * Shared run types (docs/specs/runtime.md §2, §7, §8). Owned by core so that
 * `@briarflow/runtime` (local runs) and `@briarflow/client` (`RemoteRun`) implement the same
 * interface.
 */
import type { SerializedError } from "../errors.js";

/** Lifecycle state of a run. */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** States a run never leaves. */
export type TerminalRunStatus = "succeeded" | "failed" | "cancelled";

/**
 * Final outcome of a run. `outputs`, `variables`, `globalWrites` only on `succeeded`;
 * `error` only on `failed` / `cancelled`.
 */
export interface RunResult {
  runId: string;
  flowId: string;
  contextId: string;
  /** Revision of the context document the run executed. */
  contextRevision: number;
  status: TerminalRunStatus;
  /** Every output key present. */
  outputs?: Record<string, unknown>;
  /** Public flow variables by name, final values. */
  variables?: Record<string, unknown>;
  /** Written readwrite globals by name, final values. */
  globalWrites?: Record<string, unknown>;
  /** Run-level code: `run.invalid_flow`, `run.invalid_inputs`, `run.node_failed`, `run.cancelled`, `run.timeout`, `run.internal`. */
  error?: SerializedError;
  /** ISO; when the run left `queued`. */
  startedAt: string;
  finishedAt: string;
}

/** Fields on every run event. `seq` is 0-based and gap-free per run. */
export interface RunEventBase {
  runId: string;
  seq: number;
  /** ISO, from the injected clock, non-decreasing. */
  at: string;
}

/** First event of a run (absent for runs cancelled while queued). */
export interface RunStartedEvent extends RunEventBase {
  type: "run.started";
  flowId: string;
  contextId: string;
}

/** A node attempt started (also before a cache hit). `attempt` is 1-based. */
export interface NodeStartedEvent extends RunEventBase {
  type: "node.started";
  nodeId: string;
  attempt: number;
}

/** Progress report (throttled to one per 100 ms per node). */
export interface NodeProgressEvent extends RunEventBase {
  type: "node.progress";
  nodeId: string;
  /** Clamped to [0, 1]. */
  fraction: number;
  message?: string;
}

/** An attempt failed with a retryable error; the next attempt starts after `delayMs`. */
export interface NodeRetryingEvent extends RunEventBase {
  type: "node.retrying";
  nodeId: string;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  error: SerializedError;
}

/** A node finished successfully. */
export interface NodeCompletedEvent extends RunEventBase {
  type: "node.completed";
  nodeId: string;
  outputs: Record<string, unknown>;
  cached: boolean;
  durationMs: number;
}

/** A node's final attempt failed. */
export interface NodeFailedEvent extends RunEventBase {
  type: "node.failed";
  nodeId: string;
  error: SerializedError;
}

/** A node will not run. `cause` = the failed upstream node id for `upstream_failed`. */
export interface NodeSkippedEvent extends RunEventBase {
  type: "node.skipped";
  nodeId: string;
  reason: "upstream_failed" | "cancelled";
  cause?: string;
}

/** Last event of every run, exactly once; `result` equals `await run.result`. */
export interface RunCompletedEvent extends RunEventBase {
  type: "run.completed";
  result: RunResult;
}

/**
 * Every event of a run, discriminated by `type`.
 *
 * @example
 * ```ts
 * for await (const e of run.events()) {
 *   if (e.type === "node.progress") bar(e.nodeId, e.fraction);
 * }
 * ```
 */
export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeProgressEvent
  | NodeRetryingEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | RunCompletedEvent;

/** The `type` strings of run events. */
export type RunEventType = RunEvent["type"];

/** Options of {@link Run.events}. */
export interface RunEventsOptions {
  /** Only events with `seq > after`. Default: full history. */
  after?: number;
}

/**
 * One execution of a flow, local or remote.
 *
 * @example
 * ```ts
 * const run = engine.run({ context: doc, flowId: "flow_p", inputs: { topic: "cats" } });
 * const result = await run.result;
 * ```
 */
export interface Run {
  readonly id: string;
  /** Reflects the state synchronously. */
  readonly status: RunStatus;
  /** Resolves once, together with `run.completed`. Never rejects. */
  readonly result: Promise<RunResult>;
  /** Fresh iterable: past events (after `options.after`), then live ones; ends after `run.completed`. */
  events(options?: RunEventsOptions): AsyncIterable<RunEvent>;
  /** No-op on terminal runs. */
  cancel(reason?: string): void;
}
