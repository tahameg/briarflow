/**
 * Payload shape validation per op (`command.invalid_payload`, `command.unknown_op`).
 */
import { COMMAND_OPS, type CommandOp } from "../commands.js";
import { fail, isObject } from "./util.js";

/** Returns a problem ("must be text") or undefined. `path` is the field path for nested problems. */
type Check = (value: unknown, path: string) => { path: string; problem: string } | undefined;

const ok = undefined;
const p = (path: string, problem: string) => ({ path, problem });

const str: Check = (v, path) => (typeof v === "string" ? ok : p(path, "must be text"));
const strOrNull: Check = (v, path) => (v === null || typeof v === "string" ? ok : p(path, "must be text or null"));
const num: Check = (v, path) => (typeof v === "number" && Number.isFinite(v) ? ok : p(path, "must be a finite number"));
const int: Check = (v, path) => (Number.isSafeInteger(v) ? ok : p(path, "must be a whole number"));
const bool: Check = (v, path) => (typeof v === "boolean" ? ok : p(path, "must be true or false"));
const any: Check = (v, path) => (v === undefined ? p(path, "is required") : ok);
const typeInput: Check = (v, path) => (typeof v === "string" || isObject(v) ? ok : p(path, "must be a type (shorthand text or type object)"));
const record: Check = (v, path) => (isObject(v) ? ok : p(path, "must be an object"));
const oneOf =
  (...values: string[]): Check =>
  (v, path) =>
    typeof v === "string" && values.includes(v) ? ok : p(path, `must be one of ${values.map((x) => `"${x}"`).join(", ")}`);

function shape(req: Record<string, Check>, opt: Record<string, Check> = {}): Check {
  return (v, path) => {
    if (!isObject(v)) return p(path, "must be an object");
    for (const key of Object.keys(v)) {
      if (!(key in req) && !(key in opt)) return p(`${path}.${key}`, `is not allowed (allowed: ${[...Object.keys(req), ...Object.keys(opt)].join(", ")})`);
    }
    for (const [key, check] of Object.entries(req)) {
      if (v[key] === undefined) return p(`${path}.${key}`, "is required");
      const r = check(v[key], `${path}.${key}`);
      if (r) return r;
    }
    for (const [key, check] of Object.entries(opt)) {
      if (v[key] === undefined) continue;
      const r = check(v[key], `${path}.${key}`);
      if (r) return r;
    }
    return ok;
  };
}

function arrayOf(item: Check): Check {
  return (v, path) => {
    if (!Array.isArray(v)) return p(path, "must be a list");
    for (let i = 0; i < v.length; i++) {
      const r = item(v[i], `${path}[${i}]`);
      if (r) return r;
    }
    return ok;
  };
}

const scope: Check = (v, path) => {
  if (!isObject(v)) return p(path, 'must be { "kind": "global" } or { "kind": "flow", "flowId": … }');
  if (v["kind"] === "global") return shape({ kind: str })(v, path);
  if (v["kind"] === "flow") return shape({ kind: str, flowId: str })(v, path);
  return p(`${path}.kind`, 'must be "global" or "flow"');
};
const position = shape({ x: num, y: num });
const viewport = shape({ x: num, y: num, zoom: num });
const portRef = shape({ node: str, port: str });
const execEdge = shape({ id: str, from: portRef, to: portRef });
const execEdges: Check = (v, path) => {
  if (v === null) return ok;
  if (!Array.isArray(v)) return p(path, "must be a list of execution lines or null");
  for (const [i, e] of v.entries()) {
    const r = execEdge(e, `${path}[${i}]`);
    if (r) return r;
  }
  return ok;
};
const fieldDecl = shape({ name: str, type: typeInput }, { description: str, default: any });
const member: Check = (v, path) => (typeof v === "string" ? ok : shape({ value: str }, { label: str })(v, path));
const stringRecord: Check = (v, path) => {
  if (!isObject(v)) return p(path, "must be an object");
  for (const [k, x] of Object.entries(v)) if (typeof x !== "string") return p(`${path}.${k}`, "must be text");
  return ok;
};

