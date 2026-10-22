# Phase 1 — `@briarflow/core`

Owner: lead-developer (implementation), tester (suites). Backend and frontend developers have
no phase-1 tasks (backend may keep working on the Python SDK, phase 6).

## 1. Goal

Deliver the foundation every other package builds on: the type system (IR, `t` builder with
static inference, shorthand, scopes, assignability, generics, value validation, JSON Schema),
the document model and deterministic serialization, the node definition API (`defineNode`,
`cfg`, `defineStruct`/`defineEnum`, `definePack`, catalog, descriptors), flow/context
validation with stable diagnostic codes, the extension interfaces, the shared run types and
the error classes.

**Exit check:** `npm run typecheck` and `npm test` green; tester's core suite green;
≥ 90 % line coverage on `types/`, `values/`, `schema/`, `validation/`
(`npm run test:coverage -- packages/core`).

The contracts are written: `packages/core/src/**` compiles, every public symbol is exported
from `packages/core/src/index.ts` with JSDoc, and stubs throw `NotImplementedError`
(`code: "not_implemented"`). Specs: `docs/specs/types.md`, `node-api.md`, `variables.md`,
`commands.md` (diagnostic codes only), `storage.md` (interfaces, errors, cursors),
`runtime.md` (run types only). Decisions: `docs/DECISIONS.md` #11–#29.

## 2. Module layout (`packages/core/src`)

| Path | Contents |
|---|---|
| `errors.ts` | `BriarError`, `NotImplementedError`, `isBriarError`, `serializeError`, `SerializedError`, definition errors (`TypeDefinitionError`, `NodeDefinitionError`, `PackDefinitionError`, `CatalogError`, `FormatError`), `NodeError`, storage errors, `MediaError` |
| `util/json.ts` | `JsonValue`, `canonicalJson`, `jsonEquals` |
| `util/hash.ts` | `sha256Hex` (web `crypto.subtle`) |
| `util/ids.ts` | `ID_PREFIXES`, `ID_PATTERN`, `isValidId`, `IdGenerator`, `Clock`, `createIdGenerator`, `createSequentialIdGenerator` |
| `util/names.ts` | identifier regexes, reserved words, `isValid…Name` |
| `types/ir.ts` | `TypeRef` IR, constraints, `MediaRef`, primitive name lists |
| `types/builder.ts` | `TypeSpec`, `StructType`, `EnumType`, `UnknownValue`, `ValueOf`, `t`, `isTypeSpec` |
| `types/define-type.ts` | `defineStruct`, `defineEnum` |
| `types/scope.ts` | `TypeScope`, `createTypeScope`, `scopeForContext`, `scopeForFlow` |
| `types/shorthand.ts` | `parseType`, `formatType` |
| `types/assignability.ts` | `isAssignable`, `typeEquals`, `stripConstraints` |
| `types/generics.ts` | `bindTypeVars`, `substituteTypeVars`, `collectTypeVars`, `joinTypes`, `meetTypes` |
| `types/media.ts` | `MEDIA_FORMATS`, `formatToMime`, `validateMediaRef`, `mediaIdFromUri` |
| `values/validate.ts` | `validateValue`, `normalizeValue` |
| `schema/json-schema.ts` | `toJsonSchema`, `flowSignatureSchema` |
| `documents/model.ts` | document interfaces, format constants, built-in node type constants |
| `documents/factories.ts` | `createContextDocument`, `createFlowDocument`, `findFlow`, `findNode` |
| `serialization/serialize.ts` | `serializeContext`, `deserializeContext` (+ internal migration registry) |
| `nodes/config.ts` | `cfg`, `ConfigField`, `ConfigValues` |
| `nodes/define.ts` | ports, `NodeDefinition`, `defineNode`, `InputsOf`/`OutputsOf`/`ConfigOf`, `RetryPolicy`, `PortScope` |
| `nodes/exec.ts` | `ExecContext`, `NodeRunArgs` |
| `nodes/pack.ts` | `definePack`, `NodePack` |
| `nodes/catalog.ts` | `createCatalog`, `NodeCatalog` |
| `nodes/descriptor.ts` | `toNodeDescriptor`, `NodeDescriptor` |
| `validation/diagnostic.ts` | `Diagnostic`, `DiagnosticPath`, `hasErrors` |
| `validation/ports.ts` | `resolveFlowPorts`, `validateNodeConfig` |
| `validation/variables.ts` | `computeVariableOrder` |
| `validation/validate.ts` | `validateFlow`, `validateContext` |
| `interfaces/*` | `ContextStore`, `MediaStore`, `SecretResolver`, `Logger`/`noopLogger`, `readMedia`, `encodeCursor`/`decodeCursor` |
| `run/types.ts` | `Run`, `RunStatus`, `RunEvent` (+ each event interface), `RunResult` |

