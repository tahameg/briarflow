/**
 * `<FlowCanvas>`: React Flow view of one flow. Documents stay in the store: drag end →
 * `node.move`, connect → `edge.connect`, Delete → `node.remove` / `edge.disconnect`;
 * selection and viewport are mirrored into the store. Right-click opens the canvas menus
 * (`canvasMenu.ts`): add a node on empty canvas, node / edge / port actions elsewhere.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position as HandlePosition,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  useStore as useFlowStore,
  useUpdateNodeInternals,
  ViewportPortal,
} from "@xyflow/react";
import type { Connection, Edge as RFEdge, EdgeChange, EdgeProps, Node as RFNode, NodeChange, NodeProps, Viewport } from "@xyflow/react";
import type { Command } from "@briarflow/authoring";
import { FLOW_INPUT_NODE_TYPE } from "@briarflow/core";
import type { TypeScope } from "@briarflow/core";
import { nextName } from "../fields.js";
import { canConnect } from "../graph.js";
import type { EdgeView, NodeView, PortView } from "../graph.js";
import { useCanvasHandle, useDispatch, useEditorState, useEditorStore, useFlowId, useFlowView, useMedia } from "../context.js";
import { NODE_CONFIG_MIME, NODE_TYPE_MIME, initialConfig, snap } from "../palette.js";
import { formatDuration, previewValue } from "../values.js";
import { TypePicker } from "./TypePicker.js";
import { AddRow, Badge, EditableName } from "./ui.js";
import type { DotState } from "./ui.js";
import { ValueEditor } from "./ValueEditor.js";
import { useEditorShortcuts } from "./shortcuts.js";
import { useCanvasMenu } from "./canvasMenu.js";
import type { GhostWire } from "./canvasMenu.js";
import { Led, NodeMedal, PilotLamp, VuMeter, inputLed, medalIcon, outputLed } from "./nodeParts.js";

interface NodeData extends Record<string, unknown> {
  view: NodeView;
  flowId: string;
  scope: TypeScope;
  runActive: boolean;
}
type BriarRFNode = RFNode<NodeData, "briar">;
type BriarRFEdge = RFEdge<{ view: EdgeView }, "briar">;

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
/** Initial fit keeps canvas text legible (design-system §11 "Canvas legibility"). */
const INITIAL_FIT = { padding: 0.15, minZoom: 0.85, maxZoom: 1 } as const;
/** The fit button never zooms past 1:1. */
const BUTTON_FIT = { padding: 0.15, maxZoom: 1 } as const;
/** Below this zoom nodes render compact: title and ports only. */
const COMPACT_BELOW_ZOOM = 0.6;
const inHandle = (port: string) => `i:${port}`;
const outHandle = (port: string) => `o:${port}`;
const portOf = (handle: string | null | undefined) => (handle ?? "").slice(2);

/** Props of {@link FlowCanvas}. */
export interface FlowCanvasProps {
  /** Flow to show. Default: the store's active flow. */
  flowId?: string;
  /** Show the minimap initially (toggle in the controls). */
  minimap?: boolean;
  className?: string;
}

/**
 * The flow editor canvas.
 *
 * @example
 * ```tsx
 * <EditorProvider store={store}><div style={{ height: 600 }}><FlowCanvas /></div></EditorProvider>
 * ```
 */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

const nodeTypes = { briar: memo(BriarNode) };
const edgeTypes = { briar: memo(BriarEdge) };

