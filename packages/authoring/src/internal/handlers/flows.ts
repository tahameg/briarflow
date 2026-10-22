/**
 * Context and flow commands (commands.md §2, §5 without the signature).
 */
import {
  EXEC_IN,
  EXEC_THEN,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  mapNamedIds,
  type FlowDocument,
  type NodeInstance,
  type TypeDecl,
  type TypeRef,
  type Viewport,
} from "@briarflow/core";
import type { Command } from "../../commands.js";
import {
  checkDescription,
  checkFlowName,
  flowIndex,
  getFlow,
  newId,
  putFlow,
  typeIdUsed,
  unknownRef,
  type Ctx,
  type Effect,
  type Payload,
} from "../ctx.js";
import { fail, insertAt, withKey } from "../util.js";
import { configFields, edgeConnectCommand, nodeAddCommand } from "./graph.js";

const resolvedAs = (p: Payload): Command => p as unknown as Command;

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

export function contextRename(ctx: Ctx, p: Payload): Effect {
  const name = p["name"] as string;
  if (name.trim() === "" || name.length > 120) {
    fail("command.invalid_payload", `Command context.rename: name must have 1–120 characters and not be blank.`, { field: "name" });
  }
  const old = ctx.doc.name;
  ctx.doc = { ...ctx.doc, name };
  return { inverse: [{ op: "context.rename", name: old }], resolved: resolvedAs(p), touched: "none" };
}

export function contextSetDescription(ctx: Ctx, p: Payload): Effect {
  checkDescription(ctx, p["description"]);
  const old = ctx.doc.description;
  ctx.doc = withKey(ctx.doc, "description", (p["description"] as string | null) ?? undefined);
  return { inverse: [{ op: "context.setDescription", description: old ?? null }], resolved: resolvedAs(p), touched: "none" };
}

// ---------------------------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------------------------

export function flowCreate(ctx: Ctx, p: Payload): Effect {
  const name = p["name"] as string;
  checkFlowName(ctx, name);
  checkDescription(ctx, p["description"]);
  const id = newId(ctx, "flow", p["id"], (x) => ctx.doc.flows.some((f) => f.id === x));
  const inputNodeId = newId(ctx, "node", p["inputNodeId"], () => false);
  const outputNodeId = newId(ctx, "node", p["outputNodeId"], (x) => x === inputNodeId);
  const flow: FlowDocument = {
    id,
    name,
    types: [],
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [
      { id: inputNodeId, type: FLOW_INPUT_NODE_TYPE, position: { x: 0, y: 0 } },
      { id: outputNodeId, type: FLOW_OUTPUT_NODE_TYPE, position: { x: 640, y: 0 } },
    ],
    edges: [],
    execEdges: [{ id: "x_1", from: { node: inputNodeId, port: EXEC_THEN }, to: { node: outputNodeId, port: EXEC_IN } }],
  };
  if (typeof p["description"] === "string") flow.description = p["description"];
  const index = (p["index"] as number | undefined) ?? ctx.doc.flows.length;
  ctx.doc = { ...ctx.doc, flows: insertAt(ctx.doc.flows, index, flow) };
  return {
    created: { flowId: id, inputNodeId, outputNodeId },
    inverse: [{ op: "flow.delete", flowId: id }],
    resolved: resolvedAs({ ...p, id, inputNodeId, outputNodeId }),
    touched: "none",
  };
}

export function flowRename(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const name = p["name"] as string;
  checkFlowName(ctx, name, flow.id);
  putFlow(ctx, { ...flow, name });
  return { inverse: [{ op: "flow.rename", flowId: flow.id, name: flow.name }], resolved: resolvedAs(p), touched: "none" };
}

