/**
 * Frontend nodes: node types whose effect happens in the editor (definition `frontend: true`).
 * On the server they are no-ops; when one completes in a run, the store rebuilds its inputs
 * (wired → the source node's output in this run, else the typed value, else the default) and
 * calls its handler. The built-in `debug.print` writes to the editor console.
 */

/**
 * Kinds of console lines: `print` (frontend nodes), `info` (run started / finished),
 * `warning` (retries), `error` (failed nodes, rejected or failed runs), `output` (a run output).
 */
export type ConsoleKind = "print" | "info" | "warning" | "error" | "output";

/** One line of the editor console: everything a run reports, in one list. */
export interface ConsoleLine {
  /** Unique within the store. */
  readonly id: number;
  readonly kind: ConsoleKind;
  /** ISO time the line was written. */
  readonly at: string;
  readonly runId: string | undefined;
  /** The node the line is about, when there is one. */
  readonly nodeId?: string;
  /** Node type of `nodeId`. */
  readonly nodeType?: string;
  /** Node title at the time, or the flow / output name for run lines. */
  readonly title: string;
  readonly text: string;
  /** Error or diagnostic code (`error` / `warning`). */
  readonly code?: string;
  /** Raw value of an `output` line (media previews). */
  readonly value?: unknown;
}

/** What a frontend node handler receives. */
export interface FrontendNodeCall {
  readonly runId: string | undefined;
  readonly nodeId: string;
  readonly title: string;
  /** The node's input values in this run. A wired input whose source has no value yet is absent. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Writes a line to the editor console. */
  print(text: string): void;
}

/** Runs a frontend node's effect in the editor. */
export type FrontendNodeHandler = (call: FrontendNodeCall) => void;

/** What `debug.print` writes when its text has no value. */
export const PRINT_NONE = "[none]";

/**
 * `debug.print`: the text goes to the editor console, and to `console.log` when its
 * `browserConsole` input is on. A missing or `null` text prints {@link PRINT_NONE}.
 *
 * @example
 * ```ts
 * createEditorStore({ backend, contextId, frontendNodes: { ...DEFAULT_FRONTEND_NODES, "my.toast": showToast } });
 * ```
 */
export const printNode: FrontendNodeHandler = ({ title, inputs, print }) => {
  const value = inputs.text;
  const text = value === null || value === undefined ? PRINT_NONE : typeof value === "string" ? value : JSON.stringify(value);
  print(text);
  if (inputs.browserConsole === true) console.log(`[${title}] ${text}`);
};

/** The handlers the store uses unless `frontendNodes` replaces them. */
export const DEFAULT_FRONTEND_NODES: Readonly<Record<string, FrontendNodeHandler>> = { "debug.print": printNode };

/** Most lines the console keeps; older ones drop off. */
export const CONSOLE_LIMIT = 500;