function FlowCanvasInner({ flowId: flowIdProp, minimap = false, className }: FlowCanvasProps) {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const flowId = useFlowId(flowIdProp);
  const view = useFlowView(flowId);
  const selection = useEditorState((s) => s.selection);
  const runActive = useEditorState((s) => s.run !== undefined && s.run.flowId === flowId && (s.run.status === "running" || s.run.status === "queued" || s.run.status === "starting"));
  const storedViewport = useEditorState((s) => (flowId ? s.viewports[flowId] : undefined));
  const savedViewport = view?.flow.ui?.viewport;
  const viewport = storedViewport ?? savedViewport;
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const canvasHandle = useCanvasHandle();
  const [showMap, setShowMap] = useState(minimap);

  // Local, view-only node state: positions while dragging and measured sizes.
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});

  useEffect(() => {
    canvasHandle.current = {
      center() {
        const r = wrapper.current?.getBoundingClientRect();
        if (!r) return { x: 0, y: 0 };
        return rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      },
    };
    return () => {
      canvasHandle.current = null;
    };
  }, [canvasHandle, rf]);

  const selectedNodes = useMemo(() => new Set(selection.nodes), [selection.nodes]);
  const selectedEdges = useMemo(() => new Set(selection.edges), [selection.edges]);

  const nodes = useMemo<BriarRFNode[]>(() => {
    if (!view || !flowId) return [];
    return view.nodes.map((n) => {
      const node: BriarRFNode = {
        id: n.id,
        type: "briar",
        position: dragPos[n.id] ?? n.position,
        data: { view: n, flowId, scope: view.scope, runActive },
        selected: selectedNodes.has(n.id),
        deletable: !n.builtin,
        ariaLabel: `${n.title} node`,
      };
      const m = measured[n.id];
      if (m) node.measured = m;
      if (dragPos[n.id]) node.dragging = true;
      return node;
    });
  }, [view, flowId, dragPos, measured, selectedNodes, runActive]);

  const edges = useMemo<BriarRFEdge[]>(() => {
    if (!view) return [];
    return view.edges.map((e) => ({
      id: e.id,
      type: "briar",
      source: e.source,
      target: e.target,
      sourceHandle: outHandle(e.sourcePort),
      targetHandle: inHandle(e.targetPort),
      data: { view: e },
      selected: selectedEdges.has(e.id),
      ariaLabel: `Edge ${e.source}.${e.sourcePort} to ${e.target}.${e.targetPort}`,
    }));
  }, [view, selectedEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BriarRFNode>[]) => {
      const add: string[] = [];
      const remove: string[] = [];
      let dims: Record<string, { width: number; height: number }> | undefined;
      let pos: Record<string, { x: number; y: number }> | undefined;
      for (const c of changes) {
        if (c.type === "select") (c.selected ? add : remove).push(c.id);
        else if (c.type === "dimensions" && c.dimensions) (dims ??= {})[c.id] = c.dimensions;
        else if (c.type === "position" && c.position && c.dragging) (pos ??= {})[c.id] = c.position;
      }
      if (remove.length) store.select({ nodes: remove }, "remove");
      if (add.length) store.select({ nodes: add }, "add");
      if (dims) {
        const d = dims;
        setMeasured((m) => ({ ...m, ...d }));
      }
      if (pos) {
        const p = pos;
        setDragPos((m) => ({ ...m, ...p }));
      }
    },
    [store],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<BriarRFEdge>[]) => {
      const add: string[] = [];
      const remove: string[] = [];
      for (const c of changes) if (c.type === "select") (c.selected ? add : remove).push(c.id);
      if (remove.length) store.select({ edges: remove }, "remove");
      if (add.length) store.select({ edges: add }, "add");
    },
    [store],
  );

  const onNodeDragStop = useCallback(
    (_e: unknown, _node: BriarRFNode, dragged: BriarRFNode[]) => {
      if (!flowId || !view) return;
      const commands: Command[] = [];
      for (const n of dragged) {
        const before = view.byId.get(n.id)?.position;
        if (before && before.x === n.position.x && before.y === n.position.y) continue;
        commands.push({ op: "node.move", flowId, nodeId: n.id, position: { x: n.position.x, y: n.position.y } });
      }
      if (commands.length > 0) dispatch(commands);
      setDragPos({});
    },
    [dispatch, flowId, view],
  );

  const isValidConnection = useCallback(
    (c: Connection | BriarRFEdge) => {
      if (!view) return false;
      return canConnect(view, { node: c.source, port: portOf(c.sourceHandle) }, { node: c.target, port: portOf(c.targetHandle) });
    },
    [view],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!flowId) return;
      dispatch({ op: "edge.connect", flowId, from: { node: c.source, port: portOf(c.sourceHandle) }, to: { node: c.target, port: portOf(c.targetHandle) } });
    },
    [dispatch, flowId],
  );

  const onViewportChange = useCallback((v: Viewport) => flowId && store.setViewport(flowId, v), [store, flowId]);

  const onDragOver = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(NODE_TYPE_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const type = e.dataTransfer.getData(NODE_TYPE_MIME);
      if (!type || !flowId) return;
      e.preventDefault();
      const s = store.getState();
      if (!s.doc || !s.catalog) return;
      const position = snap(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      const config = droppedConfig(e.dataTransfer.getData(NODE_CONFIG_MIME)) ?? initialConfig(s.catalog.get(type), s.doc, flowId, s.catalog);
      const r = dispatch({ op: "node.add", flowId, type, position, ...(config ? { config } : {}) });
      if (r.ok && r.created.nodeId) store.select({ nodes: [r.created.nodeId] }, "replace");
    },
    [dispatch, flowId, rf, store],
  );

  const menu = useCanvasMenu(flowId, view, wrapper);
  const latestMenu = useRef(menu);
  latestMenu.current = menu;
  const openMenu = useCallback((what: "add" | "selection") => latestMenu.current.openFromKeyboard(what), []);
  useEditorShortcuts(flowId, view, wrapper, openMenu);

  if (!flowId || !view) {
    return (
      <div className={["bf-canvas", "bf-canvas--empty", className].filter(Boolean).join(" ")} ref={wrapper}>
        <div className="bf-empty">
          <p className="bf-empty__title">No flow open</p>
          <p className="bf-muted">Pick a flow in the contexts list, or create one.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={["bf-canvas", className].filter(Boolean).join(" ")} ref={wrapper} onDragOver={onDragOver} onDrop={onDrop} onPointerMove={menu.onPointerMove}>
      <ReactFlow<BriarRFNode, BriarRFEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onPaneClick={() => store.clearSelection()}
        onPaneContextMenu={menu.onPaneContextMenu}
        onNodeContextMenu={menu.onNodeContextMenu}
        onEdgeContextMenu={menu.onEdgeContextMenu}
        onSelectionContextMenu={menu.onSelectionContextMenu}
        onConnectEnd={menu.onConnectEnd}
        {...(viewport ? { viewport } : { defaultViewport: DEFAULT_VIEWPORT, fitView: true, fitViewOptions: INITIAL_FIT })}
        onViewportChange={onViewportChange}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        panActivationKeyCode="Space"
        snapToGrid
        snapGrid={[12, 12]}
        minZoom={0.2}
        maxZoom={2.5}
        connectionLineStyle={{ stroke: "var(--bf-brass-hi)", strokeWidth: 2.5, strokeDasharray: "6 5" }}
        defaultEdgeOptions={{ type: "briar" }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        aria-label={`Flow ${view.flow.name}`}
      >
        <Background id="minor" variant={BackgroundVariant.Lines} gap={24} color="var(--bf-bench-grid-minor)" lineWidth={1} />
        <Background id="major" variant={BackgroundVariant.Lines} gap={120} color="var(--bf-bench-grid-major)" lineWidth={1} />
        <Controls className="bf-canvas__controls" showInteractive={false} fitViewOptions={BUTTON_FIT}>
          <ControlButton onClick={() => setShowMap((v) => !v)} title={showMap ? "Hide minimap" : "Show minimap"} aria-label={showMap ? "Hide minimap" : "Show minimap"}>
            ▦
          </ControlButton>
        </Controls>
        {menu.ghost ? <GhostWirePath wire={menu.ghost} /> : null}
        {showMap ? <MiniMap className="bf-minimap" pannable zoomable nodeColor={() => "#9a4a22"} maskColor="rgba(0,0,0,0.6)" /> : null}
      </ReactFlow>
    </div>
  );
}

function droppedConfig(json: string): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ---- node -----------------------------------------------------------------------------------

function nodeDot(view: NodeView, runActive: boolean): { state: DotState; badge?: { tone: "sky" | "mint" | "lavender" | "danger" | "stone" | "peach"; text: string; title?: string } } | undefined {
  const r = view.run;
  if (!r) return runActive ? { state: "queued" } : undefined;
  switch (r.status) {
    case "running":
      if (r.retrying) return { state: "running", badge: { tone: "peach", text: `retry ${r.attempt ?? ""}`.trim(), ...(r.message ? { title: r.message } : {}) } };
      return { state: "running", ...(r.progress !== undefined ? { badge: { tone: "sky" as const, text: r.progress.toFixed(2), ...(r.message ? { title: r.message } : {}) } } : {}) };
    case "done":
      return { state: "done", badge: { tone: "mint", text: formatDuration(r.durationMs) || "done" } };
    case "cached":
      return { state: "cached", badge: { tone: "lavender", text: "CACHED" } };
    case "failed":
      return { state: "error", badge: { tone: "danger", text: "FAILED", title: r.error?.message ?? "failed" } };
    case "skipped":
      return { state: "skipped", badge: { tone: "stone", text: "SKIPPED", title: r.skipReason ?? "skipped" } };
  }
}

function BriarNode({ id, data, selected }: NodeProps<BriarRFNode>) {
  const { view, flowId, scope, runActive } = data;
  // Handles move when rows change height (widgets ↔ source labels, badges, preview); React Flow
  // must re-measure them or drops land on stale positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const layoutKey = [
    view.inputs.map((p) => `${p.name}:${p.typeText}:${p.source ? 1 : 0}:${p.errors.length}`).join(","),
    view.outputs.map((p) => `${p.name}:${p.typeText}`).join(","),
    view.errorCount,
    view.warningCount,
    view.preview ? 1 : 0,
  ].join("|");
  const dispatch = useDispatch();
  const { mediaUrl } = useMedia();
  const status = nodeDot(view, runActive);
  const compact = useFlowStore((s) => s.transform[2] < COMPACT_BELOW_ZOOM);
  useEffect(() => updateNodeInternals(id), [id, layoutKey, compact, updateNodeInternals]);
  const running = view.run?.status === "running";
  const classes = [
    "bf-node",
    compact && "bf-node--compact",
    view.builtin && "bf-node--builtin",
    view.variable && "bf-node--variable",
    selected && "bf-node--selected",
    running && "bf-node--running",
    view.errorCount > 0 && "bf-node--error",
    view.run?.status === "skipped" && "bf-node--skipped",
    view.run?.status === "failed" && "bf-node--failed",
  ]
    .filter(Boolean)
    .join(" ");
  const failure = view.run?.status === "failed" ? (view.run.error?.message ?? "The node failed.") : undefined;
  const icon = medalIcon({ builtin: view.builtin ? (view.type === FLOW_INPUT_NODE_TYPE ? "input" : "output") : undefined, variable: view.variable, category: view.definition?.category });
  return (
    <div className={classes}>
      <div className="bf-node__plate">
        <header className="bf-node__header">
          <NodeMedal icon={icon} />
          <span className="bf-node__titles">
            <span className="bf-node__title">{view.title}</span>
            {!view.builtin && !view.variable && (view.unknownType || view.typeTitle !== view.title) ? <span className="bf-node__type">{view.unknownType ? `${view.type} (unknown)` : view.typeTitle}</span> : null}
          </span>
          <span className="bf-node__status">
            {view.errorCount > 0 ? (
              <Badge tone="danger" title={view.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("\n")}>
                {view.errorCount} {view.errorCount === 1 ? "error" : "errors"}
              </Badge>
            ) : view.warningCount > 0 ? (
              <Badge tone="peach" title={view.diagnostics.map((d) => d.message).join("\n")}>
                {view.warningCount} warn
              </Badge>
            ) : null}
            {status?.badge ? (
              <Badge tone={status.badge.tone} title={status.badge.title}>
                {status.badge.text}
              </Badge>
            ) : null}
            <PilotLamp state={status?.state} />
          </span>
        </header>
        {running && view.run?.progress !== undefined ? <VuMeter progress={view.run.progress} /> : null}
        <div className="bf-node__body">
          {view.builtin ? <SignatureRows dir={view.type === FLOW_INPUT_NODE_TYPE ? "input" : "output"} ports={view.type === FLOW_INPUT_NODE_TYPE ? view.outputs : view.inputs} flowId={flowId} scope={scope} /> : null}
          {!view.builtin && view.inputs.map((p) => (
            <div className={p.errors.length ? "bf-node__row bf-node__row--invalid" : "bf-node__row"} key={`i:${p.name}`} title={`${p.title}: ${p.typeText}${p.errors.length ? `\n${p.errors.join("\n")}` : ""}`}>
              <Handle
                type="target"
                position={HandlePosition.Left}
                id={inHandle(p.name)}
                className={socketClass(p)}
                style={socketStyle(p)}
                aria-label={`input ${p.name}: ${p.typeText}`}
              />
              <Led family={p.led} state={inputLed(p, running)} bar={p.list} />
              <span className="bf-node__label">{p.title}</span>
              {p.source ? (
                <span className="bf-node__source">← {p.source.label}</span>
              ) : (
                <span className="bf-node__widget">
                  <ValueEditor
                    compact
                    type={p.type}
                    scope={scope}
                    widget={p.widget}
                    label={`${view.title} ${p.title}`}
                    value={p.hasValue ? p.value : undefined}
                    placeholder={p.hasDefault ? previewValue(p.default, 20) : undefined}
                    invalid={p.errors.length > 0}
                    mediaUrl={mediaUrl}
                    onCommit={(value) => dispatch({ op: "node.setValue", flowId, nodeId: view.id, port: p.name, value })}
                  />
                </span>
              )}
            </div>
          ))}
          {!view.builtin && view.outputs.map((p) => (
            <div className="bf-node__row bf-node__row--out" key={`o:${p.name}`} title={`${p.title}: ${p.typeText}`}>
              <span className="bf-node__otype">{p.typeText}</span>
              <span className="bf-node__label">{p.title}</span>
              <Led family={p.led} state={outputLed(p)} bar={p.list} />
              <Handle
                type="source"
                position={HandlePosition.Right}
                id={outHandle(p.name)}
                className={socketClass(p)}
                style={socketStyle(p)}
                aria-label={`output ${p.name}: ${p.typeText}`}
              />
            </div>
          ))}
          {!view.builtin && view.inputs.length === 0 && view.outputs.length === 0 ? <div className="bf-node__row bf-node__row--empty">no ports</div> : null}
        </div>
        {view.preview ? <footer className="bf-node__preview">{view.preview}</footer> : null}
        {failure ? (
          <div className="bf-node__tag" role="alert">
            <span className="bf-node__cap">Run failed</span>
            {failure}
          </div>
        ) : null}
        <span className="bf-screw bf-screw--l" aria-hidden="true" />
        <span className="bf-screw bf-screw--r" aria-hidden="true" />
      </div>
    </div>
  );
}

