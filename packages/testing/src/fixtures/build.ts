/**
 * Small builders for plain context documents, IR type refs and deterministic time. Used by
 * the fixtures and by test suites of every package (no authoring dependency).
 */
import {
  CONTEXT_FORMAT,
  CONTEXT_FORMAT_VERSION,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  type Clock,
  type ContextDocument,
  type Diagnostic,
  type DiagnosticPath,
  type Edge,
  type EnumDecl,
  type FieldDecl,
  type FlowDocument,
  type FlowVariable,
  type GlobalVariable,
  type ImageConstraints,
  type MediaConstraints,
  type NodeInstance,
  type NumberConstraints,
  type Position,
  type StructDecl,
  type TextConstraints,
  type TimedMediaConstraints,
  type TypeDecl,
  type TypeRef,
} from "@briarflow/core";

/** The instant every fixture document uses for `createdAt` / `updatedAt`. */
export const FIXED_TIME = "2026-01-01T00:00:00.000Z";

/** A clock frozen at {@link FIXED_TIME}. */
export const fixedClock: Clock = () => new Date(FIXED_TIME);

/**
 * A clock that advances by `stepMs` on every call, starting at `start` (default
 * {@link FIXED_TIME}).
 */
export function steppingClock(stepMs = 1000, start: string = FIXED_TIME): Clock {
  let now = Date.parse(start);
  return () => {
    const date = new Date(now);
    now += stepMs;
    return date;
  };
}

/** A flow whose top-level arrays are mutable (for editing cloned fixtures). */
export type MutableFlow = Omit<FlowDocument, "types" | "inputs" | "outputs" | "variables" | "nodes" | "edges"> & {
  types: TypeDecl[];
  inputs: FieldDecl[];
  outputs: FieldDecl[];
  variables: FlowVariable[];
  nodes: NodeInstance[];
  edges: Edge[];
};

/** A context whose top-level arrays (and its flows' arrays) are mutable. */
export type MutableContext = Omit<ContextDocument, "types" | "globals" | "flows"> & {
  types: TypeDecl[];
  globals: GlobalVariable[];
  flows: MutableFlow[];
};

/** IR builders (plain `TypeRef`s, no validation). */
export const ir = {
  text: (constraints?: TextConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "text", constraints } : { kind: "primitive", name: "text" },
  int: (constraints?: NumberConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "int", constraints } : { kind: "primitive", name: "int" },
  float: (constraints?: NumberConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "float", constraints } : { kind: "primitive", name: "float" },
  boolean: (): TypeRef => ({ kind: "primitive", name: "boolean" }),
  json: (): TypeRef => ({ kind: "primitive", name: "json" }),
  image: (constraints?: ImageConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "image", constraints } : { kind: "primitive", name: "image" },
  video: (constraints?: TimedMediaConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "video", constraints } : { kind: "primitive", name: "video" },
  audio: (constraints?: TimedMediaConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "audio", constraints } : { kind: "primitive", name: "audio" },
  model3d: (constraints?: MediaConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "model3d", constraints } : { kind: "primitive", name: "model3d" },
  file: (constraints?: MediaConstraints): TypeRef =>
    constraints ? { kind: "primitive", name: "file", constraints } : { kind: "primitive", name: "file" },
  named: (id: string): TypeRef => ({ kind: "named", id }),
  list: (of: TypeRef, bounds: { minItems?: number; maxItems?: number } = {}): TypeRef => ({ kind: "list", of, ...bounds }),
  optional: (of: TypeRef): TypeRef => ({ kind: "optional", of }),
  var: (name: string): TypeRef => ({ kind: "var", name }),
};

/** A struct declaration. */
export function struct(id: string, name: string, fields: FieldDecl[], description?: string): StructDecl {
  return description === undefined ? { kind: "struct", id, name, fields } : { kind: "struct", id, name, description, fields };
}

/** An enum declaration; members as strings or `{ value, label }`. */
export function enumType(id: string, name: string, members: (string | { value: string; label: string })[]): EnumDecl {
  return { kind: "enum", id, name, members: members.map((m) => (typeof m === "string" ? { value: m } : m)) };
}

/** A field / signature entry. */
export function field(name: string, type: TypeRef, extra: { description?: string; default?: unknown } = {}): FieldDecl {
  return { name, type, ...extra };
}

/** Extra node instance data. */
export interface NodeExtra {
  title?: string;
  config?: Record<string, unknown>;
  values?: Record<string, unknown>;
  typeBindings?: Record<string, TypeRef>;
}