Internal helpers may be added in any folder; only `index.ts` is public.

### Already implemented (trivial constructors / data)

Errors (all classes, `serializeError`), `t` builders except `t.parse` (they build IR but do
**not** yet validate constraints), `cfg`, `isTypeSpec`, id/name regexes and `isValid…`
functions, `createIdGenerator`, `createSequentialIdGenerator`, `formatToMime`,
`MEDIA_FORMATS`, `noopLogger`, `hasErrors`, `findFlow`, `findNode`. Everything else throws
`NotImplementedError`.

## 3. Public API (`@briarflow/core`)

Exact definitions with JSDoc are in the source files above; this is the signature index.

```ts
// errors
class BriarError extends Error { code: string; details: unknown; constructor(code, message, options?: { details?; cause? }); toJSON(): SerializedError }
interface SerializedError { code: string; message: string; details?: unknown; nodeId?: string; retryable?: boolean; cause?: SerializedError }
class NotImplementedError, TypeDefinitionError, NodeDefinitionError /*node_def.invalid*/, PackDefinitionError /*pack.invalid*/,
      CatalogError, FormatError, MediaError
class NodeError extends BriarError { retryable: boolean; constructor(code, message, options?: { retryable?; details?; cause? }) }
class RevisionConflictError({ id, name?, expected, actual }), FlowIdConflictError({ flowId, contextId }),
      StoreCorruptError({ id }), InvalidCursorError(message?), InvalidQueryError(message),
      InvalidDocumentError(message), StoreClosedError(kind)
function isBriarError(value: unknown): value is BriarError
function serializeError(error: unknown): SerializedError

// utilities
function canonicalJson(value: unknown): string
function jsonEquals(a: unknown, b: unknown): boolean
function sha256Hex(data: Uint8Array | string): Promise<string>
type IdGenerator = (prefix: string) => string;  type Clock = () => Date;
function isValidId(kind: IdKind, id: string): boolean
function createIdGenerator(options?: { random?: () => number; length?: number }): IdGenerator
function createSequentialIdGenerator(): IdGenerator
function isValidTypeName / isValidFieldName / isValidEnumValue / isValidPackName / isValidNodeType(s: string): boolean

// type IR and builder
type TypeRef = PrimitiveTypeRef | NamedTypeRef | ListTypeRef | OptionalTypeRef | VarTypeRef
interface MediaRef { uri; mime; bytes?; hash?; meta?: MediaMeta }
interface TypeSpec<V = UnknownValue> { kind: "typeSpec"; ref: TypeRef }
type UnknownValue = string | number | boolean | object | null
type ValueOf<S>                         // value type of TypeSpec / StructType / EnumType
const t: { text(c?): TypeSpec<string>; int(c?): TypeSpec<number>; float(c?); boolean(); image(c?): TypeSpec<MediaRef>;
           video(c?); audio(c?); model3d(c?); file(c?); list<V>(item, { minItems?, maxItems? }?): TypeSpec<readonly V[]>;
           optional<V>(inner): TypeSpec<V | null>; ref(StructType<V> | EnumType<V> | string); var(name);
           parse(shorthand): TypeSpec<UnknownValue>; fromRef(ref: TypeRef): TypeSpec<UnknownValue> }
function defineStruct<const F extends FieldInputMap>(name, fields: F, options?: { description? }): StructType<StructValueOf<F>>
function defineEnum<const M extends readonly EnumMemberInput[]>(name, members: M, options?): EnumType<EnumValueOf<M>>

// scopes, shorthand, assignability, generics, media
function createTypeScope(source: { localTypes?; globalTypes?; packTypes?; flowId? }): TypeScope
function scopeForContext(doc: ContextDocument, packTypes?: PackTypeSource): TypeScope
function scopeForFlow(doc: ContextDocument, flowId: string, packTypes?: PackTypeSource): TypeScope
function parseType(text: string, options?: { scope?: TypeScope; allowVars?: boolean }): { ok: true; type } | { ok: false; diagnostic }
function formatType(type: TypeRef, scope?: TypeScope): string
function isAssignable(from: TypeRef, to: TypeRef): boolean
function typeEquals(a: TypeRef, b: TypeRef, options?: { ignoreConstraints? }): boolean
function stripConstraints(type: TypeRef): TypeRef
function bindTypeVars(connections: readonly GenericConnection[]): { ok: true; bindings } | { ok: false; conflict }
function substituteTypeVars(type: TypeRef, bindings: TypeBindings): TypeRef
function collectTypeVars(type: TypeRef): string[]
function joinTypes(a: TypeRef, b: TypeRef): TypeRef | undefined
function meetTypes(a: TypeRef, b: TypeRef): TypeRef | undefined
function formatToMime(format: string): string
function validateMediaRef(value: unknown, primitive: MediaPrimitiveName, path: string): Diagnostic[]
function mediaIdFromUri(uriOrId: string): string | undefined

// values and schema
function validateValue(value, type: TypeRef, scope: TypeScope, options?: { path?; at?; constraints? }): Diagnostic[]
function normalizeValue(value, type, scope, options?): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] }
function toJsonSchema(type: TypeRef, scope: TypeScope, options?: { strict?: boolean }): JsonSchema
function flowSignatureSchema(doc, flowId, packTypes?, options?): { inputs: JsonSchema; outputs: JsonSchema }

// documents and serialization
interface ContextDocument / FlowDocument / NodeInstance / Edge / FieldDecl / StructDecl / EnumDecl / GlobalVariable / FlowVariable
const CONTEXT_FORMAT = "briarflow.context", CONTEXT_FORMAT_VERSION = 1
const FLOW_INPUT_NODE_TYPE = "briar.input", FLOW_OUTPUT_NODE_TYPE = "briar.output", VARIABLE_NODE_TYPES
function createContextDocument(options: { name; id?; description?; idGenerator?; clock? }): ContextDocument
function createFlowDocument(options: { name; id?; description?; inputNodeId?; outputNodeId?; idGenerator? }): FlowDocument
function findFlow(doc, flowId): FlowDocument | undefined;  function findNode(flow, nodeId): NodeInstance | undefined
function serializeContext(doc: ContextDocument): string
function deserializeContext(input: string | unknown): ContextDocument

// nodes
const cfg: { text; int; boolean; choice; type; typeId; flowVariable; global }   // ConfigField<V>
function defineNode<I extends PortMap, O extends PortMap, C extends ConfigMap, const R extends MaybePromise<NodeOutputs<O>>>(
  def: NodeDefinitionInput<I, O, C, R> & CheckOutputKeys<R, O>): NodeDefinition<I, O, C>
type InputsOf<D>; type OutputsOf<D>; type ConfigOf<D>; type AnyNodeDefinition
interface ExecContext { signal; runId; flowId; nodeId; attempt; progress(f, m?); log; media; secrets: { get(name): Promise<string> };
                        globals: { get(name): unknown }; variables: { get(name): unknown }; fetch }
function definePack(input: { name; version; title?; description?; namespaces?; types?; nodes }): NodePack
function createCatalog(packs: readonly NodePack[]): NodeCatalog
function toNodeDescriptor(def: AnyNodeDefinition, pack: { name; version }): NodeDescriptor

// validation
interface Diagnostic { severity: "error" | "warning"; code: string; message: string; path: DiagnosticPath; details?: unknown }
function hasErrors(diagnostics: readonly Diagnostic[]): boolean
function resolveFlowPorts(doc, flowId, catalog): FlowPorts             // Map nodeId → ResolvedNode
function validateNodeConfig(def, config, doc, flowId, catalog): { ok: true; config } | { ok: false; diagnostics }
function computeVariableOrder(doc, flowId, catalog): { implicitEdges; plans; diagnostics }
function validateFlow(doc, flowId, catalog): Diagnostic[]
function validateContext(doc, catalog): Diagnostic[]

// extension interfaces and helpers
interface ContextStore { kind; load; save(doc, { expectedRevision? }?); delete; list(query?): Promise<Page<ContextSummary>>; locateFlow; close? }
interface MediaStore { kind; put(data, { mime, filename?, meta? }); get(ref); delete(ref); resolveUrl? }
interface SecretResolver { get(name): Promise<string | undefined> }
interface Logger { debug; info; warn; error }       const noopLogger: Logger
function readMedia(ref: MediaRef | string, options: { media; fetch?; signal?; maxBytes? }): Promise<Uint8Array>
function encodeCursor(position: { updatedAt; id; search }): string
function decodeCursor(cursor: string, expectedSearch?: string): CursorPosition

// shared run types
type RunStatus; interface Run { id; status; result; events(options?: { after? }); cancel(reason?) }
interface RunResult { runId; flowId; contextId; contextRevision; status; outputs?; variables?; globalWrites?; error?; startedAt; finishedAt }
type RunEvent = RunStartedEvent | NodeStartedEvent | NodeProgressEvent | NodeRetryingEvent | NodeCompletedEvent | NodeFailedEvent | NodeSkippedEvent | RunCompletedEvent
```

