/**
 * @briarflow/authoring — Command set and ContextEditor for editing Briarflow contexts.
 * Pure, synchronous, deterministic. Spec: docs/specs/commands.md; contract: docs/tasks/phase-2.md.
 *
 * @example
 * ```ts
 * import { createContextEditor } from "@briarflow/authoring";
 * const editor = createContextEditor(doc, { catalog });
 * editor.apply({ op: "flow.create", name: "Portrait" });
 * ```
 */
export const PACKAGE_NAME = "@briarflow/authoring";

export { COMMAND_OPS, isCommandOp } from "./commands.js";
export type {
  Command,
  CommandBase,
  CommandOf,
  CommandOp,
  ContextRenameCommand,
  ContextSetDescriptionCommand,
  EdgeConnectCommand,
  EdgeDisconnectCommand,
  ExecConnectCommand,
  ExecDisconnectCommand,
  FlowExecEnableCommand,
  FlowExecSetCommand,
  EnumMemberSpec,
  FieldInputDecl,
  FlowCreateCommand,
  FlowDeleteCommand,
  FlowDuplicateCommand,
  FlowInputAddCommand,
  FlowInputClearDefaultCommand,
  FlowInputRemoveCommand,
  FlowInputRenameCommand,
  FlowInputReorderCommand,
  FlowInputSetDefaultCommand,
  FlowInputSetDescriptionCommand,
  FlowInputSetTypeCommand,
  FlowOutputAddCommand,
  FlowOutputRemoveCommand,
  FlowOutputRenameCommand,
  FlowOutputReorderCommand,
  FlowOutputSetDescriptionCommand,
  FlowOutputSetTypeCommand,
  FlowRenameCommand,
  FlowSetDescriptionCommand,
  FlowSetViewportCommand,
  FlowVariableClearDefaultCommand,
  FlowVariableCreateCommand,
  FlowVariableDeleteCommand,
  FlowVariableRenameCommand,
  FlowVariableSetAccessCommand,
  FlowVariableSetDefaultCommand,
  FlowVariableSetDescriptionCommand,
  FlowVariableSetTypeCommand,
  GlobalClearValueCommand,
  GlobalCreateCommand,
  GlobalDeleteCommand,
  GlobalRenameCommand,
  GlobalSetAccessCommand,
  GlobalSetDescriptionCommand,
  GlobalSetTypeCommand,
  GlobalSetValueCommand,
  NodeAddCommand,
  NodeClearValueCommand,
  NodeMoveCommand,
  NodeRemoveCommand,
  NodeSetConfigCommand,
  NodeSetTitleCommand,
  NodeSetValueCommand,
  PortRef,
  ScopeInput,
  TypeDefineEnumCommand,
  TypeDefineStructCommand,
  TypeDeleteCommand,
  TypeEnumAddMemberCommand,
  TypeEnumRemoveMemberCommand,
  TypeEnumRenameMemberCommand,
  TypeEnumSetMemberLabelCommand,
  TypeFieldAddCommand,
  TypeFieldClearDefaultCommand,
  TypeFieldRemoveCommand,
  TypeFieldRenameCommand,
  TypeFieldReorderCommand,
  TypeFieldSetDefaultCommand,
  TypeFieldSetDescriptionCommand,
  TypeFieldSetTypeCommand,
  TypeInput,
  TypeMoveScopeCommand,
  TypeRenameCommand,
  TypeSetDescriptionCommand,
} from "./commands.js";
export { CommandError } from "./result.js";
export type { ApplyResult, BatchResult, CommandErrorOptions, CreatedIds } from "./result.js";
export { applyCommand, applyCommands } from "./apply.js";
export type { ApplyOptions } from "./apply.js";
export { createContextEditor } from "./editor.js";
export type { ContextEditor, ContextEditorOptions, EditorChange, EditorChangeKind, HistoryEntry } from "./editor.js";
