/**
 * Execution lines (docs/specs/execution.md): auto-wiring of flows made before them, checks of
 * the lines themselves, and which nodes are live (run) in a flow that has them.
 */
import type { ContextDocument, ExecEdge, FlowDocument } from "../documents/model.js";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "../documents/model.js";
import { findFlow } from "../documents/factories.js";
import type { NodeCatalog } from "../nodes/catalog.js";
import { EXEC_IN, EXEC_THEN, execPortsOf } from "../nodes/exec-ports.js";
import type { Diagnostic } from "./diagnostic.js";
import { buildAdjacency, findCycles, reachability } from "./graph.js";
import { nodeLabel } from "./labels.js";
import { computeVariableOrder } from "./variables.js";

/** Which nodes of a flow with execution lines run, and in what order they may. */
export interface ExecAnalysis {
  /** Nodes on the execution line reachable from Input. */
  onLine: ReadonlySet<string>;
  /** `onLine` plus the pure nodes they read from: everything that may run. */
  live: ReadonlySet<string>;
  /** For each node on the line, the line nodes that always run before it can (its line ancestors). */
  before: ReadonlyMap<string, ReadonlySet<string>>;
  diagnostics: Diagnostic[];
}

/**
 * The execution lines a flow made before them gets: Input → every execution node in data
 * order (data edges and variable write → read order; ties by position, then id) → Output.
 *
 * @example
 * ```ts
 * const edges = autoExecEdges(doc, "flow_p", catalog); // [{ id: "x_1", from: { node: "n_in", port: "then" }, … }]
 * ```
 */
export function autoExecEdges(doc: ContextDocument, flowId: string, catalog: NodeCatalog): ExecEdge[] {
  const flow = findFlow(doc, flowId);
  if (!flow) return [];
  const input = flow.nodes.find((n) => n.type === FLOW_INPUT_NODE_TYPE);
  const output = flow.nodes.find((n) => n.type === FLOW_OUTPUT_NODE_TYPE);
  if (!input || !output) return [];
  const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
  const deps = new Map<string, Set<string>>(flow.nodes.map((n) => [n.id, new Set<string>()]));
  const link = (from: string, to: string) => from !== to && byId.has(from) && deps.get(to)?.add(from);
  for (const e of flow.edges) link(e.from.node, e.to.node);
  let implicit: readonly { from: string; to: string }[] = [];
  try {
    implicit = computeVariableOrder(doc, flowId, catalog).implicitEdges;
  } catch {
    implicit = [];
  }
  for (const e of implicit) link(e.from, e.to);

  // Kahn's algorithm, picking the leftmost (then topmost, then smallest id) ready node.
  const order: string[] = [];
  const left = new Map([...deps].map(([id, d]) => [id, d.size] as const));
  const dependents = new Map<string, string[]>(flow.nodes.map((n) => [n.id, []]));
  for (const [id, d] of deps) for (const from of d) dependents.get(from)?.push(id);
  const ready = flow.nodes.filter((n) => (left.get(n.id) ?? 0) === 0).map((n) => n.id);
  const rank = (id: string) => {
    const p = byId.get(id)?.position ?? { x: 0, y: 0 };
    return [p.x, p.y, id] as const;
  };
  const before = (a: string, b: string) => {
    const [ax, ay, ai] = rank(a);
    const [bx, by, bi] = rank(b);
    return ax !== bx ? ax - bx : ay !== by ? ay - by : ai < bi ? -1 : ai > bi ? 1 : 0;
  };
  const seen = new Set<string>();
  while (ready.length > 0) {
    ready.sort(before);
    const id = ready.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const d of dependents.get(id) ?? []) {
      const n = (left.get(d) ?? 0) - 1;
      left.set(d, n);
      if (n === 0) ready.push(d);
    }
  }
  // Nodes in a data loop never become ready; append them so they still get a place.
  for (const n of [...flow.nodes].sort((a, b) => before(a.id, b.id))) if (!seen.has(n.id)) order.push(n.id);

  const chain = order.filter((id) => {
    const n = byId.get(id);
    if (!n || n.id === input.id || n.id === output.id) return false;
    return execPortsOf(n.type, catalog.get(n.type)).inputs.includes(EXEC_IN);
  });
  const stops = [input.id, ...chain, output.id];
  return stops.slice(1).map((to, i) => ({ id: `x_${i + 1}`, from: { node: stops[i] as string, port: EXEC_THEN }, to: { node: to, port: EXEC_IN } }));
}

/**
 * Checks a flow's execution lines and works out which nodes are live. Only meaningful for a
 * flow with `execEdges`.
 */