## 4. Tasks

### Lead developer (implementation, after this contract)

1. `util/`: `canonicalJson`, `jsonEquals`, `sha256Hex`.
2. `types/`: constraint validation in `t` (throws `TypeDefinitionError`), `t.parse`,
   `defineStruct`/`defineEnum`, scopes, shorthand parser/printer, assignability, generics,
   media validation.
3. `values/`, `schema/`.
4. `documents/factories.ts`, `serialization/` (canonical output, structural validation,
   migration registry with v1 as the only version).
5. `nodes/`: `defineNode` (defaults, title derivation, validation), `definePack` (qualification
   of bare names), catalog, descriptors.
6. `validation/`: ports, config, generics recomputation, variables ordering, flow/context
   validation.
7. `interfaces/`: `readMedia`, cursors.
8. Unit tests for internal helpers in `packages/core/test/internal/`.

### Tester

Write `packages/core/test/**/*.test.ts` against the public API only (import from
`@briarflow/core`), one file per module group, plus the fixtures in §6. Start in parallel with
the implementation; stubs make tests fail with `not_implemented` until done. Report failures
in `docs/tasks/bugs.md` once the lead says a module is implemented.

### Backend / frontend developers

Nothing in phase 1. Read the core contracts: runtime (phase 3), stores (phase 4) and client
(phase 5) implement `Run`, `ContextStore`, `MediaStore` from core.

