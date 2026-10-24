/**
 * Struct and constant nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, memberAt, readMember, t, writeMember, type PortError, type PortMap, type PortOptions, type PortScope, type TypeRef, type UnknownValue } from "@briarflow/core";

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
    for (const f of decl.fields) {
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
    for (const f of decl.fields) {
      outputs[f.name] = f.description === undefined ? t.fromRef(f.type) : { type: t.fromRef(f.type), description: f.description };
    }
    return { inputs: { value: t.fromRef({ kind: "named", id: decl.id }) }, outputs };
  },
  run: ({ inputs }) => {
    const value = inputs.value;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, UnknownValue>) } : {};
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
    code: { type: t.text(), description: "Stable code, e.g. node.timeout." },
    message: t.text(),
    node: { type: t.optional(t.text()), description: "Title of the node that failed." },
    nodeId: t.optional(t.text()),
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
  run: async ({ inputs, config, ctx }) => {
    const path = pathOf(config.path);
    const out: Record<string, UnknownValue> = { [path[path.length - 1]!]: (await readMember(inputs.value, config.type, path, (id) => ctx.resolveType(id), (ref) => ctx.media.entry(ref))) as UnknownValue };
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
