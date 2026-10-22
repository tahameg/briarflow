/**
 * @briarflow/core — type system, document model, node definitions, validation, extension
 * interfaces, shared run types and error classes. Shared package: no `node:*`, no Node-only
 * packages, no React. Phase-1 contract: see docs/tasks/phase-1.md.
 *
 * @example
 * ```ts
 * import { defineNode, definePack, t } from "@briarflow/core";
 * ```
 */

// Errors
export {
  BriarError,
  CatalogError,
  FlowIdConflictError,
  FormatError,
  InvalidCursorError,
  InvalidDocumentError,
  InvalidQueryError,
  MediaError,
  NodeDefinitionError,
  NodeError,
  NotImplementedError,
  PackDefinitionError,
  RevisionConflictError,
  StoreClosedError,
  StoreCorruptError,
  TypeDefinitionError,
  isBriarError,
  serializeError,
} from "./errors.js";
export type { BriarErrorOptions, NodeErrorOptions, SerializedError } from "./errors.js";

// Utilities: JSON, hashing, ids, names
export { canonicalJson, jsonEquals } from "./util/json.js";
export type { JsonValue } from "./util/json.js";
export { sha256Hex } from "./util/hash.js";
export { ID_PATTERN, ID_PREFIXES, createIdGenerator, createSequentialIdGenerator, isValidId } from "./util/ids.js";
export type { Clock, IdGenerator, IdKind, IdPrefix } from "./util/ids.js";
export {
  ENUM_VALUE_PATTERN,
  FIELD_NAME_PATTERN,
  NODE_TYPE_PATTERN,
  PACK_NAME_PATTERN,
  RESERVED_FIELD_NAMES,
  RESERVED_TYPE_NAMES,
  TYPE_NAME_PATTERN,
  TYPE_VAR_NAME_PATTERN,
  isValidEnumValue,
  isValidFieldName,
  isValidNodeType,
  isValidPackName,
  isValidTypeName,
} from "./util/names.js";

// Type system
export { MEDIA_PRIMITIVE_NAMES, PRIMITIVE_NAMES } from "./types/ir.js";
export type {
  ImageConstraints,
  ListTypeRef,
  MediaConstraints,
  MediaMeta,
  MediaPrimitiveName,
  MediaRef,
  NamedTypeRef,
  NumberConstraints,
  OptionalTypeRef,
  PrimitiveName,
  PrimitiveTypeRef,
  TextConstraints,
  TimedMediaConstraints,
  TypeRef,
  VarTypeRef,
} from "./types/ir.js";
export { isTypeSpec, t } from "./types/builder.js";
export type { EnumType, ListOptions, StructType, TypeBuilder, TypeSpec, UnknownValue, ValueOf } from "./types/builder.js";
export { defineEnum, defineStruct } from "./types/define-type.js";
export type {
  DefineTypeOptions,
  EnumMemberInput,
  EnumValueOf,
  FieldInput,
  FieldInputMap,
  FieldValue,
  StructValueOf,
} from "./types/define-type.js";
export { createTypeScope, scopeForContext, scopeForFlow } from "./types/scope.js";
export type {
  PackTypeSource,
  ResolveNameResult,
  ScopedTypeDecl,
  TypeOrigin,
  TypeScope,
  TypeScopeSource,
} from "./types/scope.js";
export { formatType, parseType } from "./types/shorthand.js";
export { typeConstraintDiagnostics } from "./types/constraints.js";
export { collectNamedIds, containsVar, mapNamedIds, typeRefShapeProblem } from "./types/walk.js";
export type { ParseTypeOptions, ParseTypeResult } from "./types/shorthand.js";
export { isAssignable, stripConstraints, typeEquals } from "./types/assignability.js";
export { bindTypeVars, collectTypeVars, joinTypes, meetTypes, substituteTypeVars } from "./types/generics.js";
export type { BindTypeVarsResult, BindingConflict, GenericConnection, TypeBindings } from "./types/generics.js";
export { MEDIA_FORMATS, MEDIA_URI_SCHEME, MIME_PATTERN, formatToMime, mediaIdFromUri, normalizeMime, validateMediaRef } from "./types/media.js";

// Values and JSON Schema
export { normalizeValue, validateValue } from "./values/validate.js";
export type { NormalizeResult, ValueCheckOptions } from "./values/validate.js";
export { flowSignatureSchema, toJsonSchema } from "./schema/json-schema.js";
export type { FlowSignatureSchema, JsonSchema, JsonSchemaOptions } from "./schema/json-schema.js";