## 5. Acceptance criteria

Diagnostics are compared by `code`, `severity` and `path`; messages are compared with
`toContain` on the key fragments (names, paths), not byte-for-byte, except where noted.

### 5.1 Errors (`errors.ts`)
- Every class is a `BriarError` with the documented code; `name` = class name.
- `NodeError.retryable` default: true for `node.rate_limited`, `node.unavailable`,
  `node.timeout`; false otherwise; explicit option wins; `toJSON()` includes `retryable`.
- `toJSON()` includes `cause` only when the cause is a Briarflow error (serialized
  recursively). `serializeError(new Error("x"))` → `{ code: "internal", message: "x" }`; never a
  `stack` key.
- `RevisionConflictError` details `{ id, expected, actual }`; `FlowIdConflictError` details
  `{ flowId, contextId }`; codes per storage.md §1.

### 5.2 Utilities
- `canonicalJson` sorts keys recursively, keeps array order, drops `undefined` entries, throws
  `json.invalid` on `NaN`/`Infinity`/functions/cycles. `jsonEquals` ignores key order.
- `sha256Hex("hello")` = `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`; same for
  the UTF-8 bytes.
- Ids/names: every row of types.md §1 (valid and invalid samples, max lengths, reserved words).
  `createSequentialIdGenerator` counts per prefix.