const socketClass = (p: PortView) => (p.links > 0 ? "bf-handle bf-socket bf-socket--plugged" : "bf-handle bf-socket");
const socketStyle = (p: PortView) => ({ "--bf-led-c": `var(--bf-led-${p.led})` }) as CSSProperties;

/**
 * Rows of the built-in Input node (flow inputs, handles on the right) or Output node (flow
 * outputs, handles on the left): click a name to rename, the type chip to retype, `[ ]` for a
 * list, `×` to remove, and "+" under the last row to add one.
 */
function SignatureRows({ dir, ports, flowId, scope }: { dir: "input" | "output"; ports: readonly PortView[]; flowId: string; scope: TypeScope }) {
  const dispatch = useDispatch();
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const add = () => {
    const name = nextName(dir, ports.map((p) => p.name));
    const r = dispatch(dir === "input" ? { op: "flow.input.add", flowId, name, type: "text" } : { op: "flow.output.add", flowId, name, type: "text" });
    if (r.ok) setFresh(name);
  };
  return (
    <>
      {ports.map((p) => {
        const handle = (
          <Handle
            type={dir === "input" ? "source" : "target"}
            position={dir === "input" ? HandlePosition.Right : HandlePosition.Left}
            id={dir === "input" ? outHandle(p.name) : inHandle(p.name)}
            className={socketClass(p)}
            style={socketStyle(p)}
            aria-label={`${dir === "input" ? "output" : "input"} ${p.name}: ${p.typeText}`}
          />
        );
        const led = <Led family={p.led} state={dir === "input" ? outputLed(p) : inputLed(p, false)} bar={p.list} />;
        return (
          <div className={dir === "input" ? "bf-node__row bf-node__row--sig bf-node__row--out" : "bf-node__row bf-node__row--sig"} key={p.name}>
            {dir === "output" ? handle : null}
            {dir === "output" ? led : null}
            <button
              type="button"
              className="bf-icon-btn bf-icon-btn--danger bf-node__remove nodrag"
              aria-label={`Remove flow ${dir} ${p.name}`}
              title={`Remove ${dir}`}
              onClick={(e) => {
                e.stopPropagation();
                dispatch(dir === "input" ? { op: "flow.input.remove", flowId, name: p.name } : { op: "flow.output.remove", flowId, name: p.name });
              }}
            >
              ×
            </button>
            <EditableName
              className="bf-node__name"
              value={p.name}
              label={`Name of flow ${dir} ${p.name}`}
              autoEdit={fresh === p.name}
              onEditEnd={() => setFresh(undefined)}
              onCommit={(n) => dispatch(dir === "input" ? { op: "flow.input.rename", flowId, name: p.name, newName: n } : { op: "flow.output.rename", flowId, name: p.name, newName: n })}
            />
            <TypePicker
              compact
              type={p.type}
              scope={scope}
              label={`Type of flow ${dir} ${p.name}`}
              onCommit={(t) => dispatch(dir === "input" ? { op: "flow.input.setType", flowId, name: p.name, type: t } : { op: "flow.output.setType", flowId, name: p.name, type: t })}
            />
            {dir === "input" ? led : null}
            {dir === "input" ? handle : null}
          </div>
        );
      })}
      <div className="bf-node__row bf-node__row--add">
        <AddRow label={`Add flow ${dir}`} onAdd={add}>
          {dir}
        </AddRow>
      </div>
    </>
  );
}

