/**
 * Execution line commands (docs/specs/execution.md): exec.connect, exec.disconnect,
 * flow.exec.enable (auto-wire a flow made before execution lines), flow.exec.set (restore).
 */
import { autoExecEdges, execPortsOf, type ExecEdge, type FlowDocument, type NodeInstance } from "@briarflow/core";
import type { Command, PortRef } from "../../commands.js";
import { getFlow, getNode, newId, putFlow, type Ctx, type Effect, type Payload } from "../ctx.js";
import { fail, insertAt } from "../util.js";
import { label } from "./graph.js";

function lines(ctx: Ctx, flow: FlowDocument): readonly ExecEdge[] {
  if (flow.execEdges === undefined) {
    fail("exec.not_enabled", `Flow "${flow.name}" has no execution line yet. Run flow.exec.enable first.`, { flowId: flow.id });
  }
  return flow.execEdges;
}

function execPorts(ctx: Ctx, node: NodeInstance) {
  return execPortsOf(node.type, ctx.catalog.get(node.type));
}

/** `exec.connect` that recreates `edge` at `index` (restore). */
export function execConnectCommand(flowId: string, edge: ExecEdge, index: number): Command {
  return { op: "exec.connect", flowId, id: edge.id, from: { ...edge.from }, to: { ...edge.to }, index };
}

/** Path from `start` to `goal` along execution lines, or undefined. */
function linePath(edges: readonly ExecEdge[], start: string, goal: string): string[] | undefined {
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === goal) {
      const path = [at];
      for (let p = prev.get(at); p !== undefined; p = prev.get(p)) path.unshift(p);
      return path;
    }
    for (const e of edges) {
      if (e.from.node !== at || seen.has(e.to.node)) continue;
      seen.add(e.to.node);
      prev.set(e.to.node, at);
      queue.push(e.to.node);
    }
  }
  return undefined;
}

export function execConnect(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const edges = lines(ctx, flow);
  const from = p["from"] as PortRef;
  const to = p["to"] as PortRef;
  const fromNode = getNode(ctx, flow, from.node);
  const toNode = getNode(ctx, flow, to.node);
  const fp = execPorts(ctx, fromNode);
  const tp = execPorts(ctx, toNode);
  if (!fp.outputs.includes(from.port)) {
    fail("exec.unknown_port", `${label(ctx, fromNode)} has no execution output "${from.port}". Execution outputs: ${fp.outputs.join(", ") || "none"}.`, { nodeId: from.node, port: from.port });
  }
  if (!tp.inputs.includes(to.port)) {
    fail("exec.unknown_port", `${label(ctx, toNode)} has no execution input "${to.port}". Execution inputs: ${tp.inputs.join(", ") || "none"}.`, { nodeId: to.node, port: to.port });
  }
  if (from.node === to.node) fail("exec.self_loop", "A node's execution line cannot go back into itself.", { nodeId: from.node });

  const same = edges.find((e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to.node && e.to.port === to.port);
  if (same) return { created: { edgeId: same.id }, inverse: [], resolved: { ...p, id: same.id } as unknown as Command, touched: "none" };

  // An execution output goes one way: a new line from it replaces the old one.
  const replacedIndex = edges.findIndex((e) => e.from.node === from.node && e.from.port === from.port);
  const replaced = replacedIndex >= 0 ? (edges[replacedIndex] as ExecEdge) : undefined;
  const remaining = edges.filter((_, i) => i !== replacedIndex);
  const loop = linePath(remaining, to.node, from.node);
  if (loop) {
    const names = [fromNode, ...loop.map((id) => flow.nodes.find((n) => n.id === id) as NodeInstance)].map((n) => label(ctx, n));
    fail("exec.cycle", `This execution line would loop (${names.join(" → ")}). Loops need a loop node.`, { cycle: [from.node, ...loop] });
  }
  const id = newId(ctx, "exec", p["id"], (x) => edges.some((e) => e.id === x));
  const edge: ExecEdge = { id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
  const index = (p["index"] as number | undefined) ?? remaining.length;
  putFlow(ctx, { ...flow, execEdges: insertAt(remaining, index, edge) });
  const inverse: Command[] = [{ op: "exec.disconnect", flowId: flow.id, edgeId: id }];
  if (replaced) inverse.push(execConnectCommand(flow.id, replaced, replacedIndex));
  return {
    created: replaced ? { edgeId: id, replacedEdgeId: replaced.id } : { edgeId: id },
    inverse,
    resolved: { ...p, id } as unknown as Command,
    touched: [flow.id],
  };
}

export function execDisconnect(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const edges = lines(ctx, flow);
  const index = edges.findIndex((e) => e.id === p["edgeId"]);
  if (index < 0) {
    fail("command.unknown_ref", `Command exec.disconnect: execution line "${p["edgeId"] as string}" does not exist in flow "${flow.name}".`, { kind: "exec", id: p["edgeId"] });
  }
  const edge = edges[index] as ExecEdge;
  putFlow(ctx, { ...flow, execEdges: edges.filter((_, i) => i !== index) });
  return { inverse: [execConnectCommand(flow.id, edge, index)], resolved: p as unknown as Command, touched: [flow.id] };
}

/** Wires a flow made before execution lines: Input → its execution nodes in data order → Output. No-op when it has lines. */
export function flowExecEnable(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  if (flow.execEdges !== undefined) return { inverse: [], resolved: p as unknown as Command, touched: "none" };
  putFlow(ctx, { ...flow, execEdges: autoExecEdges(ctx.doc, flow.id, ctx.catalog) });
  return { inverse: [{ op: "flow.exec.set", flowId: flow.id, edges: null }], resolved: p as unknown as Command, touched: [flow.id] };
}

/** Replaces all execution lines (`null` = back to a flow without them). Used by undo. */
export function flowExecSet(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const edges = p["edges"] as ExecEdge[] | null;
  const previous = flow.execEdges;
  const next: FlowDocument = { ...flow };
  if (edges === null) delete (next as { execEdges?: readonly ExecEdge[] }).execEdges;
  else next.execEdges = edges.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } }));
  putFlow(ctx, next);
  return {
    inverse: [{ op: "flow.exec.set", flowId: flow.id, edges: previous === undefined ? null : previous.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })) }],
    resolved: p as unknown as Command,
    touched: [flow.id],
  };
}