interface OpSchema {
  req: Record<string, Check>;
  opt?: Record<string, Check>;
}

const flowId = { flowId: str };
const typeId = { typeId: str };
const typeField = { typeId: str, field: str };
const globalId = { globalId: str };
const varRef = { flowId: str, variableId: str };
const nodeRef = { flowId: str, nodeId: str };
const sig = { flowId: str, name: str };
const desc = { description: strOrNull };

const SCHEMAS: Record<Exclude<CommandOp, "edge.disconnect">, OpSchema> = {
  "context.rename": { req: { name: str } },
  "context.setDescription": { req: desc },
  "type.defineStruct": { req: { scope, name: str }, opt: { id: str, description: str, fields: arrayOf(fieldDecl), index: int } },
  "type.defineEnum": { req: { scope, name: str }, opt: { id: str, description: str, members: arrayOf(member), index: int } },
  "type.rename": { req: { ...typeId, name: str } },
  "type.setDescription": { req: { ...typeId, ...desc } },
  "type.delete": { req: typeId },
  "type.moveScope": { req: { ...typeId, to: scope }, opt: { index: int } },
  "type.field.add": { req: { ...typeId, name: str, type: typeInput }, opt: { description: str, default: any, index: int } },
  "type.field.remove": { req: typeField },
  "type.field.rename": { req: { ...typeField, name: str } },
  "type.field.setType": { req: { ...typeField, type: typeInput } },
  "type.field.reorder": { req: { ...typeField, index: int } },
  "type.field.setDescription": { req: { ...typeField, ...desc } },
  "type.field.setDefault": { req: { ...typeField, value: any } },
  "type.field.clearDefault": { req: typeField },
  "type.enum.addMember": { req: { ...typeId, value: str }, opt: { label: str, index: int } },
  "type.enum.removeMember": { req: { ...typeId, value: str } },
  "type.enum.renameMember": { req: { ...typeId, value: str, newValue: str } },
  "type.enum.setMemberLabel": { req: { ...typeId, value: str, label: strOrNull } },
  "global.create": {
    req: { name: str, type: typeInput, access: oneOf("readonly", "readwrite") },
    opt: { value: any, description: str, id: str, index: int },
  },
  "global.rename": { req: { ...globalId, name: str } },
  "global.setType": { req: { ...globalId, type: typeInput } },
  "global.setAccess": { req: { ...globalId, access: oneOf("readonly", "readwrite") } },
  "global.setValue": { req: { ...globalId, value: any } },
  "global.clearValue": { req: globalId },
  "global.setDescription": { req: { ...globalId, ...desc } },
  "global.delete": { req: globalId, opt: { cascade: bool } },
  "flow.create": { req: { name: str }, opt: { id: str, inputNodeId: str, outputNodeId: str, description: str, index: int } },
  "flow.rename": { req: { ...flowId, name: str } },
  "flow.setDescription": { req: { ...flowId, ...desc } },
  "flow.duplicate": { req: flowId, opt: { name: str, id: str, typeIds: stringRecord } },
  "flow.delete": { req: flowId },
  "flow.setViewport": { req: { ...flowId, viewport } },
  "flow.input.add": { req: { ...sig, type: typeInput }, opt: { description: str, default: any, index: int } },
  "flow.input.remove": { req: sig },
  "flow.input.rename": { req: { ...sig, newName: str } },
  "flow.input.setType": { req: { ...sig, type: typeInput } },
  "flow.input.reorder": { req: { ...sig, index: int } },
  "flow.input.setDescription": { req: { ...sig, ...desc } },
  "flow.input.setDefault": { req: { ...sig, value: any } },
  "flow.input.clearDefault": { req: sig },
  "flow.output.add": { req: { ...sig, type: typeInput }, opt: { description: str, index: int } },
  "flow.output.remove": { req: sig },
  "flow.output.rename": { req: { ...sig, newName: str } },
  "flow.output.setType": { req: { ...sig, type: typeInput } },
  "flow.output.reorder": { req: { ...sig, index: int } },
  "flow.output.setDescription": { req: { ...sig, ...desc } },
  "flow.variable.create": {
    req: { ...flowId, name: str, type: typeInput, access: oneOf("public", "private") },
    opt: { default: any, description: str, id: str, index: int },
  },
  "flow.variable.rename": { req: { ...varRef, name: str } },
  "flow.variable.setType": { req: { ...varRef, type: typeInput } },
  "flow.variable.setAccess": { req: { ...varRef, access: oneOf("public", "private") } },
  "flow.variable.setDefault": { req: { ...varRef, value: any } },
  "flow.variable.clearDefault": { req: varRef },
  "flow.variable.setDescription": { req: { ...varRef, ...desc } },
  "flow.variable.delete": { req: varRef, opt: { cascade: bool } },
  "node.add": {
    req: { ...flowId, type: str, position },
    opt: { id: str, title: str, config: record, values: record, index: int },
  },
  "node.remove": { req: nodeRef },
  "node.move": { req: { ...nodeRef, position } },
  "node.setTitle": { req: { ...nodeRef, title: strOrNull } },
  "node.setValue": { req: { ...nodeRef, port: str, value: any } },
  "node.clearValue": { req: { ...nodeRef, port: str } },
  "node.setConfig": { req: { ...nodeRef, config: record } },
  "edge.connect": { req: { ...flowId, from: portRef, to: portRef }, opt: { id: str, index: int } },
  "exec.connect": { req: { ...flowId, from: portRef, to: portRef }, opt: { id: str, index: int } },
  "exec.disconnect": { req: { ...flowId, edgeId: str } },
  "flow.exec.enable": { req: flowId },
  "flow.exec.set": { req: { ...flowId, edges: execEdges } },
};