export function flowSetDescription(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  checkDescription(ctx, p["description"]);
  putFlow(ctx, withKey(flow, "description", (p["description"] as string | null) ?? undefined));
  return {
    inverse: [{ op: "flow.setDescription", flowId: flow.id, description: flow.description ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function flowSetViewport(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const viewport = p["viewport"] as Viewport;
  if (!(viewport.zoom > 0 && viewport.zoom <= 8)) {
    fail("command.invalid_payload", `Command flow.setViewport: viewport.zoom must be greater than 0 and at most 8.`, { field: "viewport.zoom" });
  }
  putFlow(ctx, { ...flow, ui: { ...(flow.ui ?? {}), viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } } });
  return { inverse: [], resolved: resolvedAs(p), touched: "none" };
}

/** Commands that rebuild `flow` at `index` from nothing (inverse of flow.delete). */
export function recreateFlowCommands(flow: FlowDocument, index: number): Command[] {
  const input = flow.nodes.find((n) => n.type === FLOW_INPUT_NODE_TYPE);
  const output = flow.nodes.find((n) => n.type === FLOW_OUTPUT_NODE_TYPE);
  const out: Payload[] = [];
  const create: Payload = { op: "flow.create", id: flow.id, name: flow.name, index };
  if (input) create["inputNodeId"] = input.id;
  if (output) create["outputNodeId"] = output.id;
  if (flow.description !== undefined) create["description"] = flow.description;
  out.push(create);
  const scope = { kind: "flow", flowId: flow.id };
  for (const t of flow.types) {
    const c: Payload = { op: t.kind === "struct" ? "type.defineStruct" : "type.defineEnum", scope, id: t.id, name: t.name };
    if (t.description !== undefined) c["description"] = t.description;
    if (t.kind === "enum") c["members"] = t.members.map((m) => ({ ...m }));
    out.push(c);
  }
  for (const t of flow.types) {
    if (t.kind !== "struct") continue;
    for (const f of t.fields) out.push(withOptional({ op: "type.field.add", typeId: t.id, name: f.name, type: f.type }, f));
  }
  for (const f of flow.inputs) out.push(withOptional({ op: "flow.input.add", flowId: flow.id, name: f.name, type: f.type }, f));
  for (const f of flow.outputs) {
    const c: Payload = { op: "flow.output.add", flowId: flow.id, name: f.name, type: f.type };
    if (f.description !== undefined) c["description"] = f.description;
    out.push(c);
  }
  for (const v of flow.variables) {
    const c: Payload = { op: "flow.variable.create", flowId: flow.id, id: v.id, name: v.name, type: v.type, access: v.access };
    if (v.default !== undefined) c["default"] = v.default;
    if (v.description !== undefined) c["description"] = v.description;
    out.push(c);
  }
  const builtinDefaults: Record<string, { x: number; y: number }> = {
    [FLOW_INPUT_NODE_TYPE]: { x: 0, y: 0 },
    [FLOW_OUTPUT_NODE_TYPE]: { x: 640, y: 0 },
  };
  const commands = out as unknown as Command[];
  flow.nodes.forEach((n, i) => {
    const def = builtinDefaults[n.type];
    if (!def) {
      commands.push(nodeAddCommand(flow.id, n, i));
      return;
    }
    if (n.position.x !== def.x || n.position.y !== def.y) {
      commands.push({ op: "node.move", flowId: flow.id, nodeId: n.id, position: { ...n.position } });
    }
    if (n.title !== undefined) commands.push({ op: "node.setTitle", flowId: flow.id, nodeId: n.id, title: n.title });
    for (const [port, value] of Object.entries(n.values ?? {})) {
      commands.push({ op: "node.setValue", flowId: flow.id, nodeId: n.id, port, value });
    }
  });
  flow.edges.forEach((e, i) => commands.push(edgeConnectCommand(flow.id, e, i)));
  commands.push({ op: "flow.exec.set", flowId: flow.id, edges: flow.execEdges === undefined ? null : flow.execEdges.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })) });
  if (flow.ui?.viewport) commands.push({ op: "flow.setViewport", flowId: flow.id, viewport: { ...flow.ui.viewport } });
  return commands;
}

function withOptional(c: Payload, f: { description?: string; default?: unknown }): Payload {
  if (f.description !== undefined) c["description"] = f.description;
  if (f.default !== undefined) c["default"] = f.default;
  return c;
}

export function flowDelete(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const index = flowIndex(ctx, flow.id);
  ctx.doc = { ...ctx.doc, flows: ctx.doc.flows.filter((f) => f.id !== flow.id) };
  return { inverse: recreateFlowCommands(flow, index), resolved: resolvedAs(p), touched: "none" };
}

function defaultCopyName(ctx: Ctx, name: string): string {
  const taken = new Set(ctx.doc.flows.map((f) => f.name.toLowerCase()));
  const first = `${name} copy`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const candidate = `${name} copy ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function flowDuplicate(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const name = (p["name"] as string | undefined) ?? defaultCopyName(ctx, flow.name);
  checkFlowName(ctx, name);
  const id = newId(ctx, "flow", p["id"], (x) => ctx.doc.flows.some((f) => f.id === x));
  const given = (p["typeIds"] as Record<string, string> | undefined) ?? {};
  for (const old of Object.keys(given)) {
    if (!flow.types.some((t) => t.id === old)) unknownRef(ctx, "type", old, ` among the local types of flow "${flow.name}"`);
  }
  const typeIds: Record<string, string> = {};
  const assigned = new Set<string>();
  for (const t of flow.types) {
    const next = newId(ctx, "type", given[t.id], (x) => typeIdUsed(ctx.doc, x) || ctx.catalog.getType(x) !== undefined || assigned.has(x));
    assigned.add(next);
    typeIds[t.id] = next;
  }
  const remap = (type: TypeRef): TypeRef => mapNamedIds(type, (x) => typeIds[x] ?? x);
  const remapType = (t: TypeDecl): TypeDecl =>
    t.kind === "struct" ? { ...t, id: typeIds[t.id] ?? t.id, fields: t.fields.map((f) => ({ ...f, type: remap(f.type) })) } : { ...t, id: typeIds[t.id] ?? t.id };
  const remapNode = (n: NodeInstance): NodeInstance => {
    let next = n;
    const fields = configFields(ctx.catalog.get(n.type));
    if (n.config) {
      const config: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n.config)) {
        const kind = fields[k]?.kind;
        if (kind === "typeId" && typeof v === "string") config[k] = typeIds[v] ?? v;
        else if (kind === "type" && typeof v === "object" && v !== null) config[k] = remap(v as TypeRef);
        else config[k] = v;
      }
      next = { ...next, config };
    }
    if (n.typeBindings) {
      const tb: Record<string, TypeRef> = {};
      for (const [k, v] of Object.entries(n.typeBindings)) tb[k] = remap(v);
      next = { ...next, typeBindings: tb };
    }
    return next;
  };
  const copy: FlowDocument = JSON.parse(
    JSON.stringify({
      ...flow,
      id,
      name,
      types: flow.types.map(remapType),
      inputs: flow.inputs.map((f) => ({ ...f, type: remap(f.type) })),
      outputs: flow.outputs.map((f) => ({ ...f, type: remap(f.type) })),
      variables: flow.variables.map((v) => ({ ...v, type: remap(v.type) })),
      nodes: flow.nodes.map(remapNode),
    }),
  ) as FlowDocument;
  ctx.doc = { ...ctx.doc, flows: [...ctx.doc.flows, copy] };
  return {
    created: { flowId: id, typeIds },
    inverse: [{ op: "flow.delete", flowId: id }],
    resolved: resolvedAs({ ...p, id, name, typeIds }),
    touched: [id],
  };
}