export function analyzeExec(doc: ContextDocument, flow: FlowDocument, catalog: NodeCatalog): ExecAnalysis {
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, path: Diagnostic["path"], details?: unknown, severity: Diagnostic["severity"] = "error") =>
    diagnostics.push({ severity, code, message, path: { flowId: flow.id, ...path }, ...(details === undefined ? {} : { details }) });
  const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? nodeLabel(n, catalog.get(n.type)) : id;
  };
  const ports = (id: string) => {
    const n = byId.get(id);
    return n ? execPortsOf(n.type, catalog.get(n.type)) : { inputs: [], outputs: [] };
  };

  // The lines themselves.
  const valid: ExecEdge[] = [];
  const ids = new Set<string>();
  const fromPort = new Map<string, string>();
  for (const e of flow.execEdges ?? []) {
    if (ids.has(e.id)) err("flow.duplicate_id", `Flow "${flow.name}" has two execution lines with id "${e.id}". Give one a new id.`, { edgeId: e.id });
    ids.add(e.id);
    if (!byId.has(e.from.node) || !byId.has(e.to.node)) {
      err("exec.unknown_node", `Execution line ${e.id} points to a node that does not exist in flow "${flow.name}". Remove the line.`, { edgeId: e.id });
      continue;
    }
    if (!ports(e.from.node).outputs.includes(e.from.port)) {
      err("exec.unknown_port", `${label(e.from.node)} has no execution output "${e.from.port}".`, { edgeId: e.id, nodeId: e.from.node });
      continue;
    }
    if (!ports(e.to.node).inputs.includes(e.to.port)) {
      err("exec.unknown_port", `${label(e.to.node)} has no execution input "${e.to.port}".`, { edgeId: e.id, nodeId: e.to.node });
      continue;
    }
    const key = `${e.from.node}\u0000${e.from.port}`;
    const prior = fromPort.get(key);
    if (prior !== undefined) {
      err("exec.duplicate_output", `${label(e.from.node)} sends "${e.from.port}" down two lines (${prior}, ${e.id}). An execution output goes one way; remove one.`, {
        edgeId: e.id,
        nodeId: e.from.node,
      });
      continue;
    }
    fromPort.set(key, e.id);
    valid.push(e);
  }
  const nodeIds = flow.nodes.map((n) => n.id);
  const adj = buildAdjacency(
    nodeIds,
    valid.map((e) => ({ from: e.from.node, to: e.to.node })),
  );
  for (const cycle of findCycles(adj)) {
    err("exec.cycle", `The execution line loops: ${cycle.map(label).join(" → ")}. Loops need a loop node; remove a line.`, { nodeId: cycle[0] as string }, { cycle });
  }

  // On the line: reachable from Input.
  const input = flow.nodes.find((n) => n.type === FLOW_INPUT_NODE_TYPE);
  const output = flow.nodes.find((n) => n.type === FLOW_OUTPUT_NODE_TYPE);
  const reach = reachability(adj);
  const onLine = new Set<string>(input ? [input.id, ...(reach.get(input.id) ?? [])] : []);
  const before = new Map<string, Set<string>>();
  for (const id of onLine) before.set(id, new Set());
  for (const a of onLine) for (const b of reach.get(a) ?? []) if (a !== b) before.get(b)?.add(a);

  // Live: on the line plus the pure nodes they read from. A value from a line node must be ready.
  const sources = new Map<string, { node: string; port: string; edgeId: string; toPort: string }[]>();
  for (const e of flow.edges) {
    const list = sources.get(e.to.node) ?? [];
    list.push({ node: e.from.node, port: e.from.port, edgeId: e.id, toPort: e.to.port });
    sources.set(e.to.node, list);
  }
  const live = new Set(onLine);
  for (const consumer of onLine) {
    const stack = [consumer];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (visited.has(at)) continue;
      visited.add(at);
      for (const s of sources.get(at) ?? []) {
        const src = byId.get(s.node);
        if (!src) continue;
        if (ports(s.node).inputs.length === 0 && ports(s.node).outputs.length === 0) {
          live.add(s.node);
          stack.push(s.node);
          continue;
        }
        if (s.node === consumer || before.get(consumer)?.has(s.node)) continue;
        err(
          "exec.value_unavailable",
          onLine.has(s.node)
            ? `${label(consumer)} uses ${label(s.node)}.${s.port}, but ${label(s.node)} does not always run before it on the execution line. Move ${label(s.node)} earlier on the line.`
            : `${label(consumer)} uses ${label(s.node)}.${s.port}, but ${label(s.node)} is not on the execution line, so it never runs. Connect it to the line before ${label(consumer)}.`,
          { nodeId: consumer, edgeId: s.edgeId, port: s.toPort },
          { source: s.node },
        );
      }
    }
  }

  if (output && !onLine.has(output.id) && flow.outputs.length > 0) {
    err("exec.output_unreachable", `The execution line never reaches Output, so runs of "${flow.name}" end without outputs. Connect the line to Output.`, { nodeId: output.id }, undefined, "warning");
  }
  return { onLine, live, before, diagnostics };
}
