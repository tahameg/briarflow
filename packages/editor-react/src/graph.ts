/**
 * Pure view models for the canvas: a flow's nodes and edges with resolved ports, type styles,
 * diagnostics and run status. No React here, so it can be unit tested and reused by other
 * view layers.
 */
import {
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  VARIABLE_NODE_TYPES,
  containsVar,
  createCatalog,
  formatType,
  isAssignable,
  resolveFlowPorts,
  scopeForFlow,
} from "@briarflow/core";
import type {
  AnyNodeDefinition,
  ContextDocument,
  Diagnostic,
  FlowDocument,
  NodeCatalog,
  NodeInstance,
  PortWidget,
  Position,
  ResolvedPort,
  TypeRef,
  TypeScope,
} from "@briarflow/core";
import type { NodeRunState, RunState } from "@briarflow/editor";
import { nodeAccent, typeStyle } from "./theme.js";
import type { BriarToken, NamedKindLookup, TypeStyle } from "./theme.js";

/** One port of a node on the canvas. */
export interface PortView {
  name: string;
  title: string;
  description?: string;
  type: TypeRef;
  /** Shorthand (`list<Character?>`). */
  typeText: string;
  style: TypeStyle;
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
  definition: AnyNodeDefinition | undefined;
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
  /** Error message when the edge is invalid (e.g. `edge.type_mismatch`). */
  invalid?: string;
  /** Target node is running. */
  running: boolean;
}

/** Everything the canvas shows for one flow. */
export interface FlowView {
  flowId: string;
  flow: FlowDocument;
  scope: TypeScope;
  kindOf: NamedKindLookup;
  nodes: NodeView[];
  edges: EdgeView[];
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
  for (const node of flow.nodes) titles.set(node.id, nodeTitle(doc, flow, node, cat.get(node.type)));

  const incoming = new Map<string, { nodeId: string; port: string; edgeId: string }>();
  for (const e of flow.edges) incoming.set(`${e.to.node}\u0000${e.to.port}`, { nodeId: e.from.node, port: e.from.port, edgeId: e.id });

  const portView = (node: NodeInstance, p: ResolvedPort, dir: "in" | "out", diags: Diagnostic[]): PortView => {
    const view: PortView = {
      name: p.name,
      title: p.title,
      type: p.type,
      typeText: formatType(p.type, scope),
      style: typeStyle(p.type, kindOf),
      hasDefault: p.hasDefault,
      hasValue: false,
      errors: diags.filter((d) => d.severity === "error" && d.path.port === p.name).map((d) => d.message),
    };
    if (p.description !== undefined) view.description = p.description;
    if (p.widget !== undefined) view.widget = p.widget;
    if (p.hasDefault) view.default = p.default;
    if (dir === "in") {
      const src = incoming.get(`${node.id}\u0000${p.name}`);
      if (src) view.source = { ...src, label: `${titles.get(src.nodeId) ?? src.nodeId}.${src.port}` };
      const values = node.values ?? {};
      if (Object.prototype.hasOwnProperty.call(values, p.name)) {
        view.hasValue = true;
        view.value = values[p.name];
      }
    }
    return view;
  };

  const nodes: NodeView[] = flow.nodes.map((node) => {
    const def = cat.get(node.type);
    const resolved = ports?.nodes.get(node.id);
    const builtin = node.type === FLOW_INPUT_NODE_TYPE || node.type === FLOW_OUTPUT_NODE_TYPE;
    const diags = flowDiags.filter((d) => d.path.nodeId === node.id);
    const variable = isVariableNode(node.type);
    const view: NodeView = {
      id: node.id,
      type: node.type,
      title: titles.get(node.id) ?? node.id,
      typeTitle: builtin ? (node.type === FLOW_INPUT_NODE_TYPE ? "flow inputs" : "flow outputs") : (def?.title ?? node.type),
      accent: builtin ? "yellow" : variable ? "pink" : nodeAccent(def?.color, def?.category),
      builtin,
      variable,
      unknownType: !builtin && def === undefined,
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
    const preview = node.type === "text.template" ? (node.config?.template as string | undefined) : previewOf(node);
    if (preview) view.preview = preview;
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
      running: runNodes?.[e.to.node]?.status === "running",
    };
    if (invalid) view.invalid = invalid.message;
    return view;
  });

  return { flowId, flow, scope, kindOf, nodes, edges, byId };
}

/**
 * Instant connection check for drag feedback: output → input, different nodes, and
 * `isAssignable` when both types are concrete. Generic (`$T`) ends are allowed; the
 * `edge.connect` command makes the final decision.
 */
export function canConnect(view: FlowView, from: { node: string; port: string }, to: { node: string; port: string }): boolean {
  if (from.node === to.node) return false;
  const out = view.byId.get(from.node)?.outputs.find((p) => p.name === from.port);
  const inp = view.byId.get(to.node)?.inputs.find((p) => p.name === to.port);
  if (!out || !inp) return false;
  if (containsVar(out.type) || containsVar(inp.type)) return true;
  return isAssignable(out.type, inp.type);
}