### 5.3 `t` builder and pack types (node-api.md §3, §7; types.md §6)
- Each builder yields the IR in types.md §2 table; empty options produce no `constraints` key.
- Invalid constraints throw `TypeDefinitionError` `type.invalid_constraint`: `min > max`,
  negative lengths/bytes/items, non-integer int bounds, regex that does not compile,
  `minItems > maxItems`. `t.optional(t.optional(x))` throws `type.syntax`. `t.var("t")`
  (invalid var name) throws `type.invalid_name`.
- `defineStruct`/`defineEnum`: invalid/reserved names, duplicate fields (case-insensitive),
  duplicate members, invalid defaults → `PackDefinitionError`. Struct field order kept.
- Static inference: `packages/core/test/internal/types-inference.test-d.ts` (already written;
  the tester may extend it in `packages/core/test/types.test-d.ts`).

### 5.4 Scopes and shorthand (types.md §2, §3)
- Every example of types.md §2 parses to the given IR and `formatType` prints it back.
- `type.syntax` for `T??`, `list<>`, `list<text`, unknown characters, `list<text>[3..1]`
  (→ `type.invalid_constraint`); diagnostic message contains the position.
- `$T` only with `allowVars` (else `type.var_not_allowed`).
- Resolution order local → global → pack short name; `type.ambiguous` lists both ids;
  qualified names never shadowed; shadowing works; `formatType` qualifies when shadowed or
  ambiguous and prints `#<id>` for unknown ids.
- Without a scope, names stay as bare/qualified ids.

### 5.5 Assignability and generics (types.md §4, §5)
- Full table of types.md §4 (each cell at least once), constraints ignored, media never
  convert, `var` never assignable.
- `bindTypeVars`: example of §5.4; join/meet rules of §5.2 (int/float, X/X?, lists); conflict
  result names var, port, bound and other; result independent of connection order (permute);
  constraints dropped from bindings; neighbour-unbound edges contribute nothing (caller
  responsibility, test via `resolveFlowPorts`).

### 5.6 Values (types.md §6–§8)
- Every row of the §6 constraint table: pass and fail, with the message suffix of the table
  (exact suffix match, e.g. `must be >= 0`).
- §7 table: accepted JSON per type, normalization (omitted optional → `null`, omitted defaulted
  → default, nested), unknown field and missing field messages (exact text of §7 examples),
  enum message lists members, path format (`inputs.characters[2].name`).
- `normalizeValue` never mutates input; invalid → `{ ok: false }` with the same diagnostics as
  `validateValue`.
- §8 MediaRef table: each code; formats map to mimes case-insensitively; unknown format =
  literal mime; size/dimension/duration checks only when the fields are present.
- `options.constraints: false` skips constraint checks only.

### 5.7 JSON Schema (types.md §9)
- Each row of the mapping table; `$defs` keys (name, qualified pack id, `Name__id` on
  collision); `MediaRef` def once; `required` rule; `strict` mode; `$schema` on root;
  `type.var_not_allowed` for vars. `flowSignatureSchema` produces two object schemas.
