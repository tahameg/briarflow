/**
 * Pure view models for the canvas: a flow's nodes and edges with resolved ports, type styles,
 * diagnostics and run status. No React here, so it can be unit tested and reused by other
 * view layers.
 */
import {
  analyzeExec,
  ERROR_OUTPUT,
  EXEC_FAILED,
  execPortsOf,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  VARIABLE_NODE_TYPES,
  MEMBER_NODE_TYPES,
  bindTypeVars,
  containsVar,
  createCatalog,
  findConversions,
  formatType,
  nodeDefinition,
  isAssignable,
  substituteTypeVars,
  resolveFlowPorts,
  scopeForFlow,
} from "@briarflow/core";
import type {
  AnyNodeDefinition,
  ContextDocument,
  ConversionMatch,
  ExecPorts,
  Diagnostic,
  FlowDocument,
  MediaRef,
  NodeCatalog,
  NodeInstance,
  PortWidget,
  Position,
  ResolvedPort,
  TypeRef,
  TypeScope,
} from "@briarflow/core";
import type { NodeRunState, RunState } from "@briarflow/editor";
import { isListType, ledFamily, nodeAccent, typeStyle } from "./theme.js";
import { isMediaRef } from "./values.js";
import type { BriarToken, LedFamily, NamedKindLookup, TypeStyle } from "./theme.js";

/** One port of a node on the canvas. */
export interface PortView {
  name: string;
  title: string;
  description?: string;
  type: TypeRef;
  /** The definition's type, before generics are bound (`$T`). */
  declaredType: TypeRef;
  /** Shorthand (`list<Character?>`). */
  typeText: string;
  style: TypeStyle;
  /** LED color family. */
  led: LedFamily;
  /** `list<…>`: bar LED. */
  list: boolean;
  /** Wires on this port (inputs: 0 or 1). */
  links: number;
  widget?: PortWidget;
  hasDefault: boolean;
  default?: unknown;
  /** Inputs: the edge feeding this port. */
  source?: { nodeId: string; port: string; label: string; edgeId: string };
  /** Inputs: the stored constant, if any. */
  hasValue: boolean;
  value?: unknown;
  /** Error diagnostics pointing at this port. */
  errors: string[];
}

/** One node on the canvas. */
export interface NodeView {
  id: string;
  type: string;
  /** Shown title (instance title, definition title, `Input`/`Output`, `GET name`). */
  title: string;
  /** Definition title (or the type) for the type line under the title. */
  typeTitle: string;
  accent: BriarToken;
  /** `briar.input` / `briar.output`: yellow header, not deletable. */
  builtin: boolean;
  /** Variable get/set node (compact, pink). */
  variable: boolean;
  /** No catalog entry for the type. */
  unknownType: boolean;
  /** A frontend node (definition `frontend`): its effect happens in the editor, not on the server. */
  frontend: boolean;
  /** Execution ports (`in`; `then`, `failed`). Empty for pure nodes. */
  exec: ExecPorts;
  /** The `error` output of a node that can fail (shown on the header, not in `outputs`). */
  errorOutput?: PortView;
  /** Execution ports with a line plugged in. */
  execLinked: readonly string[];
  /** The flow has execution lines and this node is not on them (nor read by a node that is): it never runs. */
  idle: boolean;
  /** The definition in the node's variant (undefined for unknown types and variants). */
  definition: AnyNodeDefinition | undefined;
  /** Nodes with variants: the selector (`Model`), the picked variant and the choices. */
  variant?: VariantView;
  instance: NodeInstance;
  position: Position;
  inputs: PortView[];
  outputs: PortView[];
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  run: NodeRunState | undefined;
  /** Optional muted preview (e.g. a template). */
  preview?: string;
  /** Image / video outputs, with what the last run produced on them (preview window). */
  media?: MediaPreview[];
}

/** An image or video output of a node and the media the last run put on it. */
export interface MediaPreview {
  port: string;
  title: string;
  kind: "image" | "video";
  /** Empty before a run (or when the output was none). */
  refs: MediaRef[];
}

/** The variant selector of a node. */
export interface VariantView {
  title: string;
  /** Picked variant name (the node's, or the type's default). */
  current: string;
  /** False when the node names a variant its type does not have. */
  known: boolean;
  options: { name: string; title: string; description?: string; deprecated?: string }[];
}

/** One edge on the canvas. */
export interface EdgeView {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  /** Source port color. */
  color: string;
  /** Source port LED family (cable core color). */
  family: LedFamily;
  /** Error message when the edge is invalid (e.g. `edge.type_mismatch`). */
  invalid?: string;
  /** Target node is running. */
  running: boolean;
}

/** One execution line on the canvas. */
export interface ExecEdgeView {
  id: string;
  source: string;
  /** `then` or `failed`. */
  sourcePort: string;
  target: string;
  targetPort: string;
  /** In the current run: execution went down this line. */
  taken: boolean;
}

