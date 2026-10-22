/**
 * Pure command application (docs/specs/commands.md). No history: see `createContextEditor`.
 */
import type { Clock, ContextDocument, IdGenerator, NodeCatalog } from "@briarflow/core";
import type { Command } from "./commands.js";
import type { ApplyResult, BatchResult } from "./result.js";
import { runBatch } from "./internal/runner.js";

/** Options of {@link applyCommands} / {@link applyCommand}. */
export interface ApplyOptions {
  /** Loaded packs: node types, config fields, ports, pack types. */
  catalog: NodeCatalog;
  /** Creates ids for commands that do not supply one. Default: `createIdGenerator()` (random). */
  idGenerator?: IdGenerator;
  /** Source of `updatedAt`. Default: `() => new Date()`. */
  clock?: Clock;
}

/**
 * Applies a batch atomically to `doc` and returns the new document. Never throws for bad
 * commands (they become `{ ok: false, error }` with `commandIndex`); never mutates `doc`.
 * Commands are validated at run time, so untyped JSON (e.g. a REST body) may be passed with a
 * cast.
 *
 * @example
 * ```ts
 * const r = applyCommands(doc, [{ op: "flow.create", name: "Portrait", id: "flow_p" }], { catalog });
 * if (r.ok) save(r.doc);
 * ```
 */
export function applyCommands(doc: ContextDocument, commands: readonly Command[], options: ApplyOptions): BatchResult {
  return runBatch(doc, commands, options);
}

/**
 * Applies one command. Same as {@link applyCommands} with a one-element batch, with
 * `created` unwrapped.
 *
 * @example
 * ```ts
 * const r = applyCommand(doc, { op: "context.rename", name: "Studio" }, { catalog });
 * ```
 */
export function applyCommand(doc: ContextDocument, command: Command, options: ApplyOptions): ApplyResult {
  const r = runBatch(doc, [command], options);
  if (!r.ok) return r;
  return { ...r, created: r.created[0] ?? {} };
}
