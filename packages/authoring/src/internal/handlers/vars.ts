/**
 * Globals (§4), flow variables (§6) and the flow signature (§5).
 */
import {
  scopeForContext,
  scopeForFlow,
  type FieldDecl,
  type FlowDocument,
  type FlowVariable,
  type GlobalVariable,
  type TypeRef,
} from "@briarflow/core";
import type { Command } from "../../commands.js";
import {
  checkDescription,
  checkFieldName,
  checkGlobalVisibility,
  checkValue,
  getFlow,
  localTypesIn,
  newId,
  putFlow,
  resolveTypeInput,
  type Ctx,
  type Effect,
  type Payload,
} from "../ctx.js";
import { followPortRename, type PortsOf } from "../normalize.js";
import { clamp, fail, insertAt, moveTo, removeAt, withKey } from "../util.js";
import { configFields, label, removeNodes } from "./graph.js";

const resolvedAs = (p: Payload): Command => p as unknown as Command;

/** Nodes (per flow) whose config points at a global / flow variable. */
function nodesUsing(ctx: Ctx, kind: "global" | "flowVariable", id: string, onlyFlow?: string): { flowId: string; nodeId: string; label: string }[] {
  const out: { flowId: string; nodeId: string; label: string }[] = [];
  for (const flow of ctx.doc.flows) {
    if (onlyFlow !== undefined && flow.id !== onlyFlow) continue;
    for (const n of flow.nodes) {
      const def = ctx.catalog.get(n.type);
      const fields = configFields(def);
      const keys = def ? Object.keys(fields).filter((k) => fields[k]?.kind === kind) : [kind === "global" ? "globalId" : "variableId"];
      if (keys.some((k) => n.config?.[k] === id)) out.push({ flowId: flow.id, nodeId: n.id, label: label(ctx, n) });
    }
  }
  return out;
}

function cascadeRemove(ctx: Ctx, users: { flowId: string; nodeId: string }[]): Command[] {
  const inverse: Command[] = [];
  const byFlow = new Map<string, Set<string>>();
  for (const u of users) {
    const set = byFlow.get(u.flowId) ?? new Set<string>();
    set.add(u.nodeId);
    byFlow.set(u.flowId, set);
  }
  for (const [flowId, ids] of byFlow) inverse.push(...removeNodes(ctx, flowId, ids));
  return inverse;
}

function inUseMessage(what: string, users: { label: string }[]): string {
  const n = users.length;
  const first = users
    .slice(0, 3)
    .map((u) => u.label)
    .join(", ");
  return `${what} is used by ${n} node${n === 1 ? "" : "s"} (${first}${n > 3 ? ", …" : ""}). Remove those nodes first, or delete with cascade to remove them too.`;
}

// ---------------------------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------------------------

function getGlobal(ctx: Ctx, id: string): { g: GlobalVariable; index: number } {
  const index = ctx.doc.globals.findIndex((g) => g.id === id);
  if (index < 0) fail("command.unknown_ref", `Command ${ctx.op}: global "${id}" does not exist in context "${ctx.doc.name}".`, { kind: "global", id });
  return { g: ctx.doc.globals[index] as GlobalVariable, index };
}

function putGlobal(ctx: Ctx, index: number, g: GlobalVariable): void {
  ctx.doc = { ...ctx.doc, globals: ctx.doc.globals.map((x, i) => (i === index ? g : x)) };
}

function readonlyNeedsValue(name: string): never {
  return fail("global.readonly_requires_value", `Readonly global "${name}" needs a value. Set a value or make it readwrite.`, { name });
}

function globalType(ctx: Ctx, input: unknown, name: string): TypeRef {
  const type = resolveTypeInput(ctx, input, scopeForContext(ctx.doc, ctx.catalog), `global "${name}"`, "type");
  checkGlobalVisibility(ctx, type, `Global "${name}"`);
  return type;
}

function checkGlobalValue(ctx: Ctx, g: { name: string; type: TypeRef }, value: unknown): void {
  checkValue(ctx, value, g.type, scopeForContext(ctx.doc, ctx.catalog), `globals.${g.name}`);
}