/** Everything the canvas shows for one flow. */
export interface FlowView {
  flowId: string;
  flow: FlowDocument;
  scope: TypeScope;
  kindOf: NamedKindLookup;
  nodes: NodeView[];
  edges: EdgeView[];
  /** Execution lines (empty for a flow without them). */
  execEdges: ExecEdgeView[];
  /** The flow has execution lines (only nodes on them run). */
  hasLines: boolean;
  byId: ReadonlyMap<string, NodeView>;
}

const EMPTY_CATALOG = createCatalog([]);

/** A catalog to fall back on before node types are loaded. */
export function emptyCatalog(): NodeCatalog {
  return EMPTY_CATALOG;
}

/** Struct/enum lookup for type styles in a scope. */
export function kindLookup(scope: TypeScope): NamedKindLookup {
  return (id) => scope.getType(id)?.decl.kind;
}

/** Title of a node instance as the canvas shows it. */
export function nodeTitle(doc: ContextDocument, flow: FlowDocument, node: NodeInstance, def: AnyNodeDefinition | undefined): string {
  if (node.title !== undefined && node.title.trim() !== "") return node.title;
  if (node.type === FLOW_INPUT_NODE_TYPE) return "Input";
  if (node.type === FLOW_OUTPUT_NODE_TYPE) return "Output";
  const cfg = node.config ?? {};
  if (node.type === VARIABLE_NODE_TYPES.variableGet || node.type === VARIABLE_NODE_TYPES.variableSet) {
    const v = flow.variables.find((x) => x.id === cfg.variableId);
    return `${node.type.endsWith(".get") ? "GET" : "SET"} ${v?.name ?? "?"}`;
  }
  if (node.type === VARIABLE_NODE_TYPES.globalGet || node.type === VARIABLE_NODE_TYPES.globalSet) {
    const g = doc.globals.find((x) => x.id === cfg.globalId);
    return `${node.type.endsWith(".get") ? "GET" : "SET"} ${g?.name ?? "?"}`;
  }
  if ((node.type === MEMBER_NODE_TYPES.get || node.type === MEMBER_NODE_TYPES.set) && typeof cfg.path === "string" && cfg.path !== "") {
    return `${node.type === MEMBER_NODE_TYPES.get ? "Get" : "Set"} .${cfg.path}`;
  }
  return def?.title ?? node.type;
}

function isVariableNode(type: string): boolean {
  return (Object.values(VARIABLE_NODE_TYPES) as string[]).includes(type);
}

function previewOf(node: NodeInstance): string | undefined {
  for (const value of Object.values(node.config ?? {})) {
    if (typeof value === "string" && value.length > 0 && !/^[a-z]{2,6}_[A-Za-z0-9_-]+$/.test(value)) {
      return value.length > 120 ? `${value.slice(0, 117)}…` : value;
    }
  }
  return undefined;
}

/**
 * Builds the canvas view of a flow. Returns `undefined` for an unknown flow.
 *
 * @example
 * ```ts
 * const view = buildFlowView(state.doc, "flow_p", state.catalog, state.diagnostics, state.run);
 * view?.nodes.map((n) => n.title);
 * ```
 */
