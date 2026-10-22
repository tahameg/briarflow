/**
 * Document model (docs/ARCHITECTURE.md §4.6). Documents are immutable plain JSON: never
 * mutate them in place; authoring returns new documents with structural sharing.
 */
import type { TypeRef } from "../types/ir.js";

/** Value of `ContextDocument.format`. */
export const CONTEXT_FORMAT = "briarflow.context";
/** Current `ContextDocument.formatVersion`. */
export const CONTEXT_FORMAT_VERSION = 1;

/** Node type of the single input node of every flow. Built into core. */
export const FLOW_INPUT_NODE_TYPE = "briar.input";
/** Node type of the single output node of every flow. Built into core. */
export const FLOW_OUTPUT_NODE_TYPE = "briar.output";

/**
 * Node types whose meaning core validation must know (variables.md). Their definitions live
 * in `@briarflow/nodes-std`.
 */
export const VARIABLE_NODE_TYPES = {
  variableGet: "briar.variable.get",
  variableSet: "briar.variable.set",
  globalGet: "briar.global.get",
  globalSet: "briar.global.set",
} as const;

/** A struct field, or one entry of a flow input/output signature. */
export interface FieldDecl {
  name: string;
  type: TypeRef;
  description?: string;
  /** A field/input with a default may be omitted by callers (types.md Deviation 1). */
  default?: unknown;
}

/** A struct type declaration. */
export interface StructDecl {
  kind: "struct";
  /** `ty_…` for user types, `<pack>.<Name>` for pack types. Never changes. */
  id: string;
  name: string;
  description?: string;
  fields: readonly FieldDecl[];
}

/** One enum member. `value` is what values hold; `label` is for UIs. */
export interface EnumMember {
  value: string;
  label?: string;
}

/** An enum type declaration. */
export interface EnumDecl {
  kind: "enum";
  id: string;
  name: string;
  description?: string;
  members: readonly EnumMember[];
}

/** A user-defined or pack type. */
export type TypeDecl = StructDecl | EnumDecl;

/** A context-level variable. */
export interface GlobalVariable {
  /** `gv_…` */
  id: string;
  name: string;
  type: TypeRef;
  access: "readonly" | "readwrite";
  /** Required when `access` is `readonly`. */
  value?: unknown;
  description?: string;
}

/** A flow-level variable. */
export interface FlowVariable {
  /** `var_…` */
  id: string;
  name: string;
  type: TypeRef;
  access: "public" | "private";
  default?: unknown;
  description?: string;
}

/** A canvas position. */
export interface Position {
  x: number;
  y: number;
}

/** A placed node in a flow. */
export interface NodeInstance {
  /** `n_…`, unique within the flow. */
  id: string;
  /** Node definition type, e.g. `"text.template"`. */
  type: string;
  title?: string;
  position: Position;
  /** Validated against the definition's `config` fields. */
  config?: Record<string, unknown>;
  /** Constant values of input ports. Kept (and ignored) while the port is connected. */
  values?: Record<string, unknown>;
  /** Resolved generics, derived from edges (types.md §5.1). */
  typeBindings?: Record<string, TypeRef>;
}

/** One end of an edge. */
export interface PortAddress {
  node: string;
  port: string;
}

/** A wire from an output port to an input port. An input has at most one incoming edge. */
export interface Edge {
  /** `e_…`, unique within the flow. */
  id: string;
  from: PortAddress;
  to: PortAddress;
}

/**
 * An execution line: from a node's execution output (`then`, `failed`, …) to a node's
 * execution input (`in`). Each execution output has at most one line; an input can take many.
 */
export interface ExecEdge {
  /** `x_…`, unique among the flow's execution lines. */
  id: string;
  from: PortAddress;
  to: PortAddress;
}

/** Canvas viewport. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** A typed graph inside a context. */
export interface FlowDocument {
  /** `flow_…`, unique across all contexts (enforced by `ContextStore.save`). */
  id: string;
  name: string;
  description?: string;
  /** Local types: visible only inside this flow. */
  types: readonly TypeDecl[];
  /** Input signature = output ports of the `briar.input` node. */
  inputs: readonly FieldDecl[];
  /** Output signature = input ports of the `briar.output` node. */
  outputs: readonly FieldDecl[];
  variables: readonly FlowVariable[];
  /** Always contains exactly one `briar.input` and one `briar.output` node. */
  nodes: readonly NodeInstance[];
  edges: readonly Edge[];
  /**
   * Execution lines (docs/specs/execution.md). Absent on flows made before execution lines:
   * those run data-driven (every node, in dependency order) until the editor wires them
   * (`flow.exec.enable`). Present, even empty, means only nodes on a line run.
   */
  execEdges?: readonly ExecEdge[];
  ui?: { viewport?: Viewport };
}

/** A workspace document: global types, globals and flows. Saved and loaded as one unit. */
export interface ContextDocument {
  format: typeof CONTEXT_FORMAT;
  formatVersion: typeof CONTEXT_FORMAT_VERSION;
  /** `ctx_…` */
  id: string;
  name: string;
  description?: string;
  /** Incremented on every changed command batch. */
  revision: number;
  /** ISO 8601 UTC with `Z`. */
  createdAt: string;
  updatedAt: string;
  /** Global types. */
  types: readonly TypeDecl[];
  globals: readonly GlobalVariable[];
  flows: readonly FlowDocument[];
  meta?: Record<string, unknown>;
}

/** Where a type is declared: globally or in one flow. Used by commands and scopes. */
export type TypeScopeRef = { kind: "global" } | { kind: "flow"; flowId: string };