export function globalCreate(ctx: Ctx, p: Payload): Effect {
  const name = p["name"] as string;
  checkFieldName(
    name,
    "global",
    ctx.doc.globals.map((g) => g.name),
    `context "${ctx.doc.name}"`,
  );
  checkDescription(ctx, p["description"]);
  const id = newId(ctx, "global", p["id"], (x) => ctx.doc.globals.some((g) => g.id === x));
  const type = globalType(ctx, p["type"], name);
  const access = p["access"] as GlobalVariable["access"];
  if (access === "readonly" && p["value"] === undefined) readonlyNeedsValue(name);
  const g: GlobalVariable = { id, name, type, access };
  if (p["value"] !== undefined) {
    checkGlobalValue(ctx, g, p["value"]);
    g.value = p["value"];
  }
  if (typeof p["description"] === "string") g.description = p["description"];
  ctx.doc = { ...ctx.doc, globals: insertAt(ctx.doc.globals, (p["index"] as number | undefined) ?? ctx.doc.globals.length, g) };
  return {
    created: { globalId: id },
    inverse: [{ op: "global.delete", globalId: id }],
    resolved: resolvedAs({ ...p, id, type }),
    touched: "none",
  };
}

export function globalRename(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  const name = p["name"] as string;
  checkFieldName(
    name,
    "global",
    ctx.doc.globals.map((x) => x.name),
    `context "${ctx.doc.name}"`,
    g.name,
  );
  putGlobal(ctx, index, { ...g, name });
  return { inverse: [{ op: "global.rename", globalId: g.id, name: g.name }], resolved: resolvedAs(p), touched: "none" };
}

export function globalSetType(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  const type = globalType(ctx, p["type"], g.name);
  putGlobal(ctx, index, { ...g, type });
  return { inverse: [{ op: "global.setType", globalId: g.id, type: g.type }], resolved: resolvedAs({ ...p, type }), touched: "all" };
}

export function globalSetAccess(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  const access = p["access"] as GlobalVariable["access"];
  if (access === "readonly" && g.value === undefined) readonlyNeedsValue(g.name);
  putGlobal(ctx, index, { ...g, access });
  return { inverse: [{ op: "global.setAccess", globalId: g.id, access: g.access }], resolved: resolvedAs(p), touched: "none" };
}

export function globalSetValue(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  checkGlobalValue(ctx, g, p["value"]);
  putGlobal(ctx, index, { ...g, value: p["value"] });
  const inverse: Command =
    g.value === undefined ? { op: "global.clearValue", globalId: g.id } : { op: "global.setValue", globalId: g.id, value: g.value };
  return { inverse: [inverse], resolved: resolvedAs(p), touched: "none" };
}

export function globalClearValue(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  if (g.access === "readonly") readonlyNeedsValue(g.name);
  if (g.value === undefined) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putGlobal(ctx, index, withKey(g, "value", undefined));
  return { inverse: [{ op: "global.setValue", globalId: g.id, value: g.value }], resolved: resolvedAs(p), touched: "none" };
}

