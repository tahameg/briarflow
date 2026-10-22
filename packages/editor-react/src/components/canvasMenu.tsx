/**
 * The canvas's right-click menus: empty canvas (add any node at the click, undo/redo, view),
 * nodes (duplicate, disconnect, frame, delete; selection-aware), edges and ports. Also the
 * keyboard entry points (`/` add menu, ContextMenu key / Shift+F10).
 */
import { useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { Command } from "@briarflow/authoring";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE, VARIABLE_NODE_TYPES } from "@briarflow/core";
import type { Position } from "@briarflow/core";
import { useDispatch, useEditorStore } from "../context.js";
import { nextName } from "../fields.js";
import type { FlowView } from "../graph.js";
import type { ContextMenuItem, ContextMenuTarget } from "../menu.js";
import { initialConfig, paletteGroups, snap } from "../palette.js";
import { nodeAccent } from "../theme.js";
import { useContextMenu, useContextMenuContributor } from "./ContextMenu.js";
import { duplicateCommands } from "../duplicate.js";
import { deleteSelection, isTypingTarget } from "./selection.js";

const BUILTIN = new Set<string>([FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE]);
const VARIABLE_TYPES = new Set<string>(Object.values(VARIABLE_NODE_TYPES));
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** Handlers for `<ReactFlow>` plus keyboard openers. */
export interface CanvasMenu {
  onPaneContextMenu: (e: ReactMouseEvent | MouseEvent) => void;
  onNodeContextMenu: (e: ReactMouseEvent, node: RFNode) => void;
  onEdgeContextMenu: (e: ReactMouseEvent, edge: RFEdge) => void;
  onSelectionContextMenu: (e: ReactMouseEvent, nodes: RFNode[]) => void;
  /** Remembers the pointer so `/` opens the add menu under it. */
  onPointerMove: (e: ReactMouseEvent) => void;
  /** `"add"`: the empty-canvas menu at the pointer; `"selection"`: the selection's menu. */
  openFromKeyboard: (what: "add" | "selection") => void;
}