export function buildFlowView(
  doc: ContextDocument,
  flowId: string,
  catalog: NodeCatalog | undefined,
  diagnostics: readonly Diagnostic[],
  run: RunState | undefined,
): FlowView | undefined {
  const flow = doc.flows.find((f) => f.id === flowId);
  if (!flow) return undefined;
  const cat = catalog ?? EMPTY_CATALOG;
  const scope = scopeForFlow(doc, flowId, cat);
  const kindOf = kindLookup(scope);
  let ports: ReturnType<typeof resolveFlowPorts> | undefined;
  try {
    ports = resolveFlowPorts(doc, flowId, cat);
  } catch {
    ports = undefined;
  }
  const flowDiags = diagnostics.filter((d) => d.path.flowId === flowId);
  const runNodes = run && run.flowId === flowId ? run.nodes : undefined;

  const titles = new Map<string, string>();
  for (const node of flow.nodes) titles.set(node.id, nodeTitle(doc, flow, node, nodeDefinition(cat, node) ?? cat.get(node.type)));

  const incoming = new Map<string, { nodeId: string; port: string; edgeId: string }>();
  const outgoing = new Map<string, number>();
  for (const e of flow.edges) {
    incoming.set(`${e.to.node}\u0000${e.to.port}`, { nodeId: e.from.node, port: e.from.port, edgeId: e.id });
    const key = `${e.from.node}\u0000${e.from.port}`;
    outgoing.set(key, (outgoing.get(key) ?? 0) + 1);
  }

  const portView = (node: NodeInstance, p: ResolvedPort, dir: "in" | "out", diags: Diagnostic[]): PortView => {
    const view: PortView = {
      name: p.name,
      title: p.title,
      type: p.type,
      declaredType: p.declaredType,
      typeText: formatType(p.type, scope),
      style: typeStyle(p.type, kindOf),
      led: ledFamily(p.type),
      list: isListType(p.type),
      links: dir === "out" ? (outgoing.get(`${node.id}\u0000${p.name}`) ?? 0) : 0,
      hasDefault: p.hasDefault,
      hasValue: false,
      errors: diags.filter((d) => d.severity === "error" && d.path.port === p.name).map((d) => d.message),
    };
    if (p.description !== undefined) view.description = p.description;
    if (p.widget !== undefined) view.widget = p.widget;
    if (p.hasDefault) view.default = p.default;
    if (dir === "in") {
      const src = incoming.get(`${node.id}\u0000${p.name}`);
      if (src) {
        view.source = { ...src, label: `${titles.get(src.nodeId) ?? src.nodeId}.${src.port}` };
        view.links = 1;
      } else if (p.declaredType.kind === "var" && p.declaredType.oneOf) {
        view.typeText = p.declaredType.oneOf.map((t) => formatType(t, scope)).join(" | ");
      }
      const values = node.values ?? {};
      if (Object.prototype.hasOwnProperty.call(values, p.name)) {
        view.hasValue = true;
        view.value = values[p.name];
      }
    }
    return view;
  };

  let live: ReadonlySet<string> | undefined;
  if (flow.execEdges !== undefined) {
    try {
      live = analyzeExec(doc, flow, cat).live;
    } catch {
      live = undefined;
    }
  }
  const nodes: NodeView[] = flow.nodes.map((node) => {
    const typeDef = cat.get(node.type);
    const def = nodeDefinition(cat, node);
    const resolved = ports?.nodes.get(node.id);
    const builtin = node.type === FLOW_INPUT_NODE_TYPE || node.type === FLOW_OUTPUT_NODE_TYPE;
    const diags = flowDiags.filter((d) => d.path.nodeId === node.id);
    const variable = isVariableNode(node.type);
    const view: NodeView = {
      id: node.id,
      type: node.type,
      title: titles.get(node.id) ?? node.id,
      typeTitle: builtin ? (node.type === FLOW_INPUT_NODE_TYPE ? "flow inputs" : "flow outputs") : (typeDef?.title ?? node.type),
      accent: builtin ? "yellow" : variable ? "pink" : nodeAccent(typeDef?.color, typeDef?.category),
      builtin,
      variable,
      unknownType: !builtin && typeDef === undefined,
      frontend: typeDef?.frontend === true,
      exec: flow.execEdges === undefined ? { inputs: [], outputs: [] } : execPortsOf(node.type, def ?? typeDef),
      idle: live !== undefined && !live.has(node.id),
      execLinked: [
        ...new Set((flow.execEdges ?? []).flatMap((e) => [...(e.from.node === node.id ? [e.from.port] : []), ...(e.to.node === node.id ? [e.to.port] : [])])),
      ],
      definition: def,
      instance: node,
      position: node.position,
      inputs: (resolved?.inputs ?? []).map((p) => portView(node, p, "in", diags)),
      outputs: (resolved?.outputs ?? []).map((p) => portView(node, p, "out", diags)),
      diagnostics: diags,
      errorCount: diags.filter((d) => d.severity === "error").length,
      warningCount: diags.filter((d) => d.severity === "warning").length,
      run: runNodes?.[node.id],
    };
    if (typeDef?.variants) {
      const v = typeDef.variants;
      view.variant = {
        title: v.title,
        current: node.variant ?? v.default,
        known: def !== undefined,
        options: v.options.map((o) => ({
          name: o.name,
          title: o.title,
          ...(o.description === undefined ? {} : { description: o.description }),
          ...(o.deprecated === undefined ? {} : { deprecated: o.deprecated }),
        })),
      };
    }
    if (def?.canFail) {
      const i = view.outputs.findIndex((p) => p.name === ERROR_OUTPUT);
      const [error] = i >= 0 ? view.outputs.splice(i, 1) : [];
      if (error) view.errorOutput = error;
    }
    const preview = node.type === "text.template" ? (node.config?.template as string | undefined) : previewOf(node);
    if (preview) view.preview = preview;
    // Frontend nodes (View image) show the media they were given; other nodes show what they made.
    const media = view.builtin
      ? []
      : view.frontend
        ? mediaPreviews(view.inputs, inputValues(flow, node, runNodes))
        : mediaPreviews(view.outputs, view.run?.outputs);
    if (media.length > 0) view.media = media;
    return view;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: EdgeView[] = flow.edges.map((e) => {
    const src = byId.get(e.from.node)?.outputs.find((p) => p.name === e.from.port);
    const invalid = flowDiags.find((d) => d.path.edgeId === e.id && d.severity === "error");
    const view: EdgeView = {
      id: e.id,
      source: e.from.node,
      sourcePort: e.from.port,
      target: e.to.node,
      targetPort: e.to.port,
      color: src?.style.color ?? "var(--bf-ink-muted)",
      family: src?.led ?? "any",
      running: runNodes?.[e.to.node]?.status === "running",
    };
    if (invalid) view.invalid = invalid.message;
    return view;
  });

  const ran = (id: string, port: string) => {
    const s = runNodes?.[id]?.status;
    return port === EXEC_FAILED ? s === "failed" : s === "done" || s === "cached";
  };
  const execEdges: ExecEdgeView[] = (flow.execEdges ?? []).map((e) => ({
    id: e.id,
    source: e.from.node,
    sourcePort: e.from.port,
    target: e.to.node,
    targetPort: e.to.port,
    taken: ran(e.from.node, e.from.port) && runNodes?.[e.to.node] !== undefined,
  }));

  return { flowId, flow, scope, kindOf, nodes, edges, execEdges, hasLines: flow.execEdges !== undefined, byId };
}

/** How a wire joins two ports: directly, or through a conversion node put in between. */
export type ConnectionPlan = { kind: "direct" } | { kind: "convert"; conversion: ConversionMatch };

/**
 * How `from` (an output) can feed `to` (an input): `direct` when the types fit (or a generic
 * end can take it), `convert` when a conversion node of `catalog` turns one into the other,
 * `undefined` when neither. Execution lines are not handled here. The `edge.connect` command
 * makes the final decision.
 */
export function planConnection(view: FlowView, catalog: NodeCatalog | undefined, from: { node: string; port: string }, to: { node: string; port: string }): ConnectionPlan | undefined {
  if (from.node === to.node) return undefined;
  const out = view.byId.get(from.node)?.outputs.find((p) => p.name === from.port);
  const inp = view.byId.get(to.node)?.inputs.find((p) => p.name === to.port);
  if (!out || !inp) return undefined;
  if (containsVar(out.type)) return { kind: "direct" };
  const convert = (target: TypeRef): ConnectionPlan | undefined => {
    const c = catalog ? findConversions(catalog, out.type, target)[0] : undefined;
    return c ? { kind: "convert", conversion: c } : undefined;
  };
  if (containsVar(inp.declaredType)) {
    const r = bindTypeVars([{ port: inp.name, direction: "input", pattern: inp.declaredType, other: out.type }]);
    if (r.ok) {
      const bound = substituteTypeVars(inp.declaredType, r.bindings);
      if (containsVar(bound) || isAssignable(out.type, bound)) return { kind: "direct" };
    }
    const options = inp.declaredType.kind === "var" ? (inp.declaredType.oneOf ?? []) : [];
    for (const o of options) {
      const plan = convert(o);
      if (plan) return plan;
    }
    return undefined;
  }
  if (isAssignable(out.type, inp.type)) return { kind: "direct" };
  return convert(inp.type);
}

/**
 * Instant connection check for drag feedback: {@link planConnection} finds a way (directly
 * or through a conversion node).
 */
export function canConnect(view: FlowView, from: { node: string; port: string }, to: { node: string; port: string }, catalog?: NodeCatalog): boolean {
  return planConnection(view, catalog, from, to) !== undefined;
}

/** Visual media kind of a port type (`image`, `image?`, `list<video>`), if any. */
export function visualMediaKind(type: TypeRef): "image" | "video" | undefined {
  const inner = type.kind === "optional" || type.kind === "list" ? type.of : type;
  if (inner.kind === "optional" || inner.kind === "list") return visualMediaKind(inner);
  return inner.kind === "primitive" && (inner.name === "image" || inner.name === "video") ? inner.name : undefined;
}

/** What a node's inputs were in the run: the wired source's output, else the node's constant. */
function inputValues(flow: FlowDocument, node: NodeInstance, runNodes: RunState["nodes"] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(node.values ?? {}) };
  for (const e of flow.edges) {
    if (e.to.node !== node.id) continue;
    const source = runNodes?.[e.from.node]?.outputs;
    if (source && e.from.port in source) out[e.to.port] = source[e.from.port];
    else delete out[e.to.port];
  }
  return out;
}

function mediaPreviews(ports: readonly PortView[], values: Readonly<Record<string, unknown>> | undefined): MediaPreview[] {
  const out: MediaPreview[] = [];
  for (const p of ports) {
    const kind = visualMediaKind(p.type);
    if (!kind) continue;
    const value = values?.[p.name];
    const refs = (Array.isArray(value) ? value.flat() : [value]).filter(isMediaRef);
    out.push({ port: p.name, title: p.title, kind, refs });
  }
  return out;
}
