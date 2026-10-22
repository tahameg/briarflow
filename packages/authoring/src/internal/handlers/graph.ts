/**
 * Node and edge commands (commands.md §7, §8).
 */
import {
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  containsVar,
  formatType,
  isAssignable,
  nodeLabel,
  scopeForFlow,
  validateNodeConfig,
  type AnyNodeDefinition,
  type ConfigField,
  type Edge,
  type FlowDocument,
  type NodeInstance,
  type Position,
  type ResolvedNode,
  type TypeRef,
} from "@briarflow/core";
import type { Command, PortRef } from "../../commands.js";
import { checkValue, getFlow, getNode, newId, putFlow, resolveTypeInput, type Ctx, type Effect, type Payload } from "../ctx.js";
import type { PortsOf } from "../normalize.js";
import { fail, insertAt, without, withKey } from "../util.js";

const BUILTINS = [FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE];

export function roundPosition(p: Position): Position {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

export function label(ctx: Ctx, node: NodeInstance): string {
  return nodeLabel(node, ctx.catalog.get(node.type));
}

/** Config fields of a node definition. */
export function configFields(def: AnyNodeDefinition | undefined): Record<string, ConfigField> {
  return (def?.config ?? {}) as Record<string, ConfigField>;
}

/**
 * Converts shorthand in `cfg.type()` fields to IR and validates the config (hard, except
 * `variable.write_to_readonly` under `restore`). Returns the config to store.
 */
function prepareConfig(ctx: Ctx, def: AnyNodeDefinition, flow: FlowDocument, raw: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    checkConfig(ctx, def, flow, undefined);
    return undefined;
  }
  const fields = configFields(def);
  const config: Record<string, unknown> = {};
  const scope = scopeForFlow(ctx.doc, flow.id, ctx.catalog);
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (fields[key]?.kind === "type" && typeof value === "string") {
      config[key] = resolveTypeInput(ctx, value, scope, `${def.type} config.${key}`, `config.${key}`);
    } else config[key] = value;
  }
  checkConfig(ctx, def, flow, config);
  return config;
}

function checkConfig(ctx: Ctx, def: AnyNodeDefinition, flow: FlowDocument, config: Record<string, unknown> | undefined): void {
  const r = validateNodeConfig(def, config, ctx.doc, flow.id, ctx.catalog);
  if (r.ok) return;
  const problems = r.diagnostics.filter((d) => !(ctx.restore && d.code === "variable.write_to_readonly"));
  const first = problems[0];
  if (first) fail(first.code, first.message, { diagnostics: problems, ...(first.path.field ? { field: first.path.field } : {}) });
}

function portList(ports: readonly { name: string }[]): string {
  return ports.length === 0 ? "none" : ports.map((p) => p.name).join(", ");
}

/** Validates a constant for an input port (hard unless restore). */
function checkConstant(ctx: Ctx, flow: FlowDocument, node: NodeInstance, resolved: ResolvedNode, port: string, value: unknown): void {
  const p = resolved.inputs.find((x) => x.name === port);
  if (!p) {
    fail("node.unknown_port", `${label(ctx, node)} has no input "${port}". Inputs: ${portList(resolved.inputs)}.`, { nodeId: node.id, port });
  }
  if (ctx.restore) return;
  if (containsVar(p.type)) {
    fail(
      "value.generic_unbound",
      `Cannot set a constant on "${port}" of ${label(ctx, node)} before its type is known. Connect an input first.`,
      { nodeId: node.id, port },
    );
  }
  checkValue(ctx, value, p.type, scopeForFlow(ctx.doc, flow.id, ctx.catalog), `nodes.${node.id}.values.${port}`);
}

