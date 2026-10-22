/**
 * Variable/global ordering (docs/specs/variables.md §4). Shared by validation and the runtime.
 */
import type { ContextDocument } from "../documents/model.js";
import { VARIABLE_NODE_TYPES } from "../documents/model.js";
import type { FlowDocument, NodeInstance } from "../documents/model.js";
import { findFlow } from "../documents/factories.js";
import { flowNotFound } from "../types/scope.js";
import { buildAdjacency, findCycles, reachability } from "./graph.js";
import { nodeLabel } from "./labels.js";
import type { NodeCatalog } from "../nodes/catalog.js";
import type { Diagnostic } from "./diagnostic.js";

/** Which variable an ordering edge is about. */
export type VariableTarget = { kind: "flow"; variableId: string } | { kind: "global"; globalId: string };

/** "`to` (a get node) waits for `from` (a set node)" (Rule 2). */
export interface ImplicitEdge {
  from: string;
  to: string;
  variable: VariableTarget;
}

/** Writers of one variable in execution order (Rule 1) and what each get reads (Rule 3). */
export interface VariableAccessPlan {
  variable: VariableTarget;
  /** Set node ids, `w1 … wk`. */
  writers: string[];
  /** Get node id → id of the writer it reads, or `null` for the starting value. */
  reads: Record<string, string | null>;
}

/** Result of {@link computeVariableOrder}. */
export interface VariableOrder {
  implicitEdges: ImplicitEdge[];
  plans: VariableAccessPlan[];
  /**
   * `variable.unordered_writes`, `variable.read_before_write`, `variable.unknown`,
   * `variable.write_to_readonly`, `flow.cycle` (path marks implicit edges).
   */
  diagnostics: Diagnostic[];
}

/**
 * Computes implicit ordering edges for `briar.variable.*` / `briar.global.*` nodes from data
 * paths only (deterministic, independent of evaluation order).
 *
 * @example
 * ```ts
 * const { implicitEdges } = computeVariableOrder(doc, "flow_p", catalog);
 * ```
 */
