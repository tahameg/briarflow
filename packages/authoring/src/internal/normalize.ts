/**
 * Port follow-up after a command (commands.md §1.3, §1.4): renamed ports carry their edges
 * and constants; edges and constants of vanished ports are removed (and restored by the
 * inverse); generic bindings are recomputed.
 */
import {
  containsVar,
  jsonEquals,
  resolveFlowPorts,
  type ContextDocument,
  type Edge,
  type FlowDocument,
  type FlowPorts,
  type NodeCatalog,
  type NodeInstance,
  type ResolvedNode,
} from "@briarflow/core";
import type { Command } from "../commands.js";
import { without } from "./util.js";

/** Resolves (and memoizes per document object) the ports of a flow. */
export type PortsOf = (doc: ContextDocument, flowId: string) => FlowPorts;

export function createPortsCache(catalog: NodeCatalog): PortsOf {
  const cache = new WeakMap<ContextDocument, Map<string, FlowPorts>>();
  return (doc, flowId) => {
    let byFlow = cache.get(doc);
    if (!byFlow) {
      byFlow = new Map();
      cache.set(doc, byFlow);
    }
    let ports = byFlow.get(flowId);
    if (!ports) {
      ports = resolveFlowPorts(doc, flowId, catalog);
      byFlow.set(flowId, ports);
    }
    return ports;
  };
}

const PORTLESS_CODES = new Set([
  "node.unknown_type",
  "config.invalid",
  "config.unknown_ref",
  "node.ports_unresolved",
  "variable.unknown",
  "variable.write_to_readonly",
]);

/** A node that has no ports because of a problem keeps its edges and constants (DECISIONS #34). */
function isBroken(n: ResolvedNode): boolean {
  return n.inputs.length === 0 && n.outputs.length === 0 && n.diagnostics.some((d) => PORTLESS_CODES.has(d.code));
}

function has(n: ResolvedNode | undefined, side: "inputs" | "outputs", port: string): boolean {
  return n !== undefined && n[side].some((p) => p.name === port);
}

function flowIdsOf(doc: ContextDocument, touched: "all" | readonly string[]): string[] {
  return touched === "all" ? doc.flows.map((f) => f.id) : [...new Set(touched)];
}

/**
 * Renames ports that a command renamed: for every node whose `side` lost `oldName` and gained
 * `newName`, rewrites edges (and, for inputs, constant keys).
 */
export function followPortRename(
  before: ContextDocument,
  after: ContextDocument,
  touched: "all" | readonly string[],
  ports: PortsOf,
  oldName: string,
  newName: string,
): ContextDocument {
  let doc = after;
  for (const flowId of flowIdsOf(after, touched)) {
    if (!before.flows.some((f) => f.id === flowId)) continue;
    const flow = doc.flows.find((f) => f.id === flowId);
    if (!flow) continue;
    const bp = ports(before, flowId);
    const ap = ports(doc, flowId);
    const renamed: { node: string; side: "inputs" | "outputs" }[] = [];
    for (const node of flow.nodes) {
      const b = bp.nodes.get(node.id);
      const a = ap.nodes.get(node.id);
      for (const side of ["inputs", "outputs"] as const) {
        if (has(b, side, oldName) && !has(b, side, newName) && has(a, side, newName) && !has(a, side, oldName)) {
          renamed.push({ node: node.id, side });
        }
      }
    }
    if (renamed.length === 0) continue;
    const isIn = (nodeId: string) => renamed.some((r) => r.node === nodeId && r.side === "inputs");
    const isOut = (nodeId: string) => renamed.some((r) => r.node === nodeId && r.side === "outputs");
    const edges = flow.edges.map((e) => {
      let next = e;
      if (isOut(e.from.node) && e.from.port === oldName) next = { ...next, from: { ...next.from, port: newName } };
      if (isIn(e.to.node) && e.to.port === oldName) next = { ...next, to: { ...next.to, port: newName } };
      return next;
    });
    const nodes = flow.nodes.map((n) => {
      if (!isIn(n.id) || !n.values || !(oldName in n.values)) return n;
      const values: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n.values)) values[k === oldName ? newName : k] = v;
      return { ...n, values };
    });
    doc = { ...doc, flows: doc.flows.map((f) => (f.id === flowId ? { ...flow, edges, nodes } : f)) };
  }
  return doc;
}

/**
 * Removes edges/constants of ports that existed in `before` and vanished in `after`, then
 * recomputes `typeBindings`. Returns the new document and the commands restoring what was
 * removed (to run after the command's own inverse).
 */
export function normalize(
  before: ContextDocument,
  after: ContextDocument,
  touched: "all" | readonly string[],
  ports: PortsOf,
): { doc: ContextDocument; inverse: Command[] } {
  let doc = after;
  const inverse: Command[] = [];
  for (const flowId of flowIdsOf(after, touched)) {
    const flowAfter = doc.flows.find((f) => f.id === flowId);
    if (!flowAfter) continue;
    let flow: FlowDocument = flowAfter;
    if (before.flows.some((f) => f.id === flowId)) {
      const bp = ports(before, flowId);
      const ap = ports(doc, flowId);
      const vanished = (nodeId: string, side: "inputs" | "outputs", port: string): boolean => {
        const b = bp.nodes.get(nodeId);
        const a = ap.nodes.get(nodeId);
        if (!b || !a || isBroken(a)) return false;
        return has(b, side, port) && !has(a, side, port);
      };
      const keptEdges: Edge[] = [];
      flow.edges.forEach((e, index) => {
        if (vanished(e.from.node, "outputs", e.from.port) || vanished(e.to.node, "inputs", e.to.port)) {
          inverse.push({ op: "edge.connect", flowId, id: e.id, from: { ...e.from }, to: { ...e.to }, index });
        } else keptEdges.push(e);
      });
      const valueInverse: Command[] = [];
      const nodes = flow.nodes.map((n) => {
        if (!n.values) return n;
        let values: Record<string, unknown> | undefined;
        for (const [port, value] of Object.entries(n.values)) {
          if (!vanished(n.id, "inputs", port)) continue;
          values = without(values ?? { ...n.values }, port);
          valueInverse.push({ op: "node.setValue", flowId, nodeId: n.id, port, value });
        }
        if (!values) return n;
        return Object.keys(values).length === 0 ? without(n, "values") : { ...n, values };
      });
      inverse.push(...valueInverse);
      if (keptEdges.length !== flow.edges.length || valueInverse.length > 0) {
        flow = { ...flow, edges: keptEdges, nodes };
        doc = { ...doc, flows: doc.flows.map((f) => (f.id === flowId ? flow : f)) };
      }
    }
    doc = rebind(doc, flow, ports);
  }
  return { doc, inverse };
}

/** Stores recomputed `typeBindings` on nodes with generic ports. */
function rebind(doc: ContextDocument, flow: FlowDocument, ports: PortsOf): ContextDocument {
  const resolved = ports(doc, flow.id);
  let changed = false;
  const nodes = flow.nodes.map((n): NodeInstance => {
    const r = resolved.nodes.get(n.id);
    if (!r || ![...r.inputs, ...r.outputs].some((p) => containsVar(p.declaredType))) return n;
    const want = Object.keys(r.typeBindings).length > 0 ? r.typeBindings : undefined;
    if (jsonEquals(want ?? null, n.typeBindings ?? null)) return n;
    changed = true;
    return want ? { ...n, typeBindings: { ...want } } : without(n, "typeBindings");
  });
  if (!changed) return doc;
  return { ...doc, flows: doc.flows.map((f) => (f.id === flow.id ? { ...flow, nodes } : f)) };
}
