/**
 * `<DiagnosticsList>`: validation findings; clicking one opens its flow and selects the node
 * or edge.
 */
import type { Diagnostic } from "@briarflow/core";
import { useEditorState, useEditorStore } from "../context.js";
import { Badge } from "./ui.js";

/** Props of {@link DiagnosticsList}. */
export interface DiagnosticsListProps {
  /** Only findings of this flow / node / edge. */
  flowId?: string | undefined;
  nodeId?: string | undefined;
  edgeId?: string | undefined;
  /** Shown when there is nothing to list. */
  emptyText?: string;
  /** Called after a finding was clicked (e.g. close a popover). */
  onSelect?: (d: Diagnostic) => void;
  /** List these findings instead of the store's (e.g. a rejected run's `details.diagnostics`). */
  items?: readonly Diagnostic[] | undefined;
}

/** Filters diagnostics by path. */
export function filterDiagnostics(all: readonly Diagnostic[], f: { flowId?: string | undefined; nodeId?: string | undefined; edgeId?: string | undefined }): Diagnostic[] {
  return all.filter((d) => (f.flowId === undefined || d.path.flowId === f.flowId) && (f.nodeId === undefined || d.path.nodeId === f.nodeId) && (f.edgeId === undefined || d.path.edgeId === f.edgeId));
}

/**
 * @example
 * ```tsx
 * <DiagnosticsList flowId={flowId} />
 * ```
 */
export function DiagnosticsList({ flowId, nodeId, edgeId, emptyText = "No problems found.", onSelect, items: given }: DiagnosticsListProps) {
  const store = useEditorStore();
  const fromStore = useEditorState((s) => s.diagnostics);
  const all = given ?? fromStore;
  // Errors first (design-system §11 PROBLEMS).
  const items = filterDiagnostics(all, { flowId, nodeId, edgeId }).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  if (items.length === 0) return <p className="bf-muted bf-diagnostics__empty">{emptyText}</p>;
  const pick = (d: Diagnostic) => {
    if (d.path.flowId) store.setActiveFlow(d.path.flowId);
    if (d.path.nodeId) store.select({ nodes: [d.path.nodeId], edges: [] }, "replace");
    else if (d.path.edgeId) store.select({ nodes: [], edges: [d.path.edgeId] }, "replace");
    onSelect?.(d);
  };
  return (
    <ul className="bf-diagnostics" aria-label="Diagnostics">
      {items.map((d, i) => {
        const clickable = d.path.nodeId !== undefined || d.path.edgeId !== undefined || d.path.flowId !== undefined;
        const body = (
          <>
            <Badge tone={d.severity === "error" ? "danger" : "peach"}>{d.severity === "error" ? "error" : "warn"}</Badge>
            <span className="bf-diagnostics__msg">{d.message}</span>
            <span className="bf-diagnostics__code">{d.code}</span>
          </>
        );
        return (
          <li key={`${d.code}-${i}`} className={`bf-diagnostics__item bf-diagnostics__item--${d.severity}`}>
            {clickable ? (
              <button type="button" className="bf-diagnostics__btn" onClick={() => pick(d)}>
                {body}
              </button>
            ) : (
              <div className="bf-diagnostics__btn">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