- Generated schemas are valid draft 2020-12 (the tester may use Ajv **as a test devDependency
  at the root**; request it from the lead).

### 5.8 Documents and serialization (ARCH §4.6–4.7)
- `createContextDocument` / `createFlowDocument` produce the documented shapes with injected
  ids and clock; flow has `briar.input` at `{0,0}` and `briar.output` at `{640,0}`.
- `serializeContext` is deterministic: two documents equal up to key order give identical
  strings; output ends with `\n`; `deserializeContext(serializeContext(d))` deep-equals `d`.
- `deserializeContext` accepts a string or an object, never mutates the object, throws
  `FormatError` `format.invalid` with `details.path` for: non-JSON, wrong `format`, missing
  `id`/`flows`, wrong field types; `format.unsupported_version` for `formatVersion: 2` and
  non-integers.

### 5.9 Node definitions, packs, catalog, descriptors (node-api.md §1–§7)
- `defineNode` defaults: title from type (`openai.chatCompletion` → "Chat completion"), category
  = capitalized namespace, description `""`, cache true, cacheVersion "1", timeoutMs 300 000,
  `retry: 2` → `{ maxAttempts: 3 }`, secrets `[]`; port titles from names
  (`maxTokens` → "Max tokens").
- `NodeDefinitionError` (`node_def.invalid`) for: bad type string, bad port names, reserved
  names, output default, invalid input default, invalid config field (choice default not in
  choices). Message names the node type and the field.
- `definePack`: type ids qualified (`words.Tone`), bare refs in node ports and struct fields
  qualified, `pack.invalid` for every case of node-api.md §7.
- `createCatalog`: `catalog.duplicate_pack`, `catalog.namespace_conflict`; `get`, `has`,
  `packOf`, `getType`, `types`, `descriptors()`; `get("briar.input")` → `undefined`.
- `toNodeDescriptor` matches the JSON shape of node-api.md §7 (ports as arrays in declaration
  order, `default` omitted when absent, `null` for absent icon/color/concurrency/deprecated,
  `dynamicPorts` true iff `resolvePorts`), and `JSON.parse(JSON.stringify(d))` deep-equals `d`.

### 5.10 Validation (types.md §10–§11, commands.md §1.3/§9, variables.md §5)
Each code below needs at least one positive fixture and one clean counter-example:
- structure: `flow.builtin_missing`; duplicate node/edge ids (`flow.duplicate_id`);
  `edge.unknown_port`, edges to unknown nodes (`edge.unknown_node`); two edges into one input
  (`edge.duplicate_input`).
- types: `type.unknown_id`, `type.recursive` (direct and via list/optional/other struct),
  `type.duplicate_name`, `type.invalid_name`, `type.reserved_name`, `type.shadows_global`
  (warning), `type.enum_empty` (warning), `type.invalid_default`,
  `visibility.local_type_in_global`, `visibility.local_type_in_public_signature`,
  `visibility.local_type_in_public_variable`.
- nodes: `node.unknown_type`, `config.invalid`, `config.unknown_ref`,
  `node.ports_unresolved`, `node.invalid_value`, `node.generic_conflict`,
  `node.generic_unbound`, `input.unconnected` (not raised with constant, port default or
  optional type), `output.unconnected`.
- edges: `edge.type_mismatch` (incl. hint texts), cycles `flow.cycle` with a path.
- variables: `variable.unordered_writes`, `variable.read_before_write` (not for optional/list
  types), `variable.write_to_readonly`, `variable.unknown`, `variable.unused` (warning,
  private only), `variable.invalid_default`, `global.invalid_value`, `flow.cycle` through
  implicit edges (variables.md example D).
- `computeVariableOrder`: examples A–D of variables.md §4 (implicit edges, `reads` map,
  writer order).
