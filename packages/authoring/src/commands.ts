/**
 * The command set (docs/specs/commands.md). Commands are plain JSON objects `{ op, ...payload }`.
 * Every command may carry `restore: true` (commands.md §1.1a).
 */
import type { Position, TypeRef, TypeScopeRef, Viewport } from "@briarflow/core";

/**
 * A type in a command payload: the IR, or a shorthand string such as `"list<Character?>"`.
 * Shorthand is resolved in the scope of the command's target and stored as IR.
 */
export type TypeInput = TypeRef | string;

/** Where a type is declared: `{ kind: "global" }` or `{ kind: "flow", flowId }`. */
export type ScopeInput = TypeScopeRef;

/** Fields every command accepts. */
export interface CommandBase {
  /**
   * "Put back state that existed before": value and type checks report diagnostics instead of
   * rejecting (commands.md §1.1a). Set on every inverse command; never needed for user actions.
   */
  restore?: boolean;
}

/** A struct field / flow input / flow output in a payload. */
export interface FieldInputDecl {
  name: string;
  type: TypeInput;
  description?: string;
  default?: unknown;
}

/** An enum member in a payload: `"anime"` or `{ value: "pixel", label: "Pixel art" }`. */
export type EnumMemberSpec = string | { value: string; label?: string };

/** One end of an edge: `{ node, port }`. */
export interface PortRef {
  node: string;
  port: string;
}

// ---------------------------------------------------------------------------------------------
// Context (§2)
// ---------------------------------------------------------------------------------------------

/** Renames the context (1–120 chars, trimmed non-empty). */
export interface ContextRenameCommand extends CommandBase {
  op: "context.rename";
  name: string;
}
/** Sets (string, ≤ 2000 chars) or clears (`null`) the context description. */
export interface ContextSetDescriptionCommand extends CommandBase {
  op: "context.setDescription";
  description: string | null;
}

// ---------------------------------------------------------------------------------------------
// Types (§3)
// ---------------------------------------------------------------------------------------------

