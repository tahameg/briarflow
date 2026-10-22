/**
 * Where a diagnostic points. Every key is optional; set as many as apply.
 */
export interface DiagnosticPath {
  flowId?: string;
  nodeId?: string;
  port?: string;
  edgeId?: string;
  typeId?: string;
  field?: string;
  variableId?: string;
  globalId?: string;
  /**
   * Dotted path into a value, rooted at the validated place (types.md §7):
   * `inputs.character.age`, `nodes.n_tpl1.values.template`, `inputs.characters[2].name`.
   */
  valuePath?: string;
}

/**
 * A validation finding. `code` is stable (`area.snake_case`, e.g. `edge.type_mismatch`);
 * `message` is a human sentence saying what, where and how to fix it.
 *
 * @example
 * ```ts
 * const d: Diagnostic = {
 *   severity: "error",
 *   code: "input.unconnected",
 *   message: 'Text template (n_tpl) needs a value for "name". Connect an edge or type a constant.',
 *   path: { flowId: "flow_p", nodeId: "n_tpl", port: "name" },
 * };
 * ```
 */
export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  path: DiagnosticPath;
  /** Optional structured data (e.g. `{ usages }`, `{ cycle: [...] }`). JSON. */
  details?: unknown;
}

/**
 * True when at least one diagnostic is an error.
 *
 * @example
 * ```ts
 * if (hasErrors(validateFlow(doc, flowId, catalog))) …
 * ```
 */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
