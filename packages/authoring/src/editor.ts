/**
 * `ContextEditor`: command application plus command-based undo/redo (commands.md §1.1).
 */
import { validateContext, type ContextDocument, type Diagnostic } from "@briarflow/core";
import { applyCommands, type ApplyOptions } from "./apply.js";
import type { Command } from "./commands.js";
import type { ApplyResult, BatchResult } from "./result.js";

/** Options of {@link createContextEditor}. */
export interface ContextEditorOptions extends ApplyOptions {
  /** Maximum number of undo steps kept (default 200). Older steps are dropped. */
  historyLimit?: number;
}

/** One recorded undo step. */
export interface HistoryEntry {
  /** The resolved commands that made the change (re-applied by `redo`). */
  readonly commands: readonly Command[];
  /** Commands that undo the change (all `restore: true`). */
  readonly inverse: readonly Command[];
}

/** What caused an editor change. */
export type EditorChangeKind = "apply" | "undo" | "redo" | "reset";

/** Passed to {@link ContextEditor.subscribe} listeners after every change of `doc`. */
export interface EditorChange {
  kind: EditorChangeKind;
  /** The new current document. */
  doc: ContextDocument;
  /** The successful result that produced the change (absent for `reset`). */
  result?: Extract<BatchResult, { ok: true }>;
}

/**
 * Holds a current document, applies commands to it and keeps undo/redo stacks.
 * Synchronous; never mutates documents.
 */
export interface ContextEditor {
  /** The current document. */
  readonly doc: ContextDocument;
  /** `validateContext` output for the current document. */
  readonly diagnostics: readonly Diagnostic[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Undo steps, oldest first. */
  readonly undoStack: readonly HistoryEntry[];
  /** Redo steps, the next one to redo last. */
  readonly redoStack: readonly HistoryEntry[];
  /**
   * Applies one command. On success `doc` changes and (unless `changed` is false or the
   * command is `flow.setViewport`) an undo step is recorded and the redo stack cleared.
   */
  apply(command: Command): ApplyResult;
  /** Applies commands atomically as one undo step. */
  applyBatch(commands: readonly Command[]): BatchResult;
  /**
   * Applies the inverse of the last step as a new batch (revision goes up). Returns
   * `undefined` when there is nothing to undo. On failure the stacks are left unchanged.
   * `result.resolved` holds the commands to send to a server.
   */
  undo(): BatchResult | undefined;
  /** Re-applies the last undone step (with `restore: true`). `undefined` when nothing to redo. */
  redo(): BatchResult | undefined;
  /** Replaces the current document (e.g. after reloading from a server) and clears history. */
  reset(doc: ContextDocument): void;
  /** Clears both stacks; keeps the document. */
  clearHistory(): void;
  /** Calls `listener` after every change of `doc`. Returns an unsubscribe function. */
  subscribe(listener: (change: EditorChange) => void): () => void;
}

/**
 * Creates an editor over `doc`.
 *
 * @example
 * ```ts
 * const editor = createContextEditor(doc, { catalog, idGenerator: createSequentialIdGenerator() });
 * const r = editor.apply({ op: "flow.create", name: "Portrait", id: "flow_p" });
 * editor.undo();
 * ```
 */
export function createContextEditor(doc: ContextDocument, options: ContextEditorOptions): ContextEditor {
  const limit = Math.max(0, options.historyLimit ?? 200);
  let current = doc;
  let diagnostics: readonly Diagnostic[] | undefined;
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  const listeners = new Set<(change: EditorChange) => void>();

  const notify = (change: EditorChange) => {
    for (const l of [...listeners]) {
      try {
        l(change);
      } catch {
        // A failing listener must not break the editor.
      }
    }
  };
  const commit = (r: Extract<BatchResult, { ok: true }>, kind: EditorChangeKind) => {
    current = r.doc;
    diagnostics = r.diagnostics;
    notify({ kind, doc: current, result: r });
  };
  const run = (commands: readonly Command[]) => applyCommands(current, commands, options);

  const applyBatch = (commands: readonly Command[]): BatchResult => {
    const r = run(commands);
    if (!r.ok || !r.changed) return r;
    const undoable = commands.some((c) => c.op !== "flow.setViewport");
    if (undoable) {
      undoStack.push({ commands: r.resolved, inverse: r.inverse });
      if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
      redoStack = [];
    }
    commit(r, "apply");
    return r;
  };

  return {
    get doc() {
      return current;
    },
    get diagnostics() {
      diagnostics ??= validateContext(current, options.catalog);
      return diagnostics;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get undoStack() {
      return undoStack.slice();
    },
    get redoStack() {
      return redoStack.slice();
    },
    apply(command) {
      const r = applyBatch([command]);
      return r.ok ? { ...r, created: r.created[0] ?? {} } : r;
    },
    applyBatch,
    undo() {
      const entry = undoStack[undoStack.length - 1];
      if (!entry) return undefined;
      const r = run(entry.inverse);
      if (!r.ok) return r;
      undoStack = undoStack.slice(0, -1);
      redoStack.push(entry);
      if (r.changed) commit(r, "undo");
      return r;
    },
    redo() {
      const entry = redoStack[redoStack.length - 1];
      if (!entry) return undefined;
      const r = run(entry.commands.map((c) => ({ ...c, restore: true }) as Command));
      if (!r.ok) return r;
      redoStack = redoStack.slice(0, -1);
      undoStack.push({ commands: entry.commands, inverse: r.inverse });
      if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
      if (r.changed) commit(r, "redo");
      return r;
    },
    reset(next) {
      current = next;
      diagnostics = undefined;
      undoStack = [];
      redoStack = [];
      notify({ kind: "reset", doc: current });
    },
    clearHistory() {
      undoStack = [];
      redoStack = [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
