/**
 * Editor keyboard shortcuts (design-system.md §11): Delete/Backspace removes the selection,
 * Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo, Ctrl/Cmd+D duplicates, Escape clears the
 * selection, F frames the selection, `/` focuses the palette search (or opens the add menu),
 * the ContextMenu key / Shift+F10 opens the selection's menu. Ignored while typing in a field.
 */
import { useEffect } from "react";
import type { RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { useDispatch, useEditorStore } from "../context.js";
import type { FlowView } from "../graph.js";
import { duplicateCommands } from "../duplicate.js";
import { deleteSelection, isTypingTarget } from "./selection.js";

/** Installs the canvas shortcuts on `window` while the canvas is mounted. */
export function useEditorShortcuts(
  flowId: string | undefined,
  view: FlowView | undefined,
  _wrapper: RefObject<HTMLDivElement | null>,
  openMenu?: (what: "add" | "selection") => void,
): void {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && key === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod && key === "d" && flowId) {
        e.preventDefault();
        const flow = store.getState().doc?.flows.find((f) => f.id === flowId);
        const { commands, ids } = flow ? duplicateCommands(flow, store.getState().selection.nodes) : { commands: [], ids: new Map<string, string>() };
        if (commands.length > 0 && dispatch(commands).ok) store.select({ nodes: [...ids.values()] }, "replace");
        return;
      }
      if (openMenu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
        e.preventDefault();
        openMenu("selection");
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === "Escape") {
        store.clearSelection();
        return;
      }
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-bf-palette-search]");
        e.preventDefault();
        if (search) search.focus();
        else openMenu?.("add");
        return;
      }
      if (!flowId || !view) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection(store, dispatch, flowId, view);
        return;
      }
      if (key === "f") {
        const ids = store.getState().selection.nodes;
        void rf.fitView(ids.length > 0 ? { nodes: ids.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 0 } : { padding: 0.2, maxZoom: 1, duration: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, dispatch, rf, flowId, view, openMenu]);
}
