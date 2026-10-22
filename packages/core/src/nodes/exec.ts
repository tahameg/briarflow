/**
 * What a node's `run` receives (docs/specs/node-api.md §6).
 */
import type { NodeInstance, TypeDecl } from "../documents/model.js";
import type { Logger } from "../interfaces/logger.js";
import type { MediaStore } from "../interfaces/media-store.js";

/**
 * Per-execution services for a node. Created by the engine; tests use `runNode` from
 * `@briarflow/testing` (phase 3/4).
 */
export interface ExecContext {
  /** Aborted on cancel or timeout. Pass it to every `fetch`/SDK call. */
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly flowId: string;
  readonly nodeId: string;
  /** 1-based attempt number. */
  readonly attempt: number;
  /** Reports progress; `fraction` clamped to [0, 1], NaN ignored, message ≤ 200 chars. */
  progress(fraction: number, message?: string): void;
  /** Tagged with runId/nodeId. */
  readonly log: Logger;
  readonly media: MediaStore;
  /**
   * Secrets the definition declared in `secrets`. Resolved before the first attempt; an
   * undeclared name throws `NodeError("node.secret_not_declared")`.
   */
  readonly secrets: { get(name: string): Promise<string> };
  /** Run-start snapshot of globals, by name. Unknown → `NodeError("variable.unknown")`. Read-only. */
  readonly globals: { get(name: string): unknown };
  /** Run-start values of flow variables, by name. Read-only. */
  readonly variables: { get(name: string): unknown };
  /** Injectable fetch (engine option); use it instead of the global. */
  readonly fetch: typeof fetch;
  /**
   * Type declaration visible in the node's flow (local → global → pack), e.g. the struct a
   * `cfg.typeId()` config points at. `undefined` for unknown ids.
   */
  resolveType(id: string): TypeDecl | undefined;
}

/**
 * Argument of `run`.
 *
 * @example
 * ```ts
 * async run({ inputs, config, ctx }) { … }
 * ```
 */
export interface NodeRunArgs<I, C> {
  /** Resolved, validated inputs (edge → constant → default → null). */
  inputs: I;
  /** Validated config with defaults applied. */
  config: C;
  /** The node instance being executed. */
  node: NodeInstance;
  ctx: ExecContext;
}
