/**
 * Struct and constant nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, t, type PortError, type PortMap, type PortOptions, type UnknownValue } from "@briarflow/core";

function notAStruct(id: string): PortError {
  return { error: { code: "config.unknown_ref", message: `Struct type "${id}" does not exist in this flow. Pick a struct type for this node.` } };
}

/** `briar.struct.make`: one input per field (field default as port default) → struct value. */
export const structMake = defineNode({
  type: "briar.struct.make",
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
