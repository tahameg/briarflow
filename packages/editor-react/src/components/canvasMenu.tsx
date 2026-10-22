/**
 * The canvas's right-click menus: empty canvas (add any node at the click, undo/redo, view),
 * nodes (duplicate, disconnect, frame, delete; selection-aware), edges and ports. A wire
 * dropped on empty canvas opens the nodes that can take it. Also the keyboard entry points
 * (`/` add menu, ContextMenu key / Shift+F10).
 */
import { useCallback, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import type { Edge as RFEdge, FinalConnectionState, Node as RFNode, XYPosition } from "@xyflow/react";
import type { Command } from "@briarflow/authoring";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE, VARIABLE_NODE_TYPES } from "@briarflow/core";
import type { Position } from "@briarflow/core";
import type { LedFamily } from "../theme.js";
import { useDispatch, useEditorStore } from "../context.js";
import { nextName } from "../fields.js";
import type { FlowView } from "../graph.js";
import type { ContextMenuItem, ContextMenuTarget, ContextMenuTargets } from "../menu.js";
import { initialConfig, paletteGroups, snap } from "../palette.js";
import { nodeAccent } from "../theme.js";
import { useContextMenu, useContextMenuContributor } from "./ContextMenu.js";
import { duplicateCommands, randomNodeId } from "../duplicate.js";
import { matchConnectTargets } from "../connect.js";
import type { ConnectProbe } from "../connect.js";
import { deleteSelection, isTypingTarget } from "./selection.js";

const BUILTIN = new Set<string>([FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE]);
const VARIABLE_TYPES = new Set<string>(Object.values(VARIABLE_NODE_TYPES));
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/** A dropped wire kept on screen while its "connect" menu is open (flow coordinates). */
export interface GhostWire {
  /** The handle it was dragged from. */
  from: XYPosition;
  /** The drop point. */
  to: XYPosition;
  /** Dragged from an output (`"out"`) or an input. */
  side: "in" | "out";
  /** Cable color: a data family, or `exec` for an execution line. */
  family: LedFamily | "exec";
}

/** Handlers for `<ReactFlow>` plus keyboard openers. */
export interface CanvasMenu {
  onPaneContextMenu: (e: ReactMouseEvent | MouseEvent) => void;
  onNodeContextMenu: (e: ReactMouseEvent, node: RFNode) => void;
  onEdgeContextMenu: (e: ReactMouseEvent, edge: RFEdge) => void;
  onSelectionContextMenu: (e: ReactMouseEvent, nodes: RFNode[]) => void;
  /** A wire released on empty canvas: open the nodes that can take it. */
  onConnectEnd: (e: MouseEvent | TouchEvent, state: FinalConnectionState) => void;
  /** The dropped wire while its menu is open. */
  ghost: GhostWire | undefined;
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
  const [ghost, setGhost] = useState<GhostWire | undefined>(undefined);

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
        hint: d.frontend ? `${d.type} · studio` : d.type,
        keywords: [d.category, d.description, ...(d.frontend ? ["frontend", "studio"] : [])],
        accent: d.frontend ? "var(--bf-vfd)" : `var(--bf-${nodeAccent(d.color, d.category)})`,
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

  /** An execution line dropped on empty canvas: every node that sits on a line, added already connected. */
  const lineItems = (t: ContextMenuTargets["connect"]): ContextMenuItem[] => {
    const s = store.getState();
    if (!flowId || !s.doc || !s.catalog) return [];
    const at: Position = snap(t.side === "out" ? { x: t.position.x, y: t.position.y - 26 } : { x: t.position.x - 300, y: t.position.y - 26 });
    const add = (type: string, config?: Record<string, unknown>) => {
      const id = randomNodeId();
      const link: Command =
        t.side === "out"
          ? { op: "exec.connect", flowId, from: { node: t.nodeId, port: t.port }, to: { node: id, port: "in" } }
          : { op: "exec.connect", flowId, from: { node: id, port: "then" }, to: { node: t.nodeId, port: "in" } };
      const r = dispatch([{ op: "node.add", flowId, id, type, position: at, ...(config ? { config } : {}) }, link]);
      if (r.ok) select([id]);
    };
    const catalog = s.catalog;
    const onLine = catalog.descriptors().filter((d) => !d.pure && !BUILTIN.has(d.type) && !VARIABLE_TYPES.has(d.type));
    const items: ContextMenuItem[] = paletteGroups(onLine).map((g) => ({
      id: `line:${g.category}`,
      label: g.category,
      order: 100,
      hint: String(g.nodes.length),
      items: g.nodes.map((d) => ({
        id: `line:${d.type}`,
        label: d.title,
        hint: d.canFail ? `${d.type} · can fail` : d.type,
        keywords: [d.category, d.description],
        accent: d.frontend ? "var(--bf-vfd)" : `var(--bf-${nodeAccent(d.color, d.category)})`,
        run: () => add(d.type, initialConfig(catalog.get(d.type), s.doc!, flowId, catalog)),
      })),
    }));
    const sets: ContextMenuItem[] = [];
    for (const v of view?.flow.variables ?? []) sets.push({ id: `line:set:${v.id}`, label: `Set ${v.name}`, accent: "var(--bf-pink)", run: () => add(VARIABLE_NODE_TYPES.variableSet, { variableId: v.id }) });
    for (const g of s.doc.globals) {
      if (g.access === "readwrite") sets.push({ id: `line:gset:${g.id}`, label: `Set ${g.name}`, hint: "global", accent: "var(--bf-pink)", run: () => add(VARIABLE_NODE_TYPES.globalSet, { globalId: g.id }) });
    }
    if (sets.length > 0) items.push({ id: "line:variables", label: "Variables", order: 150, hint: String(sets.length), items: sets });
    return items;
  };