// Documents and serialization
export {
  CONTEXT_FORMAT,
  CONTEXT_FORMAT_VERSION,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  VARIABLE_NODE_TYPES,
} from "./documents/model.js";
export type {
  ContextDocument,
  Edge,
  EnumDecl,
  EnumMember,
  FieldDecl,
  FlowDocument,
  FlowVariable,
  GlobalVariable,
  NodeInstance,
  PortAddress,
  Position,
  StructDecl,
  TypeDecl,
  TypeScopeRef,
  Viewport,
} from "./documents/model.js";
export { createContextDocument, createFlowDocument, findFlow, findNode } from "./documents/factories.js";
export type { CreateContextOptions, CreateFlowOptions } from "./documents/factories.js";
export { deserializeContext, serializeContext } from "./serialization/serialize.js";

// Node definitions, packs, catalog
export { cfg } from "./nodes/config.js";
export type {
  CfgBooleanOptions,
  CfgChoiceOptions,
  CfgGlobalOptions,
  CfgIntOptions,
  CfgTextOptions,
  CfgTypeIdOptions,
  ConfigBuilder,
  ConfigField,
  ConfigFieldKind,
  ConfigFieldOptions,
  ConfigFieldValue,
  ConfigMap,
  ConfigValues,
} from "./nodes/config.js";
export { defineNode } from "./nodes/define.js";
export type {
  AnyNodeDefinition,
  CheckOutputKeys,
  ConfigOf,
  DynamicPorts,
  ExtraOutputKeys,
  InputsOf,
  MaybePromise,
  NodeColor,
  NodeDefinition,
  NodeDefinitionInput,
  NodeOutputs,
  OutputsOf,
  Port,
  PortError,
  PortMap,
  PortOptions,
  PortScope,
  PortValue,
  PortValues,
  PortWidget,
  ResolvePortsArgs,
  RetryPolicy,
} from "./nodes/define.js";
export type { ExecContext, NodeRunArgs } from "./nodes/exec.js";
export { definePack } from "./nodes/pack.js";
export type { NodePack, PackDefinitionInput } from "./nodes/pack.js";
export { createCatalog } from "./nodes/catalog.js";
export type { NodeCatalog } from "./nodes/catalog.js";
export { toNodeDescriptor } from "./nodes/descriptor.js";
export type { ConfigDescriptor, NodeDescriptor, PortDescriptor } from "./nodes/descriptor.js";
export { createCatalogFromDescriptors, definitionFromDescriptor, packsFromDescriptors } from "./nodes/from-descriptor.js";
export type {
  CatalogFromDescriptorsOptions,
  DescriptorCatalog,
  NodeTypesDescriptors,
  PackDescriptor,
} from "./nodes/from-descriptor.js";

// Validation
export { hasErrors } from "./validation/diagnostic.js";
export { nodeLabel } from "./validation/labels.js";
export type { Diagnostic, DiagnosticPath } from "./validation/diagnostic.js";
export { resolveFlowPorts, validateNodeConfig } from "./validation/ports.js";
export type { ConfigCheckResult, FlowPorts, ResolvedNode, ResolvedPort } from "./validation/ports.js";
export { computeVariableOrder } from "./validation/variables.js";
export type { ImplicitEdge, VariableAccessPlan, VariableOrder, VariableTarget } from "./validation/variables.js";
export { validateContext, validateFlow } from "./validation/validate.js";

// Extension interfaces
export type {
  ContextListQuery,
  ContextStore,
  ContextSummary,
  Page,
  SaveContextOptions,
} from "./interfaces/context-store.js";
export { readMedia } from "./interfaces/media-store.js";
export type { MediaStore, PutMediaInfo, ReadMediaOptions, StoredMedia } from "./interfaces/media-store.js";
export type { SecretResolver } from "./interfaces/secrets.js";
export { noopLogger } from "./interfaces/logger.js";
export type { LogData, Logger } from "./interfaces/logger.js";
export { decodeCursor, encodeCursor } from "./interfaces/cursor.js";
export {
  CONTEXT_LIST_DEFAULT_LIMIT,
  CONTEXT_LIST_MAX_LIMIT,
  buildContextPage,
  compareContextOrder,
  isAfterCursor,
  matchesContextSearch,
  normalizeListQuery,
} from "./interfaces/context-list.js";
export type { ContextListEntry, NormalizedListQuery } from "./interfaces/context-list.js";
export type { CursorPosition } from "./interfaces/cursor.js";

// Shared run types (implemented by @briarflow/runtime and @briarflow/client)
export type {
  NodeCompletedEvent,
  NodeFailedEvent,
  NodeProgressEvent,
  NodeRetryingEvent,
  NodeSkippedEvent,
  NodeStartedEvent,
  Run,
  RunCompletedEvent,
  RunEvent,
  RunEventBase,
  RunEventType,
  RunEventsOptions,
  RunResult,
  RunStartedEvent,
  RunStatus,
  TerminalRunStatus,
} from "./run/types.js";