/** Installs the canvas menu contributor for `flowId` and returns the canvas handlers. */
export function useCanvasMenu(flowId: string | undefined, view: FlowView | undefined, wrapper: { current: HTMLElement | null }): CanvasMenu {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const rf = useReactFlow();
  const menu = useContextMenu();
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);

  const select = (nodes: string[], edges: string[] = []) => store.select({ nodes, edges }, "replace");
  const frame = (ids: readonly string[]) => void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.3, maxZoom: 1, duration: 200 });

  const addNode = (type: string, position: Position, config?: Record<string, unknown>) => {
    const s = store.getState();
    if (!flowId || !s.doc || !s.catalog) return;
    const cfg = config ?? initialConfig(s.catalog.get(type), s.doc, flowId, s.catalog);
    const r = dispatch({ op: "node.add", flowId, type, position, ...(cfg ? { config: cfg } : {}) });
    if (r.ok && r.created.nodeId) select([r.created.nodeId]);
  };

  const paneItems = (position: Position): ContextMenuItem[] => {
    const s = store.getState();
    const flow = view?.flow;
    const descriptors = (s.catalog?.descriptors() ?? s.nodeTypes?.nodes ?? []).filter((d) => !BUILTIN.has(d.type) && !VARIABLE_TYPES.has(d.type));
    const items: ContextMenuItem[] = paletteGroups(descriptors).map((g) => ({
      id: `add:${g.category}`,
      label: g.category,
      order: 100,
      hint: String(g.nodes.length),
      items: g.nodes.map((d) => ({
        id: `add:${d.type}`,
        label: d.title,
        hint: d.type,
        keywords: [d.category, d.description],
        accent: `var(--bf-${nodeAccent(d.color, d.category)})`,
        ...(d.description ? { title: d.description } : {}),
        run: () => addNode(d.type, position),
      })),
    }));
    const vars: ContextMenuItem[] = [];
    for (const v of flow?.variables ?? []) {
      vars.push({ id: `get:${v.id}`, label: `Get ${v.name}`, group: "var", keywords: ["variable"], accent: "var(--bf-pink)", run: () => addNode(VARIABLE_NODE_TYPES.variableGet, position, { variableId: v.id }) });
      vars.push({ id: `set:${v.id}`, label: `Set ${v.name}`, group: "var", keywords: ["variable"], accent: "var(--bf-pink)", run: () => addNode(VARIABLE_NODE_TYPES.variableSet, position, { variableId: v.id }) });
    }
    for (const g of s.doc?.globals ?? []) {
      vars.push({ id: `gget:${g.id}`, label: `Get ${g.name}`, group: "global", hint: "global", keywords: ["global"], accent: "var(--bf-pink)", run: () => addNode(VARIABLE_NODE_TYPES.globalGet, position, { globalId: g.id }) });
      if (g.access === "readwrite") {
        vars.push({ id: `gset:${g.id}`, label: `Set ${g.name}`, group: "global", hint: "global", keywords: ["global"], accent: "var(--bf-pink)", run: () => addNode(VARIABLE_NODE_TYPES.globalSet, position, { globalId: g.id }) });
      }
    }
    items.push(
      vars.length > 0
        ? { id: "add:variables", label: "Variables", order: 150, hint: String(vars.length), items: vars }
        : { id: "add:variables", label: "Variables", order: 150, disabled: true, title: "Add a variable in the Variables panel first", run: () => undefined },
    );
    const { history } = s;
    items.push(
      { id: "undo", label: "Undo", order: 200, shortcut: `${MOD}Z`, disabled: !history.canUndo, run: () => store.undo() },
      { id: "redo", label: "Redo", order: 200, shortcut: isMac ? "⇧⌘Z" : "Ctrl+Shift+Z", disabled: !history.canRedo, run: () => store.redo() },
      { id: "select-all", label: "Select all", order: 300, run: () => view && select(view.nodes.map((n) => n.id)) },
      { id: "fit", label: "Fit view", order: 300, shortcut: "F", run: () => void rf.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }) },
    );
    return items;
  };

  const nodeItems = (nodeIds: readonly string[]): ContextMenuItem[] => {
    if (!flowId || !view) return [];
    const nodes = nodeIds.map((id) => view.byId.get(id)).filter((n) => n !== undefined);
    const removable = nodes.filter((n) => !n.builtin);
    const ids = new Set(nodeIds);
    const touching = view.edges.filter((e) => ids.has(e.source) || ids.has(e.target));
    const many = removable.length > 1 ? ` ${removable.length} nodes` : "";
    const items: ContextMenuItem[] = [];
    const only = nodes.length === 1 ? nodes[0] : undefined;
    if (only?.builtin) {
      const dir = only.type === FLOW_INPUT_NODE_TYPE ? "input" : "output";
      const ports = dir === "input" ? only.outputs : only.inputs;
      items.push({
        id: "sig:add",
        label: `Add ${dir}`,
        order: 100,
        run: () => {
          const name = nextName(dir, ports.map((p) => p.name));
          dispatch(dir === "input" ? { op: "flow.input.add", flowId, name, type: "text" } : { op: "flow.output.add", flowId, name, type: "text" });
        },
      });
    }
    // Input / output nodes cannot be copied or removed: leave those entries out for them.
    const editable = removable.length > 0;
    if (editable) {
      items.push({ id: "duplicate", label: `Duplicate${many}`, order: 200, shortcut: `${MOD}D`, run: () => duplicate(removable.map((n) => n.id)) });
    }
    items.push(
      {
        id: "disconnect",
        label: touching.length > 0 ? `Disconnect (${touching.length})` : "Disconnect",
        order: 200,
        disabled: touching.length === 0,
        run: () => dispatch(touching.map<Command>((e) => ({ op: "edge.disconnect", flowId, edgeId: e.id }))),
      },
      { id: "frame", label: "Frame", order: 300, shortcut: "F", run: () => frame(nodeIds) },
    );
    if (editable) {
      items.push({
        id: "delete",
        label: `Delete${many}`,
        order: 900,
        shortcut: "Del",
        danger: true,
        run: () => {
          select(removable.map((n) => n.id));
          deleteSelection(store, dispatch, flowId, view);
        },
      });
    }
    return items;
  };

  const portItems = (nodeId: string, port: string, side: "in" | "out"): ContextMenuItem[] => {
    if (!flowId || !view) return [];
    const node = view.byId.get(nodeId);
    if (!node) return [];
    const items: ContextMenuItem[] = [];
    const edges = view.edges.filter((e) => (side === "in" ? e.target === nodeId && e.targetPort === port : e.source === nodeId && e.sourcePort === port));
    if (edges.length > 0) {
      items.push({
        id: "port:disconnect",
        label: edges.length > 1 ? `Disconnect ${port} (${edges.length})` : `Disconnect ${port}`,
        order: 50,
        group: "port",
        run: () => dispatch(edges.map<Command>((e) => ({ op: "edge.disconnect", flowId, edgeId: e.id }))),
      });
    }
    const input = side === "in" ? node.inputs.find((p) => p.name === port) : undefined;
    if (input?.hasValue && !node.builtin) {
      items.push({ id: "port:clear", label: `Clear value of ${port}`, order: 50, group: "port", run: () => dispatch({ op: "node.clearValue", flowId, nodeId, port }) });
    }
    if (node.builtin) {
      const dir = node.type === FLOW_INPUT_NODE_TYPE ? "input" : "output";
      items.push({
        id: "port:remove",
        label: `Remove ${dir} ${port}`,
        order: 60,
        group: "port",
        danger: true,
        run: () => dispatch(dir === "input" ? { op: "flow.input.remove", flowId, name: port } : { op: "flow.output.remove", flowId, name: port }),
      });
    }
    return [...items, ...nodeItems([nodeId])];
  };

  const edgeItems = (edgeId: string): ContextMenuItem[] => {
    const e = view?.edges.find((x) => x.id === edgeId);
    if (!e || !flowId) return [];
    const go = (id: string) => {
      select([id]);
      frame([id]);
    };
    return [
      { id: "edge:source", label: `Go to ${view?.byId.get(e.source)?.title ?? "source"}`, hint: e.sourcePort, order: 800, run: () => go(e.source) },
      { id: "edge:target", label: `Go to ${view?.byId.get(e.target)?.title ?? "target"}`, hint: e.targetPort, order: 800, run: () => go(e.target) },
      { id: "edge:delete", label: "Delete connection", order: 900, shortcut: "Del", danger: true, run: () => dispatch({ op: "edge.disconnect", flowId, edgeId }) },
    ];
  };

  function duplicate(ids: readonly string[]) {
    const flow = store.getState().doc?.flows.find((f) => f.id === flowId);
    if (!flow || ids.length === 0) return;
    const { commands, ids: created } = duplicateCommands(flow, ids);
    if (commands.length === 0) return;
    const r = dispatch(commands);
    if (r.ok) select([...created.values()]);
  }

  useContextMenuContributor((t: ContextMenuTarget) => {
    if (!flowId || !("flowId" in t) || t.flowId !== flowId) return null;
    switch (t.kind) {
      case "pane":
        return paneItems(t.position);
      case "node":
        return nodeItems(t.nodeIds);
      case "port":
        return portItems(t.nodeId, t.port, t.side);
      case "edge":
        return edgeItems(t.edgeId);
      default:
        return null;
    }
  });

  const toFlow = (x: number, y: number) => snap(rf.screenToFlowPosition({ x, y }));

  const selectionTarget = (nodeId: string): ContextMenuTarget | undefined => {
    if (!flowId) return undefined;
    const sel = store.getState().selection.nodes;
    if (!sel.includes(nodeId)) {
      select([nodeId]);
      return { kind: "node", flowId, nodeId, nodeIds: [nodeId] };
    }
    return { kind: "node", flowId, nodeId, nodeIds: sel };
  };

  return {
    onPaneContextMenu: (e) => {
      if (!flowId) return;
      menu.open(e as ReactMouseEvent, { kind: "pane", flowId, position: toFlow(e.clientX, e.clientY) });
    },
    onNodeContextMenu: (e, node) => {
      if (!flowId || isTypingTarget(e.target)) return;
      const handle = e.target instanceof Element ? e.target.closest<HTMLElement>(".react-flow__handle") : null;
      const handleId = handle?.dataset.handleid;
      if (handleId) {
        menu.open(e, { kind: "port", flowId, nodeId: node.id, port: handleId.slice(2), side: handleId.startsWith("i:") ? "in" : "out" });
        return;
      }
      const target = selectionTarget(node.id);
      if (target) menu.open(e, target);
    },
    onEdgeContextMenu: (e, edge) => {
      if (!flowId) return;
      select([], [edge.id]);
      menu.open(e, { kind: "edge", flowId, edgeId: edge.id });
    },
    onSelectionContextMenu: (e, nodes) => {
      const first = nodes[0];
      if (!flowId || !first) return;
      menu.open(e, { kind: "node", flowId, nodeId: first.id, nodeIds: nodes.map((n) => n.id) });
    },
    onPointerMove: useCallback((e: ReactMouseEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    }, []),
    openFromKeyboard: (what) => {
      if (!flowId) return;
      const box = wrapper.current?.getBoundingClientRect();
      const center = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
      const inside = (p: { x: number; y: number } | undefined) => p !== undefined && box !== undefined && p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
      const sel = store.getState().selection.nodes;
      if (what === "selection" && sel.length > 0 && view) {
        const n = view.byId.get(sel[0]!);
        const at = n ? rf.flowToScreenPosition(n.position) : center;
        menu.open({ x: at.x, y: at.y, element: wrapper.current }, { kind: "node", flowId, nodeId: sel[0]!, nodeIds: sel });
        return;
      }
      const at = inside(pointer.current) ? pointer.current! : center;
      menu.open({ x: at.x, y: at.y, element: wrapper.current }, { kind: "pane", flowId, position: toFlow(at.x, at.y) });
    },
  };
}