function resolvedNode(ctx: Ctx, ports: PortsOf, flowId: string, nodeId: string): ResolvedNode {
  const r = ports(ctx.doc, flowId).nodes.get(nodeId);
  if (!r) throw new Error(`internal: node ${nodeId} not resolved`);
  return r;
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

export function nodeAdd(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const type = p["type"] as string;
  if (BUILTINS.includes(type)) {
    fail("node.builtin_singleton", `Every flow has exactly one ${type} node; it is created with the flow.`, { type });
  }
  const def = ctx.catalog.get(type);
  if (!def) {
    const packs = ctx.catalog.packs.map((x) => x.name);
    fail("node.unknown_type", `Unknown node type "${type}". Is its pack loaded? Known packs: ${packs.length ? packs.join(", ") : "none"}.`, { type });
  }
  const id = newId(ctx, "node", p["id"], (x) => flow.nodes.some((n) => n.id === x));
  const config = prepareConfig(ctx, def, flow, p["config"] as Record<string, unknown> | undefined);
  const title = p["title"] as string | undefined;
  checkTitle(ctx, title);
  let node: NodeInstance = { id, type, position: roundPosition(p["position"] as Position) };
  if (title !== undefined && title !== "") node.title = title;
  if (config !== undefined) node.config = config;
  const values = p["values"] as Record<string, unknown> | undefined;
  const index = (p["index"] as number | undefined) ?? flow.nodes.length;
  putFlow(ctx, { ...flow, nodes: insertAt(flow.nodes, index, node) });
  if (values !== undefined) {
    const resolved = resolvedNode(ctx, ports, flow.id, id);
    const stored: Record<string, unknown> = {};
    for (const [port, value] of Object.entries(values)) {
      if (value === undefined) continue;
      checkConstant(ctx, flow, node, resolved, port, value);
      stored[port] = value;
    }
    if (Object.keys(stored).length > 0) {
      node = { ...node, values: stored };
      const f = getFlow(ctx, flow.id);
      putFlow(ctx, { ...f, nodes: f.nodes.map((n) => (n.id === id ? node : n)) });
    }
  }
  const resolvedCmd = { ...p, id } as Payload;
  if (config !== undefined) resolvedCmd["config"] = config;
  return {
    created: { nodeId: id },
    inverse: [{ op: "node.remove", flowId: flow.id, nodeId: id }],
    resolved: resolvedCmd as unknown as Command,
    touched: [flow.id],
  };
}

function checkTitle(ctx: Ctx, title: string | null | undefined): void {
  if (typeof title === "string" && title.length > 80) {
    fail("command.invalid_payload", `Command ${ctx.op}: title must be at most 80 characters.`, { field: "title" });
  }
}

/** `node.add` command that recreates `node` (restore). */
export function nodeAddCommand(flowId: string, node: NodeInstance, index: number): Command {
  const cmd: Payload = { op: "node.add", flowId, id: node.id, type: node.type, position: { ...node.position }, index };
  if (node.title !== undefined) cmd["title"] = node.title;
  if (node.config !== undefined) cmd["config"] = node.config;
  if (node.values !== undefined) cmd["values"] = node.values;
  return cmd as unknown as Command;
}

/** `edge.connect` command that recreates `edge` at `index` (restore). */
export function edgeConnectCommand(flowId: string, edge: Edge, index: number): Command {
  return { op: "edge.connect", flowId, id: edge.id, from: { ...edge.from }, to: { ...edge.to }, index };
}

/**
 * Removes nodes (and their attached edges) from a flow. Returns the inverse: nodes re-added in
 * ascending original index, then edges in ascending original index.
 */
export function removeNodes(ctx: Ctx, flowId: string, nodeIds: ReadonlySet<string>): Command[] {
  const flow = getFlow(ctx, flowId);
  const inverse: Command[] = [];
  flow.nodes.forEach((n, i) => {
    if (nodeIds.has(n.id)) inverse.push(nodeAddCommand(flowId, n, i));
  });
  flow.edges.forEach((e, i) => {
    if (nodeIds.has(e.from.node) || nodeIds.has(e.to.node)) inverse.push(edgeConnectCommand(flowId, e, i));
  });
  const touches = (e: { from: { node: string }; to: { node: string } }) => nodeIds.has(e.from.node) || nodeIds.has(e.to.node);
  flow.execEdges?.forEach((e, i) => {
    if (touches(e)) inverse.push({ op: "exec.connect", flowId, id: e.id, from: { ...e.from }, to: { ...e.to }, index: i });
  });
  const next: FlowDocument = {
    ...flow,
    nodes: flow.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: flow.edges.filter((e) => !nodeIds.has(e.from.node) && !nodeIds.has(e.to.node)),
  };
  if (flow.execEdges !== undefined) next.execEdges = flow.execEdges.filter((e) => !touches(e));
  putFlow(ctx, next);
  return inverse;
}

export function nodeRemove(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  if (BUILTINS.includes(node.type)) {
    const which = node.type === FLOW_INPUT_NODE_TYPE ? "Input" : "Output";
    fail("node.builtin_protected", `The flow's ${which} node cannot be removed. Edit the signature instead.`, { nodeId: node.id });
  }
  const inverse = removeNodes(ctx, flow.id, new Set([node.id]));
  return { inverse, resolved: p as unknown as Command, touched: [flow.id] };
}

export function nodeMove(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  const position = roundPosition(p["position"] as Position);
  putFlow(ctx, { ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, position } : n)) });
  return {
    inverse: [{ op: "node.move", flowId: flow.id, nodeId: node.id, position: { ...node.position } }],
    resolved: p as unknown as Command,
    touched: "none",
  };
}