// ---- edge -----------------------------------------------------------------------------------

/** The dropped wire while the "connect" menu is open: a cable from the handle to the drop point. */
function GhostWirePath({ wire }: { wire: GhostWire }) {
  const [a, b] = wire.side === "out" ? [wire.from, wire.to] : [wire.to, wire.from];
  const [path] = getBezierPath({ sourceX: a.x, sourceY: a.y, sourcePosition: HandlePosition.Right, targetX: b.x, targetY: b.y, targetPosition: HandlePosition.Left });
  return (
    <ViewportPortal>
      <svg className="bf-ghost-wire" aria-hidden="true">
        <path d={path} className="bf-edge__sheath" />
        <path d={path} className="bf-ghost-wire__core" style={{ stroke: `var(--bf-wire-${wire.family})` }} />
        <circle cx={wire.to.x} cy={wire.to.y} r={5} className="bf-ghost-wire__end" />
      </svg>
    </ViewportPortal>
  );
}

function BriarEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<BriarRFEdge>) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const v = data?.view;
  const invalid = v?.invalid;
  const core = invalid ? "var(--bf-led-media)" : `var(--bf-wire-${v?.family ?? "any"})`;
  const style: CSSProperties = { stroke: core, strokeWidth: 2.5 };
  if (invalid) style.strokeDasharray = "6 5";
  return (
    <>
      <path d={path} className={selected ? "bf-edge__sheath bf-edge__sheath--selected" : "bf-edge__sheath"} />
      <BaseEdge id={id} path={path} style={style} className="bf-edge" interactionWidth={18} />
      {v?.running && !invalid ? <path d={path} className="bf-edge__spark" /> : null}
      {invalid ? (
        <EdgeLabelRenderer>
          <div className="bf-edge__warning nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }} title={invalid} role="img" aria-label={invalid}>
            !
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
