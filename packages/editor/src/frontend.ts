/**
 * Frontend nodes: node types whose effect happens in the editor (definition `frontend: true`).
 * On the server they are no-ops; when one completes in a run, the store rebuilds its inputs
 * (wired → the source node's output in this run, else the typed value, else the default) and
 * calls its handler. The built-in `debug.print` writes to the editor console.
 */

/** One line of the editor console. */
export interface ConsoleLine {
  /** Unique within the store. */
  readonly id: number;
  /** ISO time the line was written. */
  readonly at: string;
  readonly runId: string | undefined;
  readonly nodeId: string;
  /** Node title at the time. */
  readonly title: string;
  readonly text: string;
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

/**
 * `debug.print`: the text goes to the editor console, and to `console.log` when its
 * `browserConsole` input is on.
 *
 * @example
 * ```ts
 * createEditorStore({ backend, contextId, frontendNodes: { ...DEFAULT_FRONTEND_NODES, "my.toast": showToast } });
 * ```
 */
export const printNode: FrontendNodeHandler = ({ title, inputs, print }) => {
  const text = typeof inputs.text === "string" ? inputs.text : JSON.stringify(inputs.text ?? null);
  print(text);
  if (inputs.browserConsole === true) console.log(`[${title}] ${text}`);
};

/** The handlers the store uses unless `frontendNodes` replaces them. */
export const DEFAULT_FRONTEND_NODES: Readonly<Record<string, FrontendNodeHandler>> = { "debug.print": printNode };

/** Most lines the console keeps; older ones drop off. */
export const CONSOLE_LIMIT = 500;