export function nodeSetTitle(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  const title = p["title"] as string | null;
  checkTitle(ctx, title);
  const next = withKey(node, "title", title === null || title === "" ? undefined : title);
  putFlow(ctx, { ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? next : n)) });
  return {
    inverse: [{ op: "node.setTitle", flowId: flow.id, nodeId: node.id, title: node.title ?? null }],
    resolved: p as unknown as Command,
    touched: "none",
  };
}

export function nodeSetValue(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  const port = p["port"] as string;
  checkConstant(ctx, flow, node, resolvedNode(ctx, ports, flow.id, node.id), port, p["value"]);
  const old = node.values?.[port];
  const next = { ...node, values: { ...(node.values ?? {}), [port]: p["value"] } };
  putFlow(ctx, { ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? next : n)) });
  const inverse: Command =
    old === undefined
      ? { op: "node.clearValue", flowId: flow.id, nodeId: node.id, port }
      : { op: "node.setValue", flowId: flow.id, nodeId: node.id, port, value: old };
  return { inverse: [inverse], resolved: p as unknown as Command, touched: "none" };
}

export function nodeClearValue(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  const port = p["port"] as string;
  const old = node.values?.[port];
  if (old === undefined) return { inverse: [], resolved: p as unknown as Command, touched: "none" };
  const values = without({ ...(node.values ?? {}) }, port);
  const next = Object.keys(values).length === 0 ? without(node, "values") : { ...node, values };
  putFlow(ctx, { ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? next : n)) });
  return {
    inverse: [{ op: "node.setValue", flowId: flow.id, nodeId: node.id, port, value: old }],
    resolved: p as unknown as Command,
    touched: "none",
  };
}

export function nodeSetConfig(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const node = getNode(ctx, flow, p["nodeId"] as string);
  if (BUILTINS.includes(node.type)) {
    fail("node.builtin_protected", `The flow's ${node.type === FLOW_INPUT_NODE_TYPE ? "Input" : "Output"} node has no config. Edit the signature instead.`, {
      nodeId: node.id,
    });
  }
  const def = ctx.catalog.get(node.type);
  if (!def) {
    const packs = ctx.catalog.packs.map((x) => x.name);
    fail("node.unknown_type", `Unknown node type "${node.type}". Is its pack loaded? Known packs: ${packs.length ? packs.join(", ") : "none"}.`, {
      type: node.type,
    });
  }
  const config = prepareConfig(ctx, def, flow, p["config"] as Record<string, unknown>) ?? {};
  let next = without(node, "typeBindings");
  next = Object.keys(config).length === 0 ? without(next, "config") : { ...next, config };
  putFlow(ctx, { ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? next : n)) });
  return {
    inverse: [{ op: "node.setConfig", flowId: flow.id, nodeId: node.id, config: node.config ?? {} }],
    resolved: { ...p, config } as unknown as Command,
    touched: [flow.id],
  };
}

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

function mismatchHint(from: TypeRef, to: TypeRef): string {
  const target = to.kind === "optional" ? to.of : to;
  if (from.kind === "list" && isAssignable(from.of, to)) return " Use list.get to pick one item.";
  if (target.kind === "primitive" && target.name === "text") return " Use convert.toText to turn it into text.";
  return "";
}

/** Path from `start` to `goal` following data edges, or undefined. */
function findPath(edges: readonly Edge[], start: string, goal: string): string[] | undefined {
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === goal) {
      const path = [goal];
      let cur = goal;
      while (cur !== start) {
        cur = prev.get(cur) as string;
        path.unshift(cur);
      }
      return path;
    }
    for (const e of edges) {
      if (e.from.node !== id || seen.has(e.to.node)) continue;
      seen.add(e.to.node);
      prev.set(e.to.node, id);
      queue.push(e.to.node);
    }
  }
  return undefined;
}