- `resolveFlowPorts`: built-in nodes follow the signature; dynamic ports; typeBindings
  recomputed and order-independent; unknown types produce diagnostics instead of throwing.
- Determinism: same document → identical diagnostic arrays (order included).
- `validateContext` = context-level findings + every flow's `validateFlow` findings.
- Unknown flow id → `BriarError` `flow.not_found` (validateFlow, scopeForFlow,
  resolveFlowPorts, computeVariableOrder, flowSignatureSchema).

### 5.11 Interfaces and helpers (storage.md)
- `encodeCursor`/`decodeCursor` round-trip; output is base64url without padding; malformed
  input or a different search → `InvalidCursorError`.
- `readMedia`: store refs, bare ids and `briar-media://` uris read from the store; `https://`
  uses the injected `fetch` (with `signal`); 404/unknown → `media.not_found`; `maxBytes` →
  `media.too_large`; other schemes → `media.invalid_uri`. Use a small in-test `MediaStore`.
- Run types: compile-only (an object literal of each event type type-checks; `RunEvent`
  narrows on `type`).

## 6. Test fixtures (tester creates in `packages/core/test/fixtures/`)

1. `contexts.ts` — builder functions returning plain `ContextDocument`s (no authoring yet):
   - `portraitContext()`: global enum `ArtStyle` (`ty_style`), struct `Character`
     (`ty_char`: name text, age int{min 0} default 30, style ArtStyle, nickname text?),
     flow `flow_p` "Portrait" with input `character: Character`, output `prompt: text`,
     nodes `n_in`, `n_out`, `n_brk` (`briar.struct.break`), `n_tpl` (`text.template`
     "Draw {name} in {style} style"), edges `e_1…e_4` (commands.md §10 example). Valid.
   - `everyTypeContext()`: every primitive, list with bounds, optional, nested structs, enum
     with labels, unicode names, a 1 MB text constant (storage round-trips reuse it).
   - small broken variants per diagnostic code (one function per code is fine).
   - `variablesContext(example: "A" | "B" | "C" | "D")` for variables.md §4.
2. `packs.ts` — test packs built with the public API:
   - `briarTestPack`: pack name `briar`, namespaces `text`, `list`, `convert`, with
     `briar.variable.get/set`, `briar.global.get/set`, `briar.struct.make/break`,
     `briar.constant`, `text.template`, `list.get`, `convert.toText` implemented just enough
     for ports (`resolvePorts` per node-api.md §9; `run` may return dummy values). It stands in
     for nodes-std until phase 3.
   - `wordsPack` from `docs/guides/writing-nodes.md` (types `Tone`, `Stats`).
   - two packs that conflict (same name; same namespace).
3. `media.ts` — `memoryMediaStore()` minimal in-test implementation and sample `MediaRef`s
   (valid/invalid per types.md §8).
4. `values.ts` — tables of `{ type, value, ok, messageSuffix }` rows for §6/§7 so tests are
   data-driven.

## 7. Order of work

1. Contracts (this task) — done.
2. In parallel: lead implements in the order of §4; tester writes suites in the order of §5.
3. Lead marks modules done in `docs/STATUS.md`; tester runs the full suite and files bugs.
4. Lead reviews coverage and closes the phase.

## 8. Notes for the tester

- Import only from `@briarflow/core`. Fixtures may import `vitest`.
- Until a module is implemented its functions throw `NotImplementedError`; use
  `expect(...)` normally (tests will be red) rather than skipping.
- Type-level tests go in `*.test-d.ts` files; they are compiled by `npm run typecheck`
  (not executed). Use `expectTypeOf` and `// @ts-expect-error` for negative cases.
- `exactOptionalPropertyTypes` is on: build fixtures without `key: undefined`.
- Documents are immutable: tests should assert that inputs are not mutated
  (`structuredClone` before, `toEqual` after) for serialization, normalization and validation.
- Use `createSequentialIdGenerator()` and a fixed `clock` for deterministic output.