/** Defines a struct type. created: `{ typeId }`. */
export interface TypeDefineStructCommand extends CommandBase {
  op: "type.defineStruct";
  scope: ScopeInput;
  name: string;
  id?: string;
  description?: string;
  fields?: readonly FieldInputDecl[];
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
/** Defines an enum type. created: `{ typeId }`. */
export interface TypeDefineEnumCommand extends CommandBase {
  op: "type.defineEnum";
  scope: ScopeInput;
  name: string;
  id?: string;
  description?: string;
  members?: readonly EnumMemberSpec[];
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface TypeRenameCommand extends CommandBase {
  op: "type.rename";
  typeId: string;
  name: string;
}
export interface TypeSetDescriptionCommand extends CommandBase {
  op: "type.setDescription";
  typeId: string;
  description: string | null;
}
/** Rejected with `type.in_use` while anything references the type. */
export interface TypeDeleteCommand extends CommandBase {
  op: "type.delete";
  typeId: string;
}
/** Moves a type global → flow or flow → global (flow → other flow goes via global). */
export interface TypeMoveScopeCommand extends CommandBase {
  op: "type.moveScope";
  typeId: string;
  to: ScopeInput;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface TypeFieldAddCommand extends CommandBase {
  op: "type.field.add";
  typeId: string;
  name: string;
  type: TypeInput;
  description?: string;
  default?: unknown;
  /** Insert position; default = end. Clamped to `[0, n]`. */
  index?: number;
}
export interface TypeFieldRemoveCommand extends CommandBase {
  op: "type.field.remove";
  typeId: string;
  field: string;
}
export interface TypeFieldRenameCommand extends CommandBase {
  op: "type.field.rename";
  typeId: string;
  field: string;
  name: string;
}
export interface TypeFieldSetTypeCommand extends CommandBase {
  op: "type.field.setType";
  typeId: string;
  field: string;
  type: TypeInput;
}
export interface TypeFieldReorderCommand extends CommandBase {
  op: "type.field.reorder";
  typeId: string;
  field: string;
  /** Clamped to `[0, n-1]`. */
  index: number;
}
export interface TypeFieldSetDescriptionCommand extends CommandBase {
  op: "type.field.setDescription";
  typeId: string;
  field: string;
  description: string | null;
}
export interface TypeFieldSetDefaultCommand extends CommandBase {
  op: "type.field.setDefault";
  typeId: string;
  field: string;
  value: unknown;
}
export interface TypeFieldClearDefaultCommand extends CommandBase {
  op: "type.field.clearDefault";
  typeId: string;
  field: string;
}
export interface TypeEnumAddMemberCommand extends CommandBase {
  op: "type.enum.addMember";
  typeId: string;
  value: string;
  label?: string;
  /** Insert position; default = end. Clamped to `[0, n]`. */
  index?: number;
}
export interface TypeEnumRemoveMemberCommand extends CommandBase {
  op: "type.enum.removeMember";
  typeId: string;
  value: string;
}
export interface TypeEnumRenameMemberCommand extends CommandBase {
  op: "type.enum.renameMember";
  typeId: string;
  value: string;
  newValue: string;
}
export interface TypeEnumSetMemberLabelCommand extends CommandBase {
  op: "type.enum.setMemberLabel";
  typeId: string;
  value: string;
  label: string | null;
}

// ---------------------------------------------------------------------------------------------
// Globals (§4)
// ---------------------------------------------------------------------------------------------

/** created: `{ globalId }`. */
export interface GlobalCreateCommand extends CommandBase {
  op: "global.create";
  name: string;
  type: TypeInput;
  access: "readonly" | "readwrite";
  value?: unknown;
  description?: string;
  id?: string;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface GlobalRenameCommand extends CommandBase {
  op: "global.rename";
  globalId: string;
  name: string;
}
export interface GlobalSetTypeCommand extends CommandBase {
  op: "global.setType";
  globalId: string;
  type: TypeInput;
}
export interface GlobalSetAccessCommand extends CommandBase {
  op: "global.setAccess";
  globalId: string;
  access: "readonly" | "readwrite";
}
export interface GlobalSetValueCommand extends CommandBase {
  op: "global.setValue";
  globalId: string;
  value: unknown;
}
export interface GlobalClearValueCommand extends CommandBase {
  op: "global.clearValue";
  globalId: string;
}
export interface GlobalSetDescriptionCommand extends CommandBase {
  op: "global.setDescription";
  globalId: string;
  description: string | null;
}
/** Rejected with `global.in_use` while get/set nodes use it, unless `cascade: true`. */
export interface GlobalDeleteCommand extends CommandBase {
  op: "global.delete";
  globalId: string;
  cascade?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Flows (§5)
// ---------------------------------------------------------------------------------------------

/** created: `{ flowId, inputNodeId, outputNodeId }`. */
export interface FlowCreateCommand extends CommandBase {
  op: "flow.create";
  name: string;
  id?: string;
  inputNodeId?: string;
  outputNodeId?: string;
  description?: string;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface FlowRenameCommand extends CommandBase {
  op: "flow.rename";
  flowId: string;
  name: string;
}
export interface FlowSetDescriptionCommand extends CommandBase {
  op: "flow.setDescription";
  flowId: string;
  description: string | null;
}
/** created: `{ flowId, typeIds }` (old local type id → new id). */
export interface FlowDuplicateCommand extends CommandBase {
  op: "flow.duplicate";
  flowId: string;
  name?: string;
  id?: string;
  typeIds?: Readonly<Record<string, string>>;
}
export interface FlowDeleteCommand extends CommandBase {
  op: "flow.delete";
  flowId: string;
}
/** Changes the document and revision but is never recorded for undo. */
export interface FlowSetViewportCommand extends CommandBase {
  op: "flow.setViewport";
  flowId: string;
  viewport: Viewport;
}

// Signature ----------------------------------------------------------------------------------

export interface FlowInputAddCommand extends CommandBase {
  op: "flow.input.add";
  flowId: string;
  name: string;
  type: TypeInput;
  description?: string;
  default?: unknown;
  index?: number;
}
export interface FlowInputRemoveCommand extends CommandBase {
  op: "flow.input.remove";
  flowId: string;
  name: string;
}
export interface FlowInputRenameCommand extends CommandBase {
  op: "flow.input.rename";
  flowId: string;
  name: string;
  newName: string;
}
export interface FlowInputSetTypeCommand extends CommandBase {
  op: "flow.input.setType";
  flowId: string;
  name: string;
  type: TypeInput;
}
export interface FlowInputReorderCommand extends CommandBase {
  op: "flow.input.reorder";
  flowId: string;
  name: string;
  index: number;
}
export interface FlowInputSetDescriptionCommand extends CommandBase {
  op: "flow.input.setDescription";
  flowId: string;
  name: string;
  description: string | null;
}
export interface FlowInputSetDefaultCommand extends CommandBase {
  op: "flow.input.setDefault";
  flowId: string;
  name: string;
  value: unknown;
}
export interface FlowInputClearDefaultCommand extends CommandBase {
  op: "flow.input.clearDefault";
  flowId: string;
  name: string;
}
export interface FlowOutputAddCommand extends CommandBase {
  op: "flow.output.add";
  flowId: string;
  name: string;
  type: TypeInput;
  description?: string;
  index?: number;
}
export interface FlowOutputRemoveCommand extends CommandBase {
  op: "flow.output.remove";
  flowId: string;
  name: string;
}
export interface FlowOutputRenameCommand extends CommandBase {
  op: "flow.output.rename";
  flowId: string;
  name: string;
  newName: string;
}
export interface FlowOutputSetTypeCommand extends CommandBase {
  op: "flow.output.setType";
  flowId: string;
  name: string;
  type: TypeInput;
}
export interface FlowOutputReorderCommand extends CommandBase {
  op: "flow.output.reorder";
  flowId: string;
  name: string;
  index: number;
}
export interface FlowOutputSetDescriptionCommand extends CommandBase {
  op: "flow.output.setDescription";
  flowId: string;
  name: string;
  description: string | null;
}

// ---------------------------------------------------------------------------------------------
// Flow variables (§6)
// ---------------------------------------------------------------------------------------------

/** created: `{ variableId }`. */
export interface FlowVariableCreateCommand extends CommandBase {
  op: "flow.variable.create";
  flowId: string;
  name: string;
  type: TypeInput;
  access: "public" | "private";
  default?: unknown;
  description?: string;
  id?: string;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface FlowVariableRenameCommand extends CommandBase {
  op: "flow.variable.rename";
  flowId: string;
  variableId: string;
  name: string;
}
export interface FlowVariableSetTypeCommand extends CommandBase {
  op: "flow.variable.setType";
  flowId: string;
  variableId: string;
  type: TypeInput;
}
export interface FlowVariableSetAccessCommand extends CommandBase {
  op: "flow.variable.setAccess";
  flowId: string;
  variableId: string;
  access: "public" | "private";
}
export interface FlowVariableSetDefaultCommand extends CommandBase {
  op: "flow.variable.setDefault";
  flowId: string;
  variableId: string;
  value: unknown;
}
export interface FlowVariableClearDefaultCommand extends CommandBase {
  op: "flow.variable.clearDefault";
  flowId: string;
  variableId: string;
}
export interface FlowVariableSetDescriptionCommand extends CommandBase {
  op: "flow.variable.setDescription";
  flowId: string;
  variableId: string;
  description: string | null;
}
/** Rejected with `variable.in_use` while get/set nodes use it, unless `cascade: true`. */
export interface FlowVariableDeleteCommand extends CommandBase {
  op: "flow.variable.delete";
  flowId: string;
  variableId: string;
  cascade?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Nodes (§7)
// ---------------------------------------------------------------------------------------------

/** created: `{ nodeId }`. `briar.input` / `briar.output` are rejected (`node.builtin_singleton`). */
export interface NodeAddCommand extends CommandBase {
  op: "node.add";
  flowId: string;
  type: string;
  position: Position;
  id?: string;
  title?: string;
  /** Validated against the definition's config fields. `cfg.type()` fields accept shorthand. */
  config?: Readonly<Record<string, unknown>>;
  /** Constants of input ports. */
  values?: Readonly<Record<string, unknown>>;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
export interface NodeRemoveCommand extends CommandBase {
  op: "node.remove";
  flowId: string;
  nodeId: string;
}
export interface NodeMoveCommand extends CommandBase {
  op: "node.move";
  flowId: string;
  nodeId: string;
  /** Finite numbers, rounded to 2 decimals. */
  position: Position;
}
export interface NodeSetTitleCommand extends CommandBase {
  op: "node.setTitle";
  flowId: string;
  nodeId: string;
  /** ≤ 80 chars; `null` or `""` clears. */
  title: string | null;
}
export interface NodeSetValueCommand extends CommandBase {
  op: "node.setValue";
  flowId: string;
  nodeId: string;
  port: string;
  value: unknown;
}
export interface NodeClearValueCommand extends CommandBase {
  op: "node.clearValue";
  flowId: string;
  nodeId: string;
  port: string;
}
/** Replaces the whole config. */
export interface NodeSetConfigCommand extends CommandBase {
  op: "node.setConfig";
  flowId: string;
  nodeId: string;
  config: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------------
// Edges (§8)
// ---------------------------------------------------------------------------------------------

/** created: `{ edgeId, replacedEdgeId? }`. Replaces an existing edge into the same input. */
export interface EdgeConnectCommand extends CommandBase {
  op: "edge.connect";
  flowId: string;
  from: PortRef;
  to: PortRef;
  id?: string;
  /** Position in the target list (default: end; clamped). Used by inverse commands to restore order. */
  index?: number;
}
/** Removes an edge by id, or the edge into input `to`. */
export type EdgeDisconnectCommand =
  | (CommandBase & { op: "edge.disconnect"; flowId: string; edgeId: string; to?: undefined })
  | (CommandBase & { op: "edge.disconnect"; flowId: string; to: PortRef; edgeId?: undefined });

// ---------------------------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------------------------

/** Any command of the v1 command set. */
export type Command =
  | ContextRenameCommand
  | ContextSetDescriptionCommand
  | TypeDefineStructCommand
  | TypeDefineEnumCommand
  | TypeRenameCommand
  | TypeSetDescriptionCommand
  | TypeDeleteCommand
  | TypeMoveScopeCommand
  | TypeFieldAddCommand
  | TypeFieldRemoveCommand
  | TypeFieldRenameCommand
  | TypeFieldSetTypeCommand
  | TypeFieldReorderCommand
  | TypeFieldSetDescriptionCommand
  | TypeFieldSetDefaultCommand
  | TypeFieldClearDefaultCommand
  | TypeEnumAddMemberCommand
  | TypeEnumRemoveMemberCommand
  | TypeEnumRenameMemberCommand
  | TypeEnumSetMemberLabelCommand
  | GlobalCreateCommand
  | GlobalRenameCommand
  | GlobalSetTypeCommand
  | GlobalSetAccessCommand
  | GlobalSetValueCommand
  | GlobalClearValueCommand
  | GlobalSetDescriptionCommand
  | GlobalDeleteCommand
  | FlowCreateCommand
  | FlowRenameCommand
  | FlowSetDescriptionCommand
  | FlowDuplicateCommand
  | FlowDeleteCommand
  | FlowSetViewportCommand
  | FlowInputAddCommand
  | FlowInputRemoveCommand
  | FlowInputRenameCommand
  | FlowInputSetTypeCommand
  | FlowInputReorderCommand
  | FlowInputSetDescriptionCommand
  | FlowInputSetDefaultCommand
  | FlowInputClearDefaultCommand
  | FlowOutputAddCommand
  | FlowOutputRemoveCommand
  | FlowOutputRenameCommand
  | FlowOutputSetTypeCommand
  | FlowOutputReorderCommand
  | FlowOutputSetDescriptionCommand
  | FlowVariableCreateCommand
  | FlowVariableRenameCommand
  | FlowVariableSetTypeCommand
  | FlowVariableSetAccessCommand
  | FlowVariableSetDefaultCommand
  | FlowVariableClearDefaultCommand
  | FlowVariableSetDescriptionCommand
  | FlowVariableDeleteCommand
  | NodeAddCommand
  | NodeRemoveCommand
  | NodeMoveCommand
  | NodeSetTitleCommand
  | NodeSetValueCommand
  | NodeClearValueCommand
  | NodeSetConfigCommand
  | EdgeConnectCommand
  | EdgeDisconnectCommand;

/** The `op` string of any command, e.g. `"node.move"`. */
export type CommandOp = Command["op"];

/** The command interface for one op. */
export type CommandOf<O extends CommandOp> = Extract<Command, { op: O }>;

/** Every op of the v1 command set, in spec order. */
export const COMMAND_OPS: readonly CommandOp[] = [
  "context.rename",
  "context.setDescription",
  "type.defineStruct",
  "type.defineEnum",
  "type.rename",
  "type.setDescription",
  "type.delete",
  "type.moveScope",
  "type.field.add",
  "type.field.remove",
  "type.field.rename",
  "type.field.setType",
  "type.field.reorder",
  "type.field.setDescription",
  "type.field.setDefault",
  "type.field.clearDefault",
  "type.enum.addMember",
  "type.enum.removeMember",
  "type.enum.renameMember",
  "type.enum.setMemberLabel",
  "global.create",
  "global.rename",
  "global.setType",
  "global.setAccess",
  "global.setValue",
  "global.clearValue",
  "global.setDescription",
  "global.delete",
  "flow.create",
  "flow.rename",
  "flow.setDescription",
  "flow.duplicate",
  "flow.delete",
  "flow.setViewport",
  "flow.input.add",
  "flow.input.remove",
  "flow.input.rename",
  "flow.input.setType",
  "flow.input.reorder",
  "flow.input.setDescription",
  "flow.input.setDefault",
  "flow.input.clearDefault",
  "flow.output.add",
  "flow.output.remove",
  "flow.output.rename",
  "flow.output.setType",
  "flow.output.reorder",
  "flow.output.setDescription",
  "flow.variable.create",
  "flow.variable.rename",
  "flow.variable.setType",
  "flow.variable.setAccess",
  "flow.variable.setDefault",
  "flow.variable.clearDefault",
  "flow.variable.setDescription",
  "flow.variable.delete",
  "node.add",
  "node.remove",
  "node.move",
  "node.setTitle",
  "node.setValue",
  "node.clearValue",
  "node.setConfig",
  "edge.connect",
  "edge.disconnect",
];

/**
 * True when `op` names a command of the v1 set.
 *
 * @example
 * ```ts
 * isCommandOp("node.move"); // true
 * isCommandOp("node.teleport"); // false
 * ```
 */
export function isCommandOp(op: unknown): op is CommandOp {
  return typeof op === "string" && (COMMAND_OPS as readonly string[]).includes(op);
}
