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
  SECRET_NAME_PATTERN,
  isValidEnumValue,
  isValidSecretName,
  isValidFieldName,
  isValidNodeType,
  isValidPackName,
  isValidTypeName,
} from "./util/names.js";

// Type system
export { MEDIA_PRIMITIVE_NAMES, PRIMITIVE_NAMES, SECRET_KINDS } from "./types/ir.js";
export type {
  ImageConstraints,
  ListTypeRef,
  MediaConstraints,
  MediaMeta,
  MediaPrimitiveName,
  ErrorValue,
  MediaRef,
  NamedTypeRef,
  NumberConstraints,
  OptionalTypeRef,
  PrimitiveName,
  PrimitiveTypeRef,
  SecretConstraints,
  SecretKind,
  SecretRef,
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
export { mediaExtension, memberAt, memberPaths, readMember, typeMembers, writeMember } from "./types/members.js";
export type { MemberPath, TypeMember, TypeResolver } from "./types/members.js";
export { bindTypeVars, collectOneOf, collectTypeVars, joinTypes, meetTypes, substituteTypeVars } from "./types/generics.js";
export type { BindTypeVarsResult, BindingConflict, GenericConnection, TypeBindings } from "./types/generics.js";
export {
  MEDIA_FORMATS,
  MEDIA_ID_PATTERN,
  MEDIA_URI_SCHEME,
  MIME_PATTERN,
  checkMediaEntry,
  formatToMime,
  isMediaRef,
  mediaIdFromUri,
  mediaMetaProblems,
  mimeMatchesKind,
  normalizeMime,
  validateMediaRef,
} from "./types/media.js";

// Values and JSON Schema
export { emptyValue } from "./values/empty.js";
export { normalizeValue, validateValue } from "./values/validate.js";
export { findMedia, typeHasMedia } from "./values/media-walk.js";
export type { FoundMedia } from "./values/media-walk.js";
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
  MEMBER_NODE_TYPES,
} from "./documents/model.js";
export type {
  ContextDocument,
  Edge,
  ExecEdge,
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
export { ERROR_OUTPUT, EXEC_FAILED, EXEC_IN, EXEC_THEN, execPortsOf, isExecNode } from "./nodes/exec-ports.js";
export type { ExecPorts } from "./nodes/exec-ports.js";
export { analyzeExec, autoExecEdges } from "./validation/exec.js";
export type { ExecAnalysis } from "./validation/exec.js";
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
export { defineNode, variant, variantDefinition } from "./nodes/define.js";
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
  NodeVariantDefinition,
  NodeVariantInfo,
  NodeVariants,
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
  VariantInput,
  VariantNodeDefinitionInput,
  VariantsInput,
} from "./nodes/define.js";
export type { ExecContext, NodeRunArgs } from "./nodes/exec.js";
export { definePack } from "./nodes/pack.js";
export type { NodePack, PackDefinitionInput, PackSetting, PackSettingInput } from "./nodes/pack.js";
export { createCatalog, nodeDefinition } from "./nodes/catalog.js";
export { findConversions } from "./nodes/conversions.js";
export type { ConversionMatch } from "./nodes/conversions.js";
export type { NodeCatalog } from "./nodes/catalog.js";
export { toNodeDescriptor } from "./nodes/descriptor.js";
export type { ConfigDescriptor, NodeDescriptor, PortDescriptor, VariantDescriptor, VariantsDescriptor } from "./nodes/descriptor.js";
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
export { readAll } from "./interfaces/media-store.js";
export type { BlobRef, MediaStore, PutMediaInfo, StoredMedia } from "./interfaces/media-store.js";
export { createMemoryMediaRegistry, mediaExists, normalizeMediaEntry, ownerMatches, ownerOf } from "./interfaces/media-registry.js";
export type { MediaEntry, MediaOwner, MediaRegistry, MediaSource, MemoryMediaRegistryOptions, NewMediaEntry } from "./interfaces/media-registry.js";
export { createMedia, mediaIdOf } from "./media/service.js";
export type { Media, MediaBody, MediaOptions, MediaReadOptions, NodeMedia } from "./media/service.js";
export { imageSize } from "./media/sniff.js";
export { createMemoryLastRuns } from "./interfaces/last-runs.js";
export type { LastRun, LastRunNode, LastRunStore } from "./interfaces/last-runs.js";
export type { SecretResolver } from "./interfaces/secrets.js";
export { assertNewSecret, createMemoryVault, secretNotFound, secretProblem, secretValueProblem } from "./interfaces/vault.js";
export type { NewSecret, SecretInfo, SecretVault } from "./interfaces/vault.js";
export { createMemorySettings } from "./interfaces/settings.js";
export type { SettingsStore } from "./interfaces/settings.js";
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