/** A node instance. */
export function node(id: string, type: string, position: Position = { x: 0, y: 0 }, extra: NodeExtra = {}): NodeInstance {
  return { id, type, position, ...extra };
}

/** An edge from `"<node>.<port>"` to `"<node>.<port>"`. */
export function edge(id: string, from: string, to: string): Edge {
  const split = (s: string) => {
    const dot = s.indexOf(".");
    return { node: s.slice(0, dot), port: s.slice(dot + 1) };
  };
  return { id, from: split(from), to: split(to) };
}

/** Description of a flow for {@link flow}. Built-in nodes are added unless `builtins: false`. */
export interface FlowSpec {
  id: string;
  name: string;
  description?: string;
  types?: TypeDecl[];
  inputs?: FieldDecl[];
  outputs?: FieldDecl[];
  variables?: FlowVariable[];
  nodes?: NodeInstance[];
  edges?: Edge[];
  /** Default `"n_in"`. */
  inputNodeId?: string;
  /** Default `"n_out"`. */
  outputNodeId?: string;
  builtins?: boolean;
}

/** A flow document with `briar.input` at `{0,0}` and `briar.output` at `{640,0}`. */
export function flow(spec: FlowSpec): FlowDocument {
  const builtins =
    spec.builtins === false
      ? []
      : [
          node(spec.inputNodeId ?? "n_in", FLOW_INPUT_NODE_TYPE, { x: 0, y: 0 }),
          node(spec.outputNodeId ?? "n_out", FLOW_OUTPUT_NODE_TYPE, { x: 640, y: 0 }),
        ];
  const doc: FlowDocument = {
    id: spec.id,
    name: spec.name,
    types: spec.types ?? [],
    inputs: spec.inputs ?? [],
    outputs: spec.outputs ?? [],
    variables: spec.variables ?? [],
    nodes: [...builtins, ...(spec.nodes ?? [])],
    edges: spec.edges ?? [],
  };
  return spec.description === undefined ? doc : { ...doc, description: spec.description };
}

/** Description of a context for {@link context}. */
export interface ContextSpec {
  id?: string;
  name?: string;
  description?: string;
  revision?: number;
  types?: TypeDecl[];
  globals?: GlobalVariable[];
  flows?: FlowDocument[];
}

/** A context document at {@link FIXED_TIME}, revision 1. */
export function context(spec: ContextSpec = {}): ContextDocument {
  const doc: ContextDocument = {
    format: CONTEXT_FORMAT,
    formatVersion: CONTEXT_FORMAT_VERSION,
    id: spec.id ?? "ctx_test",
    name: spec.name ?? "Test context",
    revision: spec.revision ?? 1,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    types: spec.types ?? [],
    globals: spec.globals ?? [],
    flows: spec.flows ?? [],
  };
  return spec.description === undefined ? doc : { ...doc, description: spec.description };
}

/** Returns an edited deep copy of a document; the original is untouched. */
export function editContext(doc: ContextDocument, edit: (draft: MutableContext) => void): ContextDocument {
  const draft = structuredClone(doc) as MutableContext;
  edit(draft);
  return draft as ContextDocument;
}

/** Returns a deep copy of a document with one flow edited. Throws if the flow is missing. */
export function editFlow(
  doc: ContextDocument,
  flowId: string,
  edit: (flow: MutableFlow, doc: MutableContext) => void,
): ContextDocument {
  return editContext(doc, (draft) => {
    const target = draft.flows.find((f) => f.id === flowId);
    if (!target) throw new Error(`fixture: flow ${flowId} not found`);
    edit(target, draft);
  });
}

/** Codes of a diagnostic list, in order. */
export function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** Diagnostics with a given code. */
export function withCode(diagnostics: readonly Diagnostic[], code: string): Diagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

/** True when some diagnostic has this code, severity and (a superset of) this path. */
export function hasDiagnostic(
  diagnostics: readonly Diagnostic[],
  expected: { code: string; severity?: "error" | "warning"; path?: DiagnosticPath },
): boolean {
  return diagnostics.some(
    (d) =>
      d.code === expected.code &&
      (expected.severity === undefined || d.severity === expected.severity) &&
      Object.entries(expected.path ?? {}).every(([k, v]) => (d.path as Record<string, unknown>)[k] === v),
  );
}

/** Recursively sorts object keys (UTF-16 order); arrays keep their order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** Recursively reverses object key insertion order (same JSON value, different key order). */
export function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeysDeep((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
