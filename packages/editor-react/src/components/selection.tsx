/**
 * Selection helpers shared by the canvas shortcuts and the inspector. No React Flow import, so
 * views outside the canvas do not pull `@xyflow/react` into their chunk.
 */
import type { Command } from "@briarflow/authoring";
import type { EditorStore } from "@briarflow/editor";
import type { DispatchFn } from "../context.js";
import type { FlowView } from "../graph.js";

/** True when the event target is a text field, select or editable element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return false;
}

/**
 * Commands that delete the current selection: edges first (those not attached to removed
 * nodes), then nodes. Built-in input/output nodes are skipped.
 */
export function deleteSelectionCommands(store: EditorStore, flowId: string, view: FlowView): Command[] {
  const { selection } = store.getState();
  const nodes = selection.nodes.filter((id) => {
    const n = view.byId.get(id);
    return n !== undefined && !n.builtin;
  });
  const removed = new Set(nodes);
  const commands: Command[] = [];
  for (const edgeId of selection.edges) {
    const line = view.execEdges.find((x) => x.id === edgeId);
    if (line) {
      if (!removed.has(line.source) && !removed.has(line.target)) commands.push({ op: "exec.disconnect", flowId, edgeId });
      continue;
    }
    const e = view.edges.find((x) => x.id === edgeId);
    if (!e || removed.has(e.source) || removed.has(e.target)) continue;
    commands.push({ op: "edge.disconnect", flowId, edgeId });
  }
  for (const nodeId of nodes) commands.push({ op: "node.remove", flowId, nodeId });
  return commands;
}

/** Deletes the selection with one undo step. */
export function deleteSelection(store: EditorStore, dispatch: DispatchFn, flowId: string, view: FlowView): void {
  const commands = deleteSelectionCommands(store, flowId, view);
  if (commands.length === 0) return;
  const r = dispatch(commands);
  if (r.ok) store.clearSelection();
}
