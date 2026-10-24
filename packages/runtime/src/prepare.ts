/**
 * Internal: turns a context + flow id into an execution plan (runtime.md §2.1, §3;
 * variables.md §4, §6).
 */
import {
  analyzeExec,
  computeVariableOrder,
  findFlow,
  nodeLabel,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  normalizeValue,
  resolveFlowPorts,
  scopeForFlow,
  validateFlow,
  validateNodeConfig,
  VARIABLE_NODE_TYPES,
  type AnyNodeDefinition,
  type ContextDocument,
  type Diagnostic,
  type FlowDocument,
  type NodeCatalog,
  type NodeInstance,
  type PortAddress,
  type ResolvedNode,
  type SerializedError,
  type TypeRef,
  type TypeScope,
} from "@briarflow/core";
import { normalizeRunInputs } from "./values.js";

/** How the engine executes a node. Everything except `node` runs inline (no slot, no cache). */
export type NodeKind = "input" | "output" | "variableGet" | "variableSet" | "globalGet" | "globalSet" | "node";

/** Marker for a variable without a starting value. */
export const UNSET: unique symbol = Symbol("unset");
export type Slot = unknown | typeof UNSET;

/** A variable or global, keyed `var:<id>` / `global:<id>`. */
export interface VariableSlot {
  key: string;
  kind: "flow" | "global";
  id: string;
  name: string;
  type: TypeRef;
  /** Public flow variable (reported in `RunResult.variables`). */
  isPublic: boolean;
  start: Slot;
}

export interface PlannedNode {
  id: string;
  node: NodeInstance;
  kind: NodeKind;
  def: AnyNodeDefinition | undefined;
  /** `node.title`, else the definition title. */
  title: string;
  ports: ResolvedNode;
  config: Record<string, unknown>;
  /** `"name@version"` of the providing pack. */
  pack: string;
  deps: Set<string>;
  dependents: Set<string>;
  depth: number;
  /** Input port → feeding output. */
  incoming: Map<string, PortAddress>;
  /** Variable slot key for variable nodes. */
  variable?: string;
  /** Pure node (no execution line): runs when a node on the line needs its outputs. */
  pure: boolean;
}

/** Execution lines of a flow that has them (docs/specs/execution.md). */
export interface ExecPlan {
  inputId: string;
  outputId: string;
  /** Node id → execution output (`then`, `failed`) → next node id. */
  next: Map<string, Map<string, string>>;
}

export interface Plan {
  flow: FlowDocument;
  scope: TypeScope;
  inputs: Record<string, unknown>;
  nodes: Map<string, PlannedNode>;
  variables: Map<string, VariableSlot>;
  /** Get node id → writer node id it reads (`null` = starting value). Data-driven flows only. */
  reads: Map<string, string | null>;
  /** Set when the flow has execution lines: only live nodes are planned, run along the line. */
  exec?: ExecPlan;
}

export type PrepareResult = { ok: true; plan: Plan } | { ok: false; error: SerializedError };

function startValue(type: TypeRef, value: unknown, scope: TypeScope, useEmptyDefaults: boolean): Slot {
  if (value !== undefined) {
    const r = normalizeValue(value, type, scope);
    return r.ok ? r.value : value;
  }
  if (!useEmptyDefaults) return UNSET;
  if (type.kind === "optional") return null;
  if (type.kind === "list") return [];
  return UNSET;
}

function kindOf(type: string): NodeKind {
  switch (type) {
    case FLOW_INPUT_NODE_TYPE:
      return "input";
    case FLOW_OUTPUT_NODE_TYPE:
      return "output";
    case VARIABLE_NODE_TYPES.variableGet:
      return "variableGet";
    case VARIABLE_NODE_TYPES.variableSet:
      return "variableSet";
    case VARIABLE_NODE_TYPES.globalGet:
      return "globalGet";
    case VARIABLE_NODE_TYPES.globalSet:
      return "globalSet";
    default:
      return "node";
  }
}