/**
 * Validates the op and payload shape. Returns the op. Throws `command.unknown_op` /
 * `command.invalid_payload`.
 */
export function checkPayload(command: unknown): CommandOp {
  if (!isObject(command)) fail("command.invalid_payload", `Command ${describe(command)}: the command must be an object with an "op".`);
  const op = command["op"];
  if (typeof op !== "string") fail("command.invalid_payload", `Command ${describe(command)}: op must be text, e.g. "node.move".`);
  if (!(COMMAND_OPS as readonly string[]).includes(op)) {
    fail("command.unknown_op", `Unknown command "${op}". See docs/specs/commands.md for the list.`, { op });
  }
  const typed = op as CommandOp;
  const problem = typed === "edge.disconnect" ? checkDisconnect(command) : checkSchema(command, SCHEMAS[typed]);
  if (problem) {
    fail("command.invalid_payload", `Command ${op}: ${problem.path} ${problem.problem}.`, { field: problem.path });
  }
  return typed;
}

function checkSchema(command: Record<string, unknown>, schema: OpSchema) {
  const opt = { op: str, restore: bool, ...(schema.opt ?? {}) };
  const r = shape(schema.req, opt)(command, "");
  return r ? { path: r.path.replace(/^\./, ""), problem: r.problem } : undefined;
}

function checkDisconnect(command: Record<string, unknown>) {
  if (command["edgeId"] !== undefined && command["to"] !== undefined) {
    return { path: "edgeId", problem: "cannot be combined with to (give one of them)" };
  }
  if (command["to"] !== undefined) return checkSchema(command, { req: { flowId: str, to: portRef } });
  if (command["edgeId"] === undefined) return { path: "edgeId", problem: "or to is required" };
  return checkSchema(command, { req: { flowId: str, edgeId: str } });
}

function describe(command: unknown): string {
  if (isObject(command) && typeof command["op"] === "string") return command["op"];
  return Array.isArray(command) ? "(list)" : command === null ? "(null)" : `(${typeof command})`;
}