export function computeVariableOrder(doc: ContextDocument, flowId: string, catalog: NodeCatalog): VariableOrder {
  const flow = findFlow(doc, flowId);
  if (!flow) throw flowNotFound(doc, flowId);
  const label = (n: NodeInstance) => nodeLabel(n, catalog.get(n.type));
  const diagnostics: Diagnostic[] = [];
  const nodeIds = uniqueNodeIds(flow);
  const dataEdges = flow.edges.map((e) => ({ from: e.from.node, to: e.to.node }));
  const adj = buildAdjacency(nodeIds, dataEdges);
  const reach = reachability(adj);
  const reaches = (a: string, b: string) => reach.get(a)?.has(b) === true;

  interface Access {
    node: NodeInstance;
    write: boolean;
  }
  const accesses = new Map<string, Access[]>();
  const seen = new Set<string>();
  for (const node of flow.nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const isFlowVar = node.type === VARIABLE_NODE_TYPES.variableGet || node.type === VARIABLE_NODE_TYPES.variableSet;
    const isGlobal = node.type === VARIABLE_NODE_TYPES.globalGet || node.type === VARIABLE_NODE_TYPES.globalSet;
    if (!isFlowVar && !isGlobal) continue;
    const write = node.type === VARIABLE_NODE_TYPES.variableSet || node.type === VARIABLE_NODE_TYPES.globalSet;
    const ref = node.config?.[isFlowVar ? "variableId" : "globalId"];
    const exists =
      typeof ref === "string" && (isFlowVar ? flow.variables.some((v) => v.id === ref) : doc.globals.some((g) => g.id === ref));
    if (!exists) {
      diagnostics.push({
        severity: "error",
        code: "variable.unknown",
        message: `${label(node)} refers to a variable that no longer exists. Pick another variable or remove the node.`,
        path: { flowId, nodeId: node.id },
        details: { id: typeof ref === "string" ? ref : null },
      });
      continue;
    }
    if (isGlobal && write) {
      const g = doc.globals.find((x) => x.id === ref);
      if (g && g.access === "readonly") {
        diagnostics.push({
          severity: "error",
          code: "variable.write_to_readonly",
          message: `${label(node)} writes readonly global "${g.name}". Make the global readwrite or remove the node.`,
          path: { flowId, nodeId: node.id, globalId: g.id },
        });
      }
    }
    const key = `${isFlowVar ? "flow" : "global"}:${ref as string}`;
    accesses.set(key, [...(accesses.get(key) ?? []), { node, write }]);
  }

  const targets: { key: string; target: VariableTarget; name: string; hasStart: boolean; kind: string }[] = [
    ...flow.variables.map((v) => ({
      key: `flow:${v.id}`,
      target: { kind: "flow" as const, variableId: v.id },
      name: v.name,
      hasStart: v.default !== undefined || v.type.kind === "optional" || v.type.kind === "list",
      kind: "var",
    })),
    ...doc.globals.map((g) => ({
      key: `global:${g.id}`,
      target: { kind: "global" as const, globalId: g.id },
      name: g.name,
      hasStart: g.value !== undefined || g.type.kind === "optional" || g.type.kind === "list",
      kind: "global",
    })),
  ];

  const implicitEdges: ImplicitEdge[] = [];
  const plans: VariableAccessPlan[] = [];
  const implicitLabel = new Map<string, string>();
  for (const t of targets) {
    const list = accesses.get(t.key);
    if (!list) continue;
    const idPath = t.target.kind === "flow" ? { variableId: t.target.variableId } : { globalId: t.target.globalId };
    const writers = list.filter((a) => a.write).map((a) => a.node);
    const getters = list.filter((a) => !a.write).map((a) => a.node);
    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i] as NodeInstance;
        const b = writers[j] as NodeInstance;
        if (!reaches(a.id, b.id) && !reaches(b.id, a.id)) {
          diagnostics.push({
            severity: "error",
            code: "variable.unordered_writes",
            message: `Variable "${t.name}" is written by ${label(a)} and ${label(b)}, but neither comes after the other. Connect them in sequence or use one Set node.`,
            path: { flowId, nodeId: b.id, ...idPath },
            details: { writers: [a.id, b.id] },
          });
        }
      }
    }
    const rank = (w: NodeInstance) => writers.filter((o) => o !== w && reaches(o.id, w.id)).length;
    const ordered = writers
      .map((w, i) => ({ w, i, r: rank(w) }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.w);
    const reads: Record<string, string | null> = {};
    for (const g of getters) {
      let last: string | null = null;
      for (const w of ordered) {
        if (reaches(g.id, w.id)) continue;
        implicitEdges.push({ from: w.id, to: g.id, variable: t.target });
        implicitLabel.set(`${w.id}\u0000${g.id}`, `(writes ${t.kind} ${t.name})`);
        last = w.id;
      }
      reads[g.id] = last;
      if (last === null && !t.hasStart) {
        diagnostics.push({
          severity: "error",
          code: "variable.read_before_write",
          message: `${label(g)} reads "${t.name}" before anything writes it, and "${t.name}" has no default. Give it a default or move a Set node before it.`,
          path: { flowId, nodeId: g.id, ...idPath },
        });
      }
    }
    plans.push({ variable: t.target, writers: ordered.map((w) => w.id), reads });
  }

  // Rule 4: cycles through implicit edges (pure data cycles are reported by validateFlow).
  if (implicitEdges.length > 0 && findCycles(adj).length === 0) {
    const all = buildAdjacency(nodeIds, [...dataEdges, ...implicitEdges]);
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    const dataSet = new Set(dataEdges.map((e) => `${e.from}\u0000${e.to}`));
    for (const cycle of findCycles(all)) {
      let text = "";
      cycle.forEach((id, i) => {
        const n = byId.get(id);
        const name = n ? label(n) : id;
        if (i === 0) {
          text = name;
          return;
        }
        const key = `${cycle[i - 1] as string}\u0000${id}`;
        text += dataSet.has(key) ? ` → ${name}` : ` ⇢ ${implicitLabel.get(key) ?? "(variable order)"} ⇢ ${name}`;
      });
      diagnostics.push({
        severity: "error",
        code: "flow.cycle",
        message: `Flow "${flow.name}" has a loop: ${text}.`,
        path: { flowId, nodeId: cycle[0] as string },
        details: { cycle },
      });
    }
  }
  return { implicitEdges, plans, diagnostics };
}

function uniqueNodeIds(flow: FlowDocument): string[] {
  return [...new Set(flow.nodes.map((n) => n.id))];
}