function invalidFlow(flowName: string, diagnostics: Diagnostic[]): SerializedError {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return {
    code: "run.invalid_flow",
    message:
      errors.length === 1
        ? `Flow "${flowName}" has 1 error: ${errors[0]?.message ?? "unknown problem"}`
        : `Flow "${flowName}" has ${errors.length} errors. First: ${errors[0]?.message ?? "unknown problem"}`,
    details: { diagnostics: errors },
  };
}

/** Validates the flow and inputs and builds the plan. Throws only for engine bugs. */
export function prepare(doc: ContextDocument, flowId: string, catalog: NodeCatalog, rawInputs: unknown): PrepareResult {
  const flow = findFlow(doc, flowId);
  if (!flow) {
    const diagnostic: Diagnostic = {
      severity: "error",
      code: "flow.not_found",
      message: `Flow "${flowId}" does not exist in context "${doc.name}" (${doc.id}). Check the flow id.`,
      path: { flowId },
    };
    return {
      ok: false,
      error: { code: "run.invalid_flow", message: `Flow "${flowId}" does not exist in context "${doc.name}". Check the flow id.`, details: { diagnostics: [diagnostic] } },
    };
  }

  const diagnostics = validateFlow(doc, flowId, catalog);
  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, error: invalidFlow(flow.name, diagnostics) };

  const scope = scopeForFlow(doc, flowId, catalog);
  const inputs = normalizeRunInputs(flow, rawInputs, scope);
  if (!inputs.ok) {
    const first = inputs.diagnostics[0]?.message ?? "invalid inputs";
    return {
      ok: false,
      error: {
        code: "run.invalid_inputs",
        message:
          inputs.diagnostics.length === 1
            ? `Flow "${flow.name}" received 1 invalid input: ${first}`
            : `Flow "${flow.name}" received ${inputs.diagnostics.length} invalid inputs. First: ${first}`,
        details: { diagnostics: inputs.diagnostics },
      },
    };
  }

  const ports = resolveFlowPorts(doc, flowId, catalog);
  const lines = flow.execEdges === undefined ? undefined : analyzeExec(doc, flow, catalog);
  const order = lines ? { plans: [], implicitEdges: [] } : computeVariableOrder(doc, flowId, catalog);

  // Variables and globals.
  const variables = new Map<string, VariableSlot>();
  for (const v of flow.variables) {
    variables.set(`var:${v.id}`, {
      key: `var:${v.id}`,
      kind: "flow",
      id: v.id,
      name: v.name,
      type: v.type,
      isPublic: v.access === "public",
      start: startValue(v.type, v.default, scope, true),
    });
  }
  for (const g of doc.globals) {
    variables.set(`global:${g.id}`, {
      key: `global:${g.id}`,
      kind: "global",
      id: g.id,
      name: g.name,
      type: g.type,
      isPublic: false,
      start: startValue(g.type, g.value, scope, false),
    });
  }
  const reads = new Map<string, string | null>();
  for (const plan of order.plans) for (const [getId, writer] of Object.entries(plan.reads)) reads.set(getId, writer);

  // Nodes.
  const nodes = new Map<string, PlannedNode>();
  for (const node of flow.nodes) {
    if (nodes.has(node.id)) continue;
    if (lines && !lines.live.has(node.id)) continue;
    const resolved = ports.nodes.get(node.id);
    if (!resolved) continue;
    const kind = kindOf(node.type);
    const def = kind === "input" || kind === "output" ? undefined : resolved.definition;
    let config: Record<string, unknown> = {};
    if (def) {
      const r = validateNodeConfig(def, node.config, doc, flowId, catalog);
      config = r.ok ? r.config : { ...(node.config ?? {}) };
    }
    const packOf = catalog.packOf(node.type);
    const fallbackTitle = kind === "input" ? "Input" : kind === "output" ? "Output" : (def?.title ?? node.type);
    const planned: PlannedNode = {
      id: node.id,
      node,
      kind,
      def,
      title: node.title !== undefined && node.title.trim() !== "" ? node.title : fallbackTitle,
      ports: resolved,
      config,
      pack: packOf ? `${packOf.name}@${packOf.version}` : "",
      deps: new Set(),
      dependents: new Set(),
      depth: 0,
      incoming: new Map(),
      pure: def?.pure === true,
    };
    if (kind === "variableGet" || kind === "variableSet") planned.variable = `var:${String(config["variableId"])}`;
    if (kind === "globalGet" || kind === "globalSet") planned.variable = `global:${String(config["globalId"])}`;
    nodes.set(node.id, planned);
  }

  const link = (from: string, to: string) => {
    const a = nodes.get(from);
    const b = nodes.get(to);
    if (!a || !b || from === to) return;
    b.deps.add(from);
    a.dependents.add(to);
  };
  for (const edge of flow.edges) {
    const target = nodes.get(edge.to.node);
    if (!target || !nodes.has(edge.from.node)) continue;
    target.incoming.set(edge.to.port, edge.from);
    link(edge.from.node, edge.to.node);
  }
  for (const e of order.implicitEdges) link(e.from, e.to);

  // Topological depth (longest path from a node without dependencies); detects cycles.
  const remaining = new Map<string, number>();
  for (const n of nodes.values()) remaining.set(n.id, n.deps.size);
  let frontier = [...nodes.values()].filter((n) => n.deps.size === 0).map((n) => n.id);
  let visited = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      visited += 1;
      const n = nodes.get(id) as PlannedNode;
      for (const d of n.dependents) {
        const dep = nodes.get(d) as PlannedNode;
        dep.depth = Math.max(dep.depth, n.depth + 1);
        const left = (remaining.get(d) ?? 0) - 1;
        remaining.set(d, left);
        if (left === 0) next.push(d);
      }
    }
    frontier = next;
  }
  if (visited !== nodes.size) {
    const stuck = [...remaining.entries()].filter(([, n]) => n > 0).map(([id]) => id);
    const loop = findLoop(stuck, nodes);
    const label = (id: string): string => {
      const instance = flow.nodes.find((n) => n.id === id);
      return instance ? nodeLabel(instance, catalog.get(instance.type)) : id;
    };
    const path = loop.length > 0 ? [...loop, loop[0] as string].map(label).join(" → ") : stuck.map(label).join(", ");
    const diagnostic: Diagnostic = {
      severity: "error",
      code: "flow.cycle",
      message: `Flow "${flow.name}" has a loop: ${path}.`,
      path: { flowId },
      details: { nodes: stuck },
    };
    return { ok: false, error: invalidFlow(flow.name, [diagnostic]) };
  }

  const plan: Plan = { flow, scope, inputs: inputs.values, nodes, variables, reads };
  if (lines) {
    const next = new Map<string, Map<string, string>>();
    for (const e of flow.execEdges ?? []) {
      if (!nodes.has(e.from.node) || !nodes.has(e.to.node)) continue;
      const out = next.get(e.from.node) ?? new Map<string, string>();
      out.set(e.from.port, e.to.node);
      next.set(e.from.node, out);
    }
    const inputId = [...nodes.values()].find((n) => n.kind === "input")?.id ?? "";
    const outputId = flow.nodes.find((n) => n.type === FLOW_OUTPUT_NODE_TYPE)?.id ?? "";
    plan.exec = { inputId, outputId, next };
  }
  return { ok: true, plan };
}

/**
 * One concrete loop among `stuck` nodes, as node ids in execution direction. Every stuck node
 * has a stuck dependency, so walking dependencies always ends in a loop.
 */
function findLoop(stuck: readonly string[], nodes: ReadonlyMap<string, PlannedNode>): string[] {
  const inStuck = new Set(stuck);
  for (const start of [...stuck].sort()) {
    const path: string[] = [];
    const index = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !index.has(current)) {
      index.set(current, path.length);
      path.push(current);
      const n = nodes.get(current);
      current = n ? [...n.deps].filter((d) => inStuck.has(d)).sort()[0] : undefined;
    }
    if (current !== undefined) return path.slice(index.get(current)).reverse();
  }
  return [];
}

/** Ascending (depth, id). */
export function byDepthThenId(a: PlannedNode, b: PlannedNode): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