export function globalSetDescription(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  checkDescription(ctx, p["description"]);
  putGlobal(ctx, index, withKey(g, "description", (p["description"] as string | null) ?? undefined));
  return {
    inverse: [{ op: "global.setDescription", globalId: g.id, description: g.description ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function globalDelete(ctx: Ctx, p: Payload): Effect {
  const { g, index } = getGlobal(ctx, p["globalId"] as string);
  const users = nodesUsing(ctx, "global", g.id);
  if (users.length > 0 && p["cascade"] !== true) {
    fail("global.in_use", inUseMessage(`Global "${g.name}"`, users), { nodes: users.map((u) => ({ flowId: u.flowId, nodeId: u.nodeId })) });
  }
  const nodeInverse = cascadeRemove(ctx, users);
  ctx.doc = { ...ctx.doc, globals: removeAt(ctx.doc.globals, index) };
  const create: Payload = { op: "global.create", id: g.id, name: g.name, type: g.type, access: g.access, index };
  if (g.value !== undefined) create["value"] = g.value;
  if (g.description !== undefined) create["description"] = g.description;
  return { inverse: [create as unknown as Command, ...nodeInverse], resolved: resolvedAs(p), touched: "none" };
}

// ---------------------------------------------------------------------------------------------
// Flow variables
// ---------------------------------------------------------------------------------------------

function getVariable(ctx: Ctx, p: Payload): { flow: FlowDocument; v: FlowVariable; index: number } {
  const flow = getFlow(ctx, p["flowId"] as string);
  const id = p["variableId"] as string;
  const index = flow.variables.findIndex((v) => v.id === id);
  if (index < 0) fail("command.unknown_ref", `Command ${ctx.op}: variable "${id}" does not exist in flow "${flow.name}".`, { kind: "variable", id });
  return { flow, v: flow.variables[index] as FlowVariable, index };
}

function putVariable(ctx: Ctx, flow: FlowDocument, index: number, v: FlowVariable): void {
  putFlow(ctx, { ...getFlow(ctx, flow.id), variables: flow.variables.map((x, i) => (i === index ? v : x)) });
}

function checkPublicVariable(ctx: Ctx, flow: FlowDocument, v: { name: string; type: TypeRef; access: string }): void {
  if (ctx.restore || v.access !== "public") return;
  const [local] = localTypesIn(flow, v.type);
  if (local) {
    fail(
      "visibility.local_type_in_public_variable",
      `Public variable "${v.name}" uses local type "${local.name}". Make the variable private or move the type to global.`,
      { id: local.id },
    );
  }
}

function checkVariableDefault(ctx: Ctx, flow: FlowDocument, v: { name: string; type: TypeRef }, value: unknown): void {
  checkValue(ctx, value, v.type, scopeForFlow(ctx.doc, flow.id, ctx.catalog), `variables.${v.name}`);
}

export function variableCreate(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const name = p["name"] as string;
  checkFieldName(
    name,
    "variable",
    flow.variables.map((v) => v.name),
    `flow "${flow.name}"`,
  );
  checkDescription(ctx, p["description"]);
  const id = newId(ctx, "variable", p["id"], (x) => flow.variables.some((v) => v.id === x));
  const type = resolveTypeInput(ctx, p["type"], scopeForFlow(ctx.doc, flow.id, ctx.catalog), `variable "${name}"`, "type");
  const v: FlowVariable = { id, name, type, access: p["access"] as FlowVariable["access"] };
  checkPublicVariable(ctx, flow, v);
  if (p["default"] !== undefined) {
    checkVariableDefault(ctx, flow, v, p["default"]);
    v.default = p["default"];
  }
  if (typeof p["description"] === "string") v.description = p["description"];
  putFlow(ctx, { ...flow, variables: insertAt(flow.variables, (p["index"] as number | undefined) ?? flow.variables.length, v) });
  return {
    created: { variableId: id },
    inverse: [{ op: "flow.variable.delete", flowId: flow.id, variableId: id }],
    resolved: resolvedAs({ ...p, id, type }),
    touched: "none",
  };
}

export function variableRename(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  const name = p["name"] as string;
  checkFieldName(
    name,
    "variable",
    flow.variables.map((x) => x.name),
    `flow "${flow.name}"`,
    v.name,
  );
  putVariable(ctx, flow, index, { ...v, name });
  return { inverse: [{ op: "flow.variable.rename", flowId: flow.id, variableId: v.id, name: v.name }], resolved: resolvedAs(p), touched: "none" };
}

export function variableSetType(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  const type = resolveTypeInput(ctx, p["type"], scopeForFlow(ctx.doc, flow.id, ctx.catalog), `variable "${v.name}"`, "type");
  checkPublicVariable(ctx, flow, { ...v, type });
  putVariable(ctx, flow, index, { ...v, type });
  return {
    inverse: [{ op: "flow.variable.setType", flowId: flow.id, variableId: v.id, type: v.type }],
    resolved: resolvedAs({ ...p, type }),
    touched: [flow.id],
  };
}

export function variableSetAccess(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  const access = p["access"] as FlowVariable["access"];
  checkPublicVariable(ctx, flow, { ...v, access });
  putVariable(ctx, flow, index, { ...v, access });
  return { inverse: [{ op: "flow.variable.setAccess", flowId: flow.id, variableId: v.id, access: v.access }], resolved: resolvedAs(p), touched: "none" };
}

export function variableSetDefault(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  checkVariableDefault(ctx, flow, v, p["value"]);
  putVariable(ctx, flow, index, { ...v, default: p["value"] });
  const inverse: Command =
    v.default === undefined
      ? { op: "flow.variable.clearDefault", flowId: flow.id, variableId: v.id }
      : { op: "flow.variable.setDefault", flowId: flow.id, variableId: v.id, value: v.default };
  return { inverse: [inverse], resolved: resolvedAs(p), touched: "none" };
}

export function variableClearDefault(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  if (v.default === undefined) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putVariable(ctx, flow, index, withKey(v, "default", undefined));
  return { inverse: [{ op: "flow.variable.setDefault", flowId: flow.id, variableId: v.id, value: v.default }], resolved: resolvedAs(p), touched: "none" };
}

export function variableSetDescription(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  checkDescription(ctx, p["description"]);
  putVariable(ctx, flow, index, withKey(v, "description", (p["description"] as string | null) ?? undefined));
  return {
    inverse: [{ op: "flow.variable.setDescription", flowId: flow.id, variableId: v.id, description: v.description ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function variableDelete(ctx: Ctx, p: Payload): Effect {
  const { flow, v, index } = getVariable(ctx, p);
  const users = nodesUsing(ctx, "flowVariable", v.id, flow.id);
  if (users.length > 0 && p["cascade"] !== true) {
    fail("variable.in_use", inUseMessage(`Variable "${v.name}"`, users), { nodes: users.map((u) => ({ flowId: u.flowId, nodeId: u.nodeId })) });
  }
  const nodeInverse = cascadeRemove(ctx, users);
  const current = getFlow(ctx, flow.id);
  putFlow(ctx, { ...current, variables: removeAt(current.variables, index) });
  const create: Payload = { op: "flow.variable.create", flowId: flow.id, id: v.id, name: v.name, type: v.type, access: v.access, index };
  if (v.default !== undefined) create["default"] = v.default;
  if (v.description !== undefined) create["description"] = v.description;
  return { inverse: [create as unknown as Command, ...nodeInverse], resolved: resolvedAs(p), touched: "none" };
}

// ---------------------------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------------------------

type Side = "inputs" | "outputs";
const sideOf = (op: string): Side => (op.startsWith("flow.input.") ? "inputs" : "outputs");
const kindOf = (side: Side) => (side === "inputs" ? "input" : "output");

function getSigField(ctx: Ctx, p: Payload): { flow: FlowDocument; side: Side; field: FieldDecl; index: number } {
  const flow = getFlow(ctx, p["flowId"] as string);
  const side = sideOf(ctx.op);
  const name = p["name"] as string;
  const index = flow[side].findIndex((f) => f.name === name);
  if (index < 0) {
    fail("command.unknown_ref", `Command ${ctx.op}: flow ${kindOf(side)} "${name}" does not exist in flow "${flow.name}".`, { kind: kindOf(side), id: name });
  }
  return { flow, side, field: flow[side][index] as FieldDecl, index };
}

function putSig(ctx: Ctx, flowId: string, side: Side, fields: readonly FieldDecl[]): void {
  putFlow(ctx, { ...getFlow(ctx, flowId), [side]: fields });
}

function sigType(ctx: Ctx, flow: FlowDocument, side: Side, name: string, input: unknown): TypeRef {
  const type = resolveTypeInput(ctx, input, scopeForFlow(ctx.doc, flow.id, ctx.catalog), `flow ${kindOf(side)} "${name}"`, "type");
  if (!ctx.restore) {
    const [local] = localTypesIn(flow, type);
    if (local) {
      fail(
        "visibility.local_type_in_public_signature",
        `Flow ${kindOf(side)} "${name}" uses local type "${local.name}". Public signatures can only use primitives, global types and pack types. Move "${local.name}" to global types.`,
        { id: local.id, flowId: flow.id },
      );
    }
  }
  return type;
}

function checkSigDefault(ctx: Ctx, flow: FlowDocument, field: FieldDecl): void {
  if (field.default === undefined) return;
  checkValue(ctx, field.default, field.type, scopeForFlow(ctx.doc, flow.id, ctx.catalog), `inputs.${field.name}`, {
    defaultOf: `flow input "${field.name}"`,
  });
}

export function sigAdd(ctx: Ctx, p: Payload): Effect {
  const flow = getFlow(ctx, p["flowId"] as string);
  const side = sideOf(ctx.op);
  const name = p["name"] as string;
  checkFieldName(
    name,
    `flow ${kindOf(side)}`,
    flow[side].map((f) => f.name),
    `flow "${flow.name}"`,
  );
  checkDescription(ctx, p["description"]);
  const field: FieldDecl = { name, type: sigType(ctx, flow, side, name, p["type"]) };
  if (typeof p["description"] === "string") field.description = p["description"];
  if (p["default"] !== undefined) field.default = p["default"];
  checkSigDefault(ctx, flow, field);
  const list = flow[side];
  putSig(ctx, flow.id, side, insertAt(list, clamp((p["index"] as number | undefined) ?? list.length, 0, list.length), field));
  return {
    inverse: [{ op: `flow.${kindOf(side)}.remove`, flowId: flow.id, name } as Command],
    resolved: resolvedAs({ ...p, type: field.type }),
    touched: [flow.id],
  };
}

export function sigRemove(ctx: Ctx, p: Payload): Effect {
  const { flow, side, field, index } = getSigField(ctx, p);
  putSig(ctx, flow.id, side, removeAt(flow[side], index));
  const inv: Payload = { op: `flow.${kindOf(side)}.add`, flowId: flow.id, name: field.name, type: field.type, index };
  if (field.description !== undefined) inv["description"] = field.description;
  if (field.default !== undefined) inv["default"] = field.default;
  return { inverse: [inv as unknown as Command], resolved: resolvedAs(p), touched: [flow.id] };
}

export function sigRename(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const { flow, side, field, index } = getSigField(ctx, p);
  const newName = p["newName"] as string;
  if (newName === field.name) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  checkFieldName(
    newName,
    `flow ${kindOf(side)}`,
    flow[side].map((f) => f.name),
    `flow "${flow.name}"`,
    field.name,
  );
  const before = ctx.doc;
  putSig(
    ctx,
    flow.id,
    side,
    flow[side].map((f, i) => (i === index ? { ...f, name: newName } : f)),
  );
  ctx.doc = followPortRename(before, ctx.doc, [flow.id], ports, field.name, newName);
  return {
    inverse: [{ op: `flow.${kindOf(side)}.rename`, flowId: flow.id, name: newName, newName: field.name } as Command],
    resolved: resolvedAs(p),
    touched: [flow.id],
  };
}

export function sigSetType(ctx: Ctx, p: Payload): Effect {
  const { flow, side, field, index } = getSigField(ctx, p);
  const type = sigType(ctx, flow, side, field.name, p["type"]);
  putSig(
    ctx,
    flow.id,
    side,
    flow[side].map((f, i) => (i === index ? { ...f, type } : f)),
  );
  return {
    inverse: [{ op: `flow.${kindOf(side)}.setType`, flowId: flow.id, name: field.name, type: field.type } as Command],
    resolved: resolvedAs({ ...p, type }),
    touched: [flow.id],
  };
}

export function sigReorder(ctx: Ctx, p: Payload): Effect {
  const { flow, side, field, index } = getSigField(ctx, p);
  const to = clamp(p["index"] as number, 0, flow[side].length - 1);
  putSig(ctx, flow.id, side, moveTo(flow[side], index, to));
  return {
    inverse: [{ op: `flow.${kindOf(side)}.reorder`, flowId: flow.id, name: field.name, index } as Command],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function sigSetDescription(ctx: Ctx, p: Payload): Effect {
  const { flow, side, field, index } = getSigField(ctx, p);
  checkDescription(ctx, p["description"]);
  putSig(
    ctx,
    flow.id,
    side,
    flow[side].map((f, i) => (i === index ? withKey(f, "description", (p["description"] as string | null) ?? undefined) : f)),
  );
  return {
    inverse: [{ op: `flow.${kindOf(side)}.setDescription`, flowId: flow.id, name: field.name, description: field.description ?? null } as Command],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function inputSetDefault(ctx: Ctx, p: Payload): Effect {
  const { flow, field, index } = getSigField(ctx, p);
  const next = { ...field, default: p["value"] };
  checkSigDefault(ctx, flow, next);
  putSig(
    ctx,
    flow.id,
    "inputs",
    flow.inputs.map((f, i) => (i === index ? next : f)),
  );
  const inverse: Command =
    field.default === undefined
      ? { op: "flow.input.clearDefault", flowId: flow.id, name: field.name }
      : { op: "flow.input.setDefault", flowId: flow.id, name: field.name, value: field.default };
  return { inverse: [inverse], resolved: resolvedAs(p), touched: "none" };
}

export function inputClearDefault(ctx: Ctx, p: Payload): Effect {
  const { flow, field, index } = getSigField(ctx, p);
  if (field.default === undefined) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putSig(
    ctx,
    flow.id,
    "inputs",
    flow.inputs.map((f, i) => (i === index ? withKey(f, "default", undefined) : f)),
  );
  return { inverse: [{ op: "flow.input.setDefault", flowId: flow.id, name: field.name, value: field.default }], resolved: resolvedAs(p), touched: "none" };
}