export function edgeConnect(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const from = p["from"] as PortRef;
  const to = p["to"] as PortRef;
  const fromNode = getNode(ctx, flow, from.node);
  const toNode = getNode(ctx, flow, to.node);
  const before = ports(ctx.doc, flow.id);
  const fr = before.nodes.get(fromNode.id) as ResolvedNode;
  const tr = before.nodes.get(toNode.id) as ResolvedNode;
  checkEnd(ctx, fromNode, fr, from.port, "outputs");
  checkEnd(ctx, toNode, tr, to.port, "inputs");
  if (from.node === to.node) fail("edge.self_loop", "A node cannot be connected to itself.", { nodeId: from.node });

  const same = flow.edges.find((e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to.node && e.to.port === to.port);
  if (same) return { created: { edgeId: same.id }, inverse: [], resolved: { ...p, id: same.id } as unknown as Command, touched: "none" };

  const replacedIndex = flow.edges.findIndex((e) => e.to.node === to.node && e.to.port === to.port);
  const replaced = replacedIndex >= 0 ? (flow.edges[replacedIndex] as Edge) : undefined;
  const remaining = flow.edges.filter((_, i) => i !== replacedIndex);
  const loop = findPath(remaining, to.node, from.node);
  if (loop) {
    const labels = loop.map((id) => label(ctx, flow.nodes.find((n) => n.id === id) as NodeInstance));
    fail(
      "edge.cycle",
      `Connecting ${label(ctx, fromNode)}.${from.port} to ${label(ctx, toNode)}.${to.port} would create a loop (${[label(ctx, fromNode), ...labels].join(" → ")}). Flows must not contain loops.`,
      { cycle: [from.node, ...loop] },
    );
  }
  const id = newId(ctx, "edge", p["id"], (x) => flow.edges.some((e) => e.id === x));
  const edge: Edge = { id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } };
  const index = (p["index"] as number | undefined) ?? remaining.length;
  putFlow(ctx, { ...flow, edges: insertAt(remaining, index, edge) });

  if (!ctx.restore) {
    const after = ports(ctx.doc, flow.id);
    for (const nodeId of [from.node, to.node]) {
      const known = new Set((before.nodes.get(nodeId)?.diagnostics ?? []).filter((d) => d.code === "node.generic_conflict").map((d) => d.message));
      const conflict = after.nodes.get(nodeId)?.diagnostics.find((d) => d.code === "node.generic_conflict" && !known.has(d.message));
      if (conflict) fail("edge.generic_conflict", conflict.message, { ...(conflict.details as Record<string, unknown>), nodeId });
    }
    const fp = after.nodes.get(from.node)?.outputs.find((x) => x.name === from.port);
    const tp = after.nodes.get(to.node)?.inputs.find((x) => x.name === to.port);
    if (fp && tp && !containsVar(fp.type) && !containsVar(tp.type) && !isAssignable(fp.type, tp.type)) {
      const scope = scopeForFlow(ctx.doc, flow.id, ctx.catalog);
      fail(
        "edge.type_mismatch",
        `Cannot connect ${label(ctx, fromNode)}.${fp.name} (${formatType(fp.type, scope)}) to ${label(ctx, toNode)}.${tp.name} (${formatType(tp.type, scope)}).${mismatchHint(fp.type, tp.type)}`,
        { from: fp.type, to: tp.type },
      );
    }
  }
  const inverse: Command[] = [{ op: "edge.disconnect", flowId: flow.id, edgeId: id }];
  if (replaced) inverse.push(edgeConnectCommand(flow.id, replaced, replacedIndex));
  return {
    created: replaced ? { edgeId: id, replacedEdgeId: replaced.id } : { edgeId: id },
    inverse,
    resolved: { ...p, id } as unknown as Command,
    touched: [flow.id],
  };
}

function checkEnd(ctx: Ctx, node: NodeInstance, r: ResolvedNode, port: string, side: "inputs" | "outputs"): void {
  if (r[side].some((x) => x.name === port)) return;
  const other = side === "inputs" ? "outputs" : "inputs";
  if (r[other].some((x) => x.name === port)) {
    fail(
      "edge.wrong_direction",
      `Edges go from an output to an input; "${port}" of ${label(ctx, node)} is an ${side === "inputs" ? "output" : "input"}.`,
      { nodeId: node.id, port },
    );
  }
  const kind = side === "inputs" ? "input" : "output";
  const list = side === "inputs" ? "Inputs" : "Outputs";
  fail("edge.unknown_port", `${label(ctx, node)} has no ${kind} "${port}". ${list}: ${portList(r[side])}.`, { nodeId: node.id, port });
}

export function edgeDisconnect(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  let index: number;
  if (p["edgeId"] !== undefined) {
    index = flow.edges.findIndex((e) => e.id === p["edgeId"]);
    if (index < 0) fail("command.unknown_ref", `Command edge.disconnect: edge "${p["edgeId"] as string}" does not exist in flow "${flow.name}".`, { kind: "edge", id: p["edgeId"] });
  } else {
    const to = p["to"] as PortRef;
    index = flow.edges.findIndex((e) => e.to.node === to.node && e.to.port === to.port);
    if (index < 0) {
      fail("command.unknown_ref", `Command edge.disconnect: no edge goes into "${to.node}.${to.port}" in flow "${flow.name}".`, {
        kind: "edge",
        id: `${to.node}.${to.port}`,
      });
    }
  }
  const edge = flow.edges[index] as Edge;
  putFlow(ctx, { ...flow, edges: flow.edges.filter((_, i) => i !== index) });
  return { inverse: [edgeConnectCommand(flow.id, edge, index)], resolved: p as unknown as Command, touched: [flow.id] };
}
