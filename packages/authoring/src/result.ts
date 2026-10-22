/**
 * Results and errors of applying commands (docs/specs/commands.md §1).
 */
import type { BriarErrorOptions, ContextDocument, Diagnostic } from "@briarflow/core";
import { BriarError } from "@briarflow/core";
import type { Command } from "./commands.js";

/**
 * Ids created by one command. Commands that create nothing return `{}`.
 *
 * | op | keys |
 * |---|---|
 * | `type.defineStruct`, `type.defineEnum` | `typeId` |
 * | `global.create` | `globalId` |
 * | `flow.create` | `flowId`, `inputNodeId`, `outputNodeId` |
 * | `flow.duplicate` | `flowId`, `typeIds` (old local type id → new id) |
 * | `flow.variable.create` | `variableId` |
 * | `node.add` | `nodeId` |
 * | `edge.connect` | `edgeId`, `replacedEdgeId?` |
 */
export interface CreatedIds {
  typeId?: string;
  globalId?: string;
  flowId?: string;
  inputNodeId?: string;
  outputNodeId?: string;
  typeIds?: Record<string, string>;
  variableId?: string;
  nodeId?: string;
  edgeId?: string;
  replacedEdgeId?: string;
}

/** Fields shared by successful single and batch results. */
interface SuccessBase {
  ok: true;
  /** The new document (the input document when `changed` is `false`). */
  doc: ContextDocument;
  /**
   * Commands that undo this result, every one with `restore: true`. Applying them to `doc`
   * gives back the starting document (except `revision` / `updatedAt`). Empty when nothing
   * changed. `flow.setViewport` has no inverse (not undoable).
   */
  inverse: Command[];
  /**
   * The commands as applied: generated ids filled in, shorthand types replaced by IR. The
   * caller's `restore` flag is kept as given. Re-applying them to the starting document
   * produces an identical document.
   */
  resolved: Command[];
  /** Full `validateContext` output for `doc`. */
  diagnostics: Diagnostic[];
  /** `false` when the final document is deep-equal to the starting one (revision unchanged). */
  changed: boolean;
}

/** Result of applying one command. */
export type ApplyResult = (SuccessBase & { created: CreatedIds }) | { ok: false; error: CommandError };

/** Result of applying a batch: `created[i]` belongs to `commands[i]`. */
export type BatchResult = (SuccessBase & { created: CreatedIds[] }) | { ok: false; error: CommandError };

/** Options of {@link CommandError}. */
export interface CommandErrorOptions extends BriarErrorOptions {
  /** Index of the failing command in its batch. */
  commandIndex?: number;
  /** `op` of the failing command (when it had a string op). */
  op?: string;
}

/**
 * A rejected command. `code` is stable (`command.unknown_ref`, `edge.type_mismatch`,
 * `type.in_use`, …; commands.md); `message` says what, where and how to fix it.
 *
 * `details` always is an object that includes `commandIndex` and `op` (as the REST API
 * returns them, rest-api.md), plus code-specific data (e.g. `usages` for `type.in_use`).
 *
 * @example
 * ```ts
 * const r = editor.apply({ op: "flow.rename", flowId: "flow_nope", name: "X" });
 * if (!r.ok) r.error.code; // "command.unknown_ref"
 * ```
 */
export class CommandError extends BriarError {
  /** Index of the failing command in its batch (0 for `apply`). */
  readonly commandIndex: number | undefined;
  /** `op` of the failing command. */
  readonly op: string | undefined;

  constructor(code: string, message: string, options: CommandErrorOptions = {}) {
    const extra =
      options.details !== null && typeof options.details === "object" && !Array.isArray(options.details)
        ? (options.details as Record<string, unknown>)
        : options.details === undefined
          ? {}
          : { value: options.details };
    const details: Record<string, unknown> = { ...extra };
    if (options.commandIndex !== undefined) details.commandIndex = options.commandIndex;
    if (options.op !== undefined) details.op = options.op;
    super(code, message, { ...options, details });
    this.commandIndex = options.commandIndex;
    this.op = options.op;
  }

  /** A copy of this error located at `commandIndex` / `op` in a batch. */
  at(commandIndex: number, op: string | undefined): CommandError {
    const base = { ...(this.details as Record<string, unknown>) };
    delete base.commandIndex;
    delete base.op;
    const opts: CommandErrorOptions = { details: base, commandIndex };
    if (op !== undefined) opts.op = op;
    if (this.cause !== undefined) opts.cause = this.cause;
    return new CommandError(this.code, this.message, opts);
  }
}
