/**
 * @briarflow/runtime — the execution engine for Briarflow flows (docs/specs/runtime.md).
 * Shared package: web-standard primitives only.
 *
 * @example
 * ```ts
 * import { createEngine } from "@briarflow/runtime";
 * const engine = createEngine({ catalog, media, secrets });
 * const result = await engine.run({ context: doc, flowId: "flow_p", inputs: { topic: "cats" } }).result;
 * ```
 */
export const PACKAGE_NAME = "@briarflow/runtime";

export { createEngine } from "./engine.js";
export type { Engine, EngineOptions, RunOptions } from "./engine.js";
export { computeCacheKey, createMemoryCache } from "./cache.js";
export type { CacheKeyInput, MemoryCache, MemoryCacheOptions, RunCache } from "./cache.js";
export { checkRunRequest } from "./check.js";
export type { RunRequestCheck } from "./check.js";
export type { EngineExecContext, RunReuse } from "./run.js";
export type { Run, RunEvent, RunEventsOptions, RunResult, RunStatus, SerializedError } from "@briarflow/core";