  const connectItems = (t: ContextMenuTargets["connect"]): ContextMenuItem[] => {
    if (t.line) return lineItems(t);
    const s = store.getState();
    const node = view?.byId.get(t.nodeId);
    const from = (t.side === "out" ? [...(node?.outputs ?? []), ...(node?.errorOutput ? [node.errorOutput] : [])] : node?.inputs)?.find((p) => p.name === t.port);
    if (!flowId || !s.doc || !s.catalog || !from) return [];
    const doc = s.doc;
    const catalog = s.catalog;
    const flow = doc.flows.find((f) => f.id === flowId);
    const descriptors = catalog.descriptors().filter((d) => !BUILTIN.has(d.type) && !VARIABLE_TYPES.has(d.type));
    const probes: (ConnectProbe & { label: string; category: string; accent: string })[] = [];
    for (const d of descriptors) {
      const config = initialConfig(catalog.get(d.type), doc, flowId, catalog);
      probes.push({ key: d.type, type: d.type, ...(config ? { config } : {}), label: d.title, category: d.category, accent: `var(--bf-${nodeAccent(d.color, d.category)})` });
    }
    const varProbe = (key: string, type: string, config: Record<string, unknown>, label: string) => probes.push({ key, type, config, label, category: "Variables", accent: "var(--bf-pink)" });
    for (const v of flow?.variables ?? []) {
      varProbe(`get:${v.id}`, VARIABLE_NODE_TYPES.variableGet, { variableId: v.id }, `Get ${v.name}`);
      varProbe(`set:${v.id}`, VARIABLE_NODE_TYPES.variableSet, { variableId: v.id }, `Set ${v.name}`);
    }
    for (const g of doc.globals) {
      varProbe(`gget:${g.id}`, VARIABLE_NODE_TYPES.globalGet, { globalId: g.id }, `Get ${g.name}`);
      if (g.access === "readwrite") varProbe(`gset:${g.id}`, VARIABLE_NODE_TYPES.globalSet, { globalId: g.id }, `Set ${g.name}`);
    }
    const byKey = new Map(probes.map((p) => [p.key, p]));
    const matches = matchConnectTargets(doc, flowId, catalog, from.type, t.side, probes);
    if (matches.length === 0) {
      return [{ id: "connect:none", label: `No node takes ${from.typeText}`, disabled: true, run: () => undefined }];
    }
    const at: Position = snap(t.side === "out" ? { x: t.position.x, y: t.position.y - 70 } : { x: t.position.x - 300, y: t.position.y - 70 });
    const add = (probe: ConnectProbe, port: string) => {
      const id = randomNodeId();
      const edge = t.side === "out" ? { from: { node: t.nodeId, port: t.port }, to: { node: id, port } } : { from: { node: id, port }, to: { node: t.nodeId, port: t.port } };
      const node: Command = { op: "node.add", flowId, id, type: probe.type, position: at, ...(probe.config ? { config: probe.config } : {}) };
      const r = dispatch([node, { op: "edge.connect", flowId, ...edge }]);
      if (r.ok) select([id]);
      else if (dispatch(node).ok) select([id]);
    };
    const groups = new Map<string, ContextMenuItem[]>();
    const generic: ContextMenuItem[] = [];
    for (const m of matches) {
      const p = byKey.get(m.key)!;
      const item: ContextMenuItem = {
        id: `connect:${m.key}`,
        label: p.label,
        hint: t.side === "out" ? `→ ${m.portTitle}` : `${m.portTitle} →`,
        keywords: [p.category, p.type],
        accent: p.accent,
        run: () => add(p, m.port),
      };
      if (m.generic) generic.push({ ...item, label: `${p.label}`, keywords: [...(item.keywords ?? []), "any"] });
      else groups.set(p.category, [...(groups.get(p.category) ?? []), item]);
    }
    const items: ContextMenuItem[] = [...groups].map(([category, list]) => ({ id: `connect:${category}`, label: category, order: 100, hint: String(list.length), items: list }));
    if (generic.length > 0) items.push({ id: "connect:any", label: "Any type", order: 200, hint: String(generic.length), title: "Generic ports that take any type", items: generic });
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

  const portItems = (nodeId: string, port: string, side: "in" | "out", line = false): ContextMenuItem[] => {
    if (!flowId || !view) return [];
    const node = view.byId.get(nodeId);
    if (!node) return [];
    if (line) {
      const lines = view.execEdges.filter((e) => (side === "in" ? e.target === nodeId : e.source === nodeId && e.sourcePort === port));
      const items: ContextMenuItem[] = [];
      if (lines.length > 0) {
        items.push({
          id: "port:disconnect",
          label: lines.length > 1 ? `Disconnect execution (${lines.length})` : "Disconnect execution",
          order: 50,
          group: "port",
          run: () => dispatch(lines.map<Command>((e) => ({ op: "exec.disconnect", flowId, edgeId: e.id }))),
        });
      }
      return [...items, ...nodeItems([nodeId])];
    }
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
    const line = view?.execEdges.find((x) => x.id === edgeId);
    if (line && flowId) {
      const goLine = (id: string) => {
        select([id]);
        frame([id]);
      };
      return [
        { id: "edge:source", label: `Go to ${view?.byId.get(line.source)?.title ?? "source"}`, hint: line.sourcePort, order: 800, run: () => goLine(line.source) },
        { id: "edge:target", label: `Go to ${view?.byId.get(line.target)?.title ?? "target"}`, order: 800, run: () => goLine(line.target) },
        { id: "edge:delete", label: "Delete execution line", order: 900, shortcut: "Del", danger: true, run: () => dispatch({ op: "exec.disconnect", flowId, edgeId }) },
      ];
    }
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
        return portItems(t.nodeId, t.port, t.side, t.line === true);
      case "edge":
        return edgeItems(t.edgeId);
      case "connect":
        return connectItems(t);
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
        const line = handleId.startsWith("x:");
        const port = handleId.slice(2);
        const side = handleId.startsWith("i:") || handleId === "x:in" ? "in" : "out";
        menu.open(e, line ? { kind: "port", flowId, nodeId: node.id, port, side, line: true } : { kind: "port", flowId, nodeId: node.id, port, side });
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
    onConnectEnd: (e, state) => {
      if (!flowId || state.isValid || state.toHandle || !state.fromHandle || !state.fromNode) return;
      if (!(e.target instanceof Element) || !e.target.closest(".react-flow__pane")) return;
      const pt = "changedTouches" in e ? e.changedTouches[0] : e;
      if (!pt) return;
      const handle = state.fromHandle.id ?? "";
      const line = handle.startsWith("x:");
      const side = handle.startsWith("o:") || (line && handle !== "x:in") ? "out" : "in";
      const port = handle.slice(2);
      const to = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
      const fromNode = view?.byId.get(state.fromNode.id);
      const fromPort = (side === "out" ? [...(fromNode?.outputs ?? []), ...(fromNode?.errorOutput ? [fromNode.errorOutput] : [])] : fromNode?.inputs)?.find((p) => p.name === port);
      const wire: GhostWire = { from: state.from, to, side, family: line ? "exec" : (fromPort?.led ?? "any") };
      setGhost(wire);
      const opened = menu.open(
        { x: pt.clientX, y: pt.clientY, element: wrapper.current },
        line ? { kind: "connect", flowId, position: to, nodeId: state.fromNode.id, port, side, line: true } : { kind: "connect", flowId, position: to, nodeId: state.fromNode.id, port, side },
        undefined,
        { onClose: () => setGhost((g) => (g === wire ? undefined : g)) },
      );
      if (!opened) setGhost(undefined);
    },
    ghost,
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
