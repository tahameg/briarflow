/**
 * Struct and constant nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, memberAt, readMember, structLayout, t, writeMember, type PortError, type PortMap, type PortOptions, type PortScope, type TypeRef, type UnknownValue } from "@briarflow/core";

function notAStruct(id: string): PortError {
  return { error: { code: "config.unknown_ref", message: `Struct type "${id}" does not exist in this flow. Pick a struct type for this node.` } };
}

/** `briar.struct.make`: one input per field (field default as port default) → struct value. */
export const structMake = defineNode({
  type: "briar.struct.make",
  pure: true,
  title: "Make struct",
  category: "Data",
  icon: "braces",
  color: "sky",
  description: "Builds a struct value from one input per field.",
  config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }) },
  outputs: { value: t.var("S") },
  resolvePorts({ config, scope }) {
    const decl = scope.resolveType(config.typeId);
    if (!decl || decl.kind !== "struct") return notAStruct(config.typeId);
    const inputs: PortMap = {};
    // Instance fields only (an extending struct's come from its base); static ones belong to the type.
    for (const f of structLayout(decl, (id) => scope.resolveType(id)).fields) {
      const port: PortOptions = { type: t.fromRef(f.type) };
      if (f.description !== undefined) port.description = f.description;
      if (f.default !== undefined) port.default = f.default as UnknownValue;
      inputs[f.name] = port;
    }
    return { inputs, outputs: { value: t.fromRef({ kind: "named", id: decl.id }) } };
  },
  run: ({ inputs }) => ({ value: { ...inputs } }),
});

/** `briar.struct.break`: struct value → one output per field. */
export const structBreak = defineNode({
  type: "briar.struct.break",
  pure: true,
  title: "Break struct",
  category: "Data",
  icon: "braces",
  color: "sky",
  description: "Splits a struct value into one output per field.",
  config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }) },
  inputs: { value: t.var("S") },
  resolvePorts({ config, scope }) {
    const decl = scope.resolveType(config.typeId);
    if (!decl || decl.kind !== "struct") return notAStruct(config.typeId);
    const outputs: PortMap = {};
    const layout = structLayout(decl, (id) => scope.resolveType(id));
    // Every member: instance fields, then static fields (read from the type).
    for (const f of [...layout.fields, ...[...layout.statics.values()].map((x) => x.field)]) {
      outputs[f.name] = f.description === undefined ? t.fromRef(f.type) : { type: t.fromRef(f.type), description: f.description };
    }
    return { inputs: { value: t.fromRef({ kind: "named", id: decl.id }) }, outputs };
  },
  run: ({ inputs, config, ctx }) => {
    const value = inputs.value;
    const fields = typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, UnknownValue>) } : {};
    const decl = ctx.resolveType(config.typeId);
    if (decl?.kind !== "struct") return fields;
    const statics: Record<string, UnknownValue> = {};
    for (const [name, st] of structLayout(decl, (id) => ctx.resolveType(id)).statics) statics[name] = (st.value ?? null) as UnknownValue;
    return { ...statics, ...fields };
  },
});

/** `briar.constant`: a typed value set as a constant (identity when wired). */
export const constant = defineNode({
  type: "briar.constant",
  pure: true,
  title: "Constant",
  category: "Data",
  icon: "pin",
  color: "sky",
  description: "A fixed value of a chosen type. Type it in the inspector or wire a value in.",
  config: { type: cfg.type({ title: "Type" }) },
  inputs: { value: t.var("V") },
  outputs: { value: t.var("V") },
  resolvePorts({ config }) {
    return { inputs: { value: t.fromRef(config.type) }, outputs: { value: t.fromRef(config.type) } };
  },
  run: ({ inputs }) => ({ value: inputs.value }),
});

/** `briar.error.break`: an `error` value → its fields (member access for errors). */
export const errorBreak = defineNode({
  type: "briar.error.break",
  pure: true,
  title: "Break error",
  category: "Data",
  icon: "braces",
  color: "sky",
  description: "Splits an error (from a node's error output on its failed line) into its code, message and the node that failed.",
  inputs: { error: t.error() },
  outputs: {
    code: { type: t.string(), description: "Stable code, e.g. node.timeout." },
    message: t.string(),
    node: { type: t.optional(t.string()), description: "Title of the node that failed." },
    nodeId: t.optional(t.string()),
  },
  run: ({ inputs }) => ({ code: inputs.error.code, message: inputs.error.message, node: inputs.error.node ?? null, nodeId: inputs.error.nodeId ?? null }),
});

const memberConfig = {
  type: cfg.type({ title: "Of type", description: "Type of the value the member is read from." }),
  path: cfg.text({ title: "Member", description: "Member name, or a dotted path to a nested one (portrait.width)." }),
};

const pathOf = (path: string) => path.split(".").map((s) => s.trim());

function resolveMember(type: TypeRef, path: string, scope: Pick<PortScope, "resolveType">) {
  const m = memberAt(type, pathOf(path), (id) => scope.resolveType(id));
  if ("error" in m) return { error: { code: "config.invalid", message: `${m.error} Pick a member of the value's type.` } } satisfies PortError;
  return m;
}

const portOf = (type: TypeRef, title: string, description: string | undefined): PortOptions => ({ type: t.fromRef(type), title, ...(description === undefined ? {} : { description }) });

/** `briar.member.get`: `value.path` (types.md §12). Offered for every member when a wire is dropped on empty canvas. */
export const memberGet = defineNode({
  type: "briar.member.get",
  pure: true,
  title: "Get member",
  category: "Data",
  icon: "braces",
  color: "sky",
  description: "Reads a member of a value, like value.member in code: a struct field, or a property of a media value, an error, text or a list.",
  config: memberConfig,
  inputs: { value: t.var("V") },
  resolvePorts({ config, scope }) {
    const m = resolveMember(config.type, config.path, scope);
    if ("error" in m) return m;
    const name = m.path[m.path.length - 1]!;
    return { inputs: { value: t.fromRef(config.type) }, outputs: { [name]: portOf(m.type, m.titles[m.titles.length - 1]!, m.description) } };
  },
  run: ({ inputs, config, ctx }) => {
    const path = pathOf(config.path);
    const out: Record<string, UnknownValue> = { [path[path.length - 1]!]: readMember(inputs.value, config.type, path, (id) => ctx.resolveType(id)) as UnknownValue };
    return out;
  },
});

/** `briar.member.set`: a copy of a struct with one (possibly nested) field replaced. */
export const memberSet = defineNode({
  type: "briar.member.set",
  pure: true,
  title: "Set member",
  category: "Data",
  icon: "braces",
  color: "sky",
  description: "Returns a copy of a struct with one field replaced, like value.field = x in code. Only struct fields can be set; other members are read-only.",
  config: memberConfig,
  inputs: { value: t.var("V"), to: t.var("M") },
  outputs: { value: t.var("V") },
  resolvePorts({ config, scope }) {
    const m = resolveMember(config.type, config.path, scope);
    if ("error" in m) return m;
    if (!m.writable) return { error: { code: "config.invalid", message: `${config.path} is read-only: only struct fields can be set.` } };
    return {
      inputs: { value: t.fromRef(config.type), to: portOf(m.type, m.titles[m.titles.length - 1]!, m.description) },
      outputs: { value: t.fromRef(config.type) },
    };
  },
  run: ({ inputs, config, ctx }) => ({ value: writeMember(inputs.value, config.type, pathOf(config.path), inputs.to, (id) => ctx.resolveType(id)) as UnknownValue }),
});
