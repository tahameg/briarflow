# Briarflow Architecture

Briarflow is a strongly typed, graph-based framework for building prompt-construction and
AI-result pipelines. A **flow** is a typed dataflow graph: it starts at an **input node**,
passes values through **nodes** (template text, call an LLM, generate an image, resize it,
save it…), and ends at an **output node**.

Briarflow is a **library first**. The REST service and the visual editor are consumers of
the library, never the other way around.

> Status: living document. The lead developer owns it. The UX designer fills gaps through
> specs in `docs/specs/`; once a spec is accepted, this document is updated to match.

---

## 1. Principles

1. **Library first.** Every capability exists as a TypeScript API before it gets a REST
   endpoint or a UI.
2. **Data first.** Contexts and flows are plain JSON documents. Behaviour lives in functions
   that read or transform those documents.
3. **Every edit is a command.** UI edits, REST edits and code edits all go through the same
   JSON-serializable command set. That gives one validation path, plus undo/redo for free.
4. **Dependencies point inward.** `core` depends on nothing. UI and server packages depend on
   core, never the reverse.
5. **Portable primitives.** Only web-standard async primitives in shared packages:
   `Promise`, `AbortSignal`, `AsyncIterable`, `fetch`, `ReadableStream`, `Uint8Array`.
   No Node-only APIs, no React, no RxJS, no `EventEmitter` in `core`, `authoring`,
   `runtime`, `client` or `editor`.
6. **Extension through interfaces.** Save targets, media storage, secrets and node packs are
   interfaces with small, documented contracts and a conformance test suite.
7. **Human-friendly APIs.** Names read like English. Defaults work. Errors say what is wrong,
   where, and how to fix it.

---

## 2. Concepts

| Concept | Meaning |
|---|---|
| **Briar instance** | Server-side entry point (`createBriar`). Holds the configured stores, node packs, secrets and the run registry. |
| **Context** | A workspace document. Holds global types, global variables and flows. Saved and loaded as one unit. |
| **Flow** | A typed graph inside a context. Has an input signature, an output signature, local types, local variables, nodes and edges. |
| **Type** | A primitive (`text`, `int`, `float`, `boolean`, `image`, `video`, `audio`, `model3d`, `file`), a user-defined **struct** or **enum**, or a `list`/`optional` of those. No inheritance. Named types are nominal. |
| **Global type** | A struct or enum defined on the context. Usable by every flow and by external callers. |
| **Local type** | A struct or enum defined inside one flow. Usable only inside that flow. |
| **Pack type** | A struct or enum shipped by a node pack (e.g. `openai.ChatMessage`). Read-only, available in every context that loads the pack. |
| **Global variable** | A context-level named value of a primitive, global or pack type. `readonly` (must be initialized) or `readwrite`. |
| **Flow variable** | A flow-level named value. `public` (readable via the API after a run; must be primitive, global or pack type) or `private` (any type, including local). |
| **Node definition** | Code-level description of a node kind: ports + `run` function. Grouped into **node packs**. |
| **Node instance** | A placed node in a flow: its type, position, constant input values and config. |
| **Edge** | A wire from an output port to an input port. An input port has at most one incoming edge. |
| **Run** | One execution of a flow with concrete inputs. Has a status, a result promise, an event stream and `cancel()`. |
| **Command** | A JSON object describing one edit to a context (`{ "op": "node.add", ... }`). |
| **Diagnostic** | A validation finding (error/warning) with a code, a message and a path into the document. |

### Visibility rules (enforced by core validation and authoring)

| Place | Allowed types |
|---|---|
| Flow inputs and outputs (the public signature) | primitives, global types, pack types |
| Global variables | primitives, global types, pack types |
| Public flow variables | primitives, global types, pack types |
| Private flow variables, internal ports, node constants | anything visible in the flow (incl. local types) |
| Fields of a global type | primitives, global types, pack types (never local) |
| Fields of a local type | anything visible in its flow |

---

## 3. Package map

npm workspaces monorepo. Scope: `@briarflow/*`, plus the unscoped facade `briarflow`.

```
                         ┌──────────────────────────────────────────┐
 Layer 3: bridge         │ @briarflow/server   @briarflow/client     │
 (server ⇄ client)       │ @briarflow/editor   @briarflow/editor-react│
                         └───────────────┬──────────────────────────┘
                                         │
 Layer 1: user API        ┌──────────────▼───────────┐   extensions:
 (server side)            │ briarflow  (createBriar) │◀── @briarflow/storage-fs
                          └──────┬─────────────┬─────┘    @briarflow/storage-sqlite
                                 │             │          @briarflow/python
 Layer 2: authoring  ┌───────────▼──┐   ┌──────▼──────────┐   @briarflow/nodes-*
 (UI operations)     │ @briarflow/  │   │ @briarflow/     │
                     │ authoring    │   │ runtime         │
                     └───────┬──────┘   └──────┬──────────┘
                             │                 │
 Layer 0: foundation   ┌─────▼─────────────────▼─────┐
                       │ @briarflow/core             │
                       └─────────────────────────────┘
```

| Package | Kind | Responsibility |
|---|---|---|
| `@briarflow/core` | plain TS | Type IR, `t` type builder, shorthand parser, assignability, generics, value validation, JSON Schema export, document model (context/flow), **serialization + format migrations**, node definition API (`defineNode`, `definePack`), node catalog, flow validation → diagnostics, extension interfaces (`ContextStore`, `MediaStore`, `SecretResolver`, `Logger`), error classes. |
| `@briarflow/authoring` | plain TS | **Layer 2.** The command set and `ContextEditor`: create flows, define/change types, create local and global variables, set access levels, change types, add/move/remove nodes, connect/disconnect, undo/redo. Pure functions over `ContextDocument`. |
| `@briarflow/runtime` | plain TS | Execution engine: scheduling, `Run`, events, cancellation, retries, timeouts, caching, concurrency limits, globals snapshot and variable semantics. |
| `@briarflow/nodes-std` | plain TS | Built-in nodes: flow input/output, variables, globals, struct make/break, list ops, text template, conversions, constants. |
| `@briarflow/nodes-mock` | plain TS | Deterministic fake AI nodes (fake LLM, SVG image generator, fake 3D) for tests and demos without API keys. |
| `@briarflow/nodes-anthropic` (done), `nodes-openai` (later) | plain TS | Provider node packs over plain `fetch` (portable). |
| `briarflow` | plain TS (+ Node optional) | **Layer 1 facade.** `createBriar()`: wires stores, packs, secrets, runtime. Context index (list/get/find flow), fluent authoring handles, run registry, `MemoryContextStore`, `MemoryMediaStore`, `envSecrets()`. |
| `@briarflow/storage-fs` | Node | `FsContextStore` (JSON files) and `FsMediaStore` (files on disk). |
| `@briarflow/storage-sqlite` | Node | `SqliteContextStore`. |
| `@briarflow/python` | Node | **Python extension.** TS bridge: load remote node packs from a Python worker, spawn/supervise worker processes, media transfer. |
| `python/briarflow` (pip: `briarflow`) | Python | Python SDK: `@node` decorator, type bindings, ExecContext, stdlib HTTP worker server. |
| `@briarflow/server` | plain TS (Hono) | **Layer 3.** `createBriarApp(briar, options)` → a Hono app with the REST + SSE API. Portable to Node, Bun, Deno. Users mount their own routes next to it. |
| `@briarflow/client` | plain TS | **Layer 3.** Browser/Node SDK for the REST API. `RemoteRun` implements the same `Run` interface as the runtime. |
| `@briarflow/editor` | plain TS | Headless editor state: local document copy, optimistic command apply, sync with server, undo/redo, selection, viewport. Framework-agnostic store with `subscribe()`. |
| `@briarflow/editor-react` | React | Visual graph editor built on React Flow (`@xyflow/react`). Thin views over `@briarflow/editor`. |
| `@briarflow/testing` | plain TS | Conformance suites (`describeContextStore`, `describeMediaStore`, `describeNodePack`), fixtures, helpers. |
| `apps/server` | Node app | Example service: SQLite + fs media + std/mock packs, serves the studio build. |
| `apps/studio` | Vite + React app | Example editor app. Brutalist style, yellow + dark gray base, pastel accents. |

**Hard rule:** `core`, `authoring`, `runtime`, `nodes-std`, `nodes-mock`, `nodes-anthropic`, `client`, `editor`
never import React, `node:*` modules, or Node-only packages. `briarflow` keeps Node-only code
out of its main entry.

---

## 4. Layer 0 — `@briarflow/core`

### 4.1 Type IR

```ts
type PrimitiveName =
  | "text" | "int" | "float" | "boolean"
  | "image" | "video" | "audio" | "model3d" | "file";

type TypeRef =
  | { kind: "primitive"; name: PrimitiveName; constraints?: Constraints }
  | { kind: "named"; id: TypeId }            // struct or enum, by stable id
  | { kind: "list"; of: TypeRef; minItems?: number; maxItems?: number }
  | { kind: "optional"; of: TypeRef }
  | { kind: "var"; name: string };           // generics; node definitions only
```

- Type ids: user types use `ty_<random>` ids; pack types use `<pack>.<Name>`
  (e.g. `openai.ChatMessage`). Renaming never changes an id.
- No recursive types in v1 (validated).
- Shorthand strings parse to the IR: `"text"`, `"list<image>"`, `"Character?"`,
  `"list<Character?>"`, `"list<text>[1..4]"`, `"$T"` (node definitions only). Names resolve
  against the visible scope: flow local → global → pack. Pack types resolve by qualified id
  (`openai.ChatMessage`) or by short name when exactly one loaded pack exports it and no
  local/global type has it (else `type.ambiguous`). Grammar, identifiers, generics:
  `docs/specs/types.md`.
- Inside a `TypeSpec` built before its pack is known (`t.ref("Role")`, `defineStruct`), a
  named ref may hold a bare name; `definePack` qualifies it to `<pack>.<Name>`. Documents never
  contain bare names.

### 4.2 The `t` builder (developer-facing)

```ts
t.text({ maxLength: 40, multiline: true })
t.int({ min: 0, max: 120 })   t.float()   t.boolean()
t.image({ formats: ["png", "jpeg"] })   t.video()   t.audio()   t.model3d()   t.file()
t.list(t.image(), { maxItems: 4 })
t.optional(t.text())
t.ref("Character")            // named type, resolved by name
t.var("T")                    // generic placeholder
```

Each builder returns a `TypeSpec<V>` carrying the static TS value type `V`, so node `run`
functions get typed `inputs` and must return typed `outputs`. Lists are `readonly V[]`
(values are immutable). Builders whose type TS cannot know (`t.ref("Name")`, `t.var`,
`t.parse`, `t.fromRef`) are typed `UnknownValue` (`string | number | boolean | object | null`),
which reads like `unknown` but lets TS keep enum literals in `run` return values.

### 4.3 Values

All values are JSON:

| Type | JSON value |
|---|---|
| text | string |
| int | number (safe integer) |
| float | number |
| boolean | boolean |
| image/video/audio/model3d/file | `MediaRef` |
| struct | object with no unknown fields; optional and defaulted fields may be omitted on input and are normalized to `null` / the default |
| enum | string (member value) |
| list | array |
| optional | value or `null` |

```ts
interface MediaRef {
  uri: string;            // "briar-media://<id>" or "https://…"
  mime: string;
  bytes?: number;
  hash?: string;          // sha256 of content; used for caching
  meta?: { width?: number; height?: number; durationSec?: number; fps?: number; [k: string]: unknown };
}
```

`validateValue(value, typeRef, scope, options?)` returns diagnostics with value paths
(`inputs.character.age must be >= 0`). `normalizeValue(...)` returns
`{ ok: true, value } | { ok: false, diagnostics }` with every struct field present.

### 4.4 Assignability

- Same primitive → ok. `int → float` → ok (the only implicit widening).
- Named → named: same id only (nominal).
- `list<A> → list<B>` if `A → B`. `T → T?` ok. `T? → T` not ok.
- Constraints are **not** checked when connecting; they are checked at runtime boundaries
  (flow inputs, node inputs that declare constraints, outputs).
- Generic ports: `var` bindings are unified when edges connect; a node instance stores its
  resolved bindings.

### 4.5 JSON Schema

`toJsonSchema(typeRef, scope)` compiles any type to JSON Schema (draft 2020-12). Used for
REST/OpenAPI signatures and LLM structured output. Value validation is implemented natively
in core (no Ajv dependency in core).

### 4.6 Documents

```ts
interface ContextDocument {
  format: "briarflow.context";
  formatVersion: 1;
  id: string;                 // ctx_…
  name: string;
  description?: string;
  revision: number;           // incremented on every applied command batch
  createdAt: string;          // ISO
  updatedAt: string;
  types: TypeDecl[];          // global types
  globals: GlobalVariable[];
  flows: FlowDocument[];
  meta?: Record<string, unknown>;
}

type TypeDecl = StructDecl | EnumDecl;
interface StructDecl { kind: "struct"; id: string; name: string; description?: string; fields: FieldDecl[] }
interface FieldDecl  { name: string; type: TypeRef; description?: string; default?: unknown }
interface EnumDecl   { kind: "enum"; id: string; name: string; description?: string; members: { value: string; label?: string }[] }

interface GlobalVariable {
  id: string; name: string; type: TypeRef;
  access: "readonly" | "readwrite";
  value?: unknown;            // required when readonly
  description?: string;
}

interface FlowDocument {
  id: string;                 // flow_…, unique across all contexts
  name: string;
  description?: string;
  types: TypeDecl[];          // local types
  inputs: FieldDecl[];        // input signature (ports of the input node)
  outputs: FieldDecl[];       // output signature (ports of the output node)
  variables: FlowVariable[];
  nodes: NodeInstance[];      // always includes exactly one "briar.input" and one "briar.output"
  edges: Edge[];
  ui?: { viewport?: { x: number; y: number; zoom: number } };
}

interface FlowVariable { id: string; name: string; type: TypeRef; access: "public" | "private"; default?: unknown; description?: string }

interface NodeInstance {
  id: string;
  type: string;                               // node definition type, e.g. "text.template"
  title?: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;           // validated against the definition's cfg fields
  values?: Record<string, unknown>;           // constants of input ports; kept (ignored) while connected
  typeBindings?: Record<string, TypeRef>;     // resolved generics
}

interface Edge { id: string; from: { node: string; port: string }; to: { node: string; port: string } }
```

### 4.7 Serialization

- `serializeContext(doc): string` and `deserializeContext(json): ContextDocument`.
- `deserializeContext` validates structure and runs **format migrations**
  (`formatVersion` N → N+1 functions registered in core). Stores never parse documents
  themselves; they store and return the serialized string or the plain object.
- Serialization is deterministic (object keys sorted at every level, 2-space indent, trailing
  newline), so diffs and content hashes are stable. `canonicalJson` (no whitespace) is the
  form used for hashes and cache keys.
- `deserializeContext` throws `FormatError` (`format.invalid`, `format.unsupported_version`).

### 4.8 Node definition API

The primary extension point for developers. One file per node, readable top to bottom:

```ts
import { defineNode, t } from "@briarflow/core";

export const textTemplate = defineNode({
  type: "text.template",
  title: "Text template",
  category: "Text",
  description: "Replaces {name} placeholders with the given values.",
  inputs: {
    template: { type: t.text({ multiline: true }), description: "Use {name} placeholders." },
    values:   t.list(t.text()),
  },
  outputs: {
    text: t.text(),
  },
  async run({ inputs, ctx }) {
    return { text: render(inputs.template, inputs.values) };
  },
});

export const textPack = definePack({
  name: "text",
  version: "1.0.0",
  types: [],                 // optional pack types (defineStruct/defineEnum)
  nodes: [textTemplate],
});
```

Full reference: `docs/specs/node-api.md`.

- A port is a `TypeSpec` or `{ type, title?, description?, default?, widget? }`.
- Every unconnected input may hold a constant value (`NodeInstance.values`); no separate
  "parameters" concept.
- **Config** is node-instance data that shapes the node (not wired), declared with the `cfg`
  builder (`cfg.text`, `cfg.int`, `cfg.boolean`, `cfg.choice`, `cfg.type`, `cfg.typeId`,
  `cfg.flowVariable`, `cfg.global`). `run` and `resolvePorts` receive the validated, typed
  config.
- Optional fields: `secrets`, `cache` (default true), `cacheVersion`, `timeoutMs` (default
  5 min), `retry` (default none), `concurrency`, `deprecated`, `icon`, `color`.
- `run` return values are checked at compile time (missing, ill-typed or undeclared outputs)
  and again at run time (`node.invalid_output`).
- Advanced: `resolvePorts({ config, scope })` for nodes whose ports depend on config (variables,
  struct make/break, `text.template`). Pure and synchronous; may return a `PortError`.
- **Namespaces.** A node type is `<namespace>.<name>`; the namespace must be the pack name or
  one listed in `definePack({ namespaces })`. The std pack is `briar` and also claims `text`,
  `list`, `convert`; `briar` is reserved for it. `text.template` takes `config.template` and
  creates one input per `{placeholder}`.
- **Built-in flow nodes.** `briar.input` / `briar.output` are built into core: their ports come
  from the flow signature (`resolveFlowPorts`), they are never catalog entries, and the
  runtime executes them itself. Core also knows the type strings of the variable/global
  get/set nodes (`VARIABLE_NODE_TYPES`) for ordering validation; their definitions live in
  `nodes-std`.
- `toNodeDescriptor(def, pack)` strips `run` and gives a JSON-serializable descriptor for
  clients and the Python manifest.
- `NodeCatalog` (`createCatalog(packs)`) holds packs, resolves node and pack types, detects
  duplicate packs and namespace conflicts.
- Shared graph helpers used by authoring, validation and the runtime:
  `resolveFlowPorts(doc, flowId, catalog)` (ports of every node, generic bindings recomputed
  from edges), `validateNodeConfig(...)`, `computeVariableOrder(doc, flowId, catalog)`
  (implicit ordering edges, `docs/specs/variables.md`).
- Testing a single node: `runNode(def, inputs, options)` from `@briarflow/testing`
  (phase 3/4; in-memory media, fake secrets, fixed clock).

### 4.9 Execution context (what `run` receives)

```ts
interface NodeRunArgs<I, C> {
  inputs: I;
  config: C;                                   // validated, typed config
  node: NodeInstance;
  ctx: ExecContext;
}
interface ExecContext {
  signal: AbortSignal;
  runId: string; flowId: string; nodeId: string;
  attempt: number;                             // 1-based
  progress(fraction: number, message?: string): void;
  log: Logger;
  media: MediaStore;
  secrets: { get(name: string): Promise<string> };   // declared names only
  globals: { get(name: string): unknown };           // run-start snapshot, read-only
  variables: { get(name: string): unknown };         // run-start values, read-only
  fetch: typeof fetch;                               // injectable
}
```

Globals and variables are written only by `briar.global.set` / `briar.variable.set` nodes, so
validation can see and order every write (`docs/specs/variables.md`). Nodes throw
`NodeError(code, message, { retryable })` for expected failures.

### 4.10 Flow validation

`validateFlow(context, flowId, catalog): Diagnostic[]` and `validateContext(...)`. Codes are
stable strings (`edge.type_mismatch`, `input.unconnected`, `flow.cycle`,
`type.unknown`, `visibility.local_type_in_public_signature`, …).

```ts
interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;            // human sentence: what, where, how to fix
  path: { flowId?; nodeId?; port?; edgeId?; typeId?; field?; variableId?; globalId?; valuePath? };
  details?: unknown;          // JSON, e.g. { usages } or { cycle }
}
```

Code catalogue: `docs/specs/types.md` §11, `docs/specs/commands.md` §1.3/§9,
`docs/specs/variables.md` §5. Validation never throws for document problems.

### 4.11 Extension interfaces

```ts
interface ContextStore {
  readonly kind: string;                                        // "memory", "fs", "sqlite"…
  load(id: string): Promise<ContextDocument | undefined>;
  save(doc: ContextDocument, options?: { expectedRevision?: number }): Promise<void>; // throws RevisionConflictError
  delete(id: string): Promise<boolean>;
  list(query?: { search?: string; limit?: number; cursor?: string }): Promise<Page<ContextSummary>>;
  locateFlow(flowId: string): Promise<string | undefined>;     // → contextId
  close?(): Promise<void>;
}
interface ContextSummary { id: string; name: string; revision: number; updatedAt: string; flows: { id: string; name: string }[] }
interface Page<T> { items: T[]; nextCursor?: string }

interface MediaStore {
  readonly kind: string;
  put(data: Uint8Array | ReadableStream<Uint8Array>, info: { mime: string; filename?: string; meta?: Record<string, unknown> }): Promise<MediaRef>;
  get(ref: MediaRef | string): Promise<{ ref: MediaRef; body: ReadableStream<Uint8Array> } | undefined>;
  delete(ref: MediaRef | string): Promise<boolean>;
  resolveUrl?(ref: MediaRef): Promise<string | undefined>;      // public/signed URL when available
}

interface SecretResolver { get(name: string): Promise<string | undefined> }
interface Logger { debug(m: string, d?: object): void; info(…): void; warn(…): void; error(…): void }
```

Contracts in detail: `docs/specs/storage.md`. Highlights:
- `ContextStore.save` is atomic per context, checks `expectedRevision` (missing = 0) and
  **enforces flow-id uniqueness across contexts** (`FlowIdConflictError`). Stores never bump
  revisions.
- Error classes (core): `RevisionConflictError`, `FlowIdConflictError`, `StoreCorruptError`,
  `InvalidCursorError`, `InvalidQueryError`, `InvalidDocumentError`, `StoreClosedError`,
  `MediaError`.
- Helpers (core): `encodeCursor` / `decodeCursor` (keyset cursors for `list`),
  `readMedia(ref, { media, fetch?, signal?, maxBytes? })` (bytes of any MediaRef, from the store
  or via fetch), `sha256Hex`, `canonicalJson`.

Adding a new save target = implement `ContextStore` in a new package, then run
`describeContextStore()` from `@briarflow/testing` against it. Guide:
`docs/guides/writing-a-store.md`.

### 4.12 Shared run types

`Run`, `RunStatus`, `RunEvent`, `RunResult` live in core so that `@briarflow/runtime` (local
runs) and `@briarflow/client` (`RemoteRun`) implement the same interface. See §6.1 and
`docs/specs/runtime.md`. `SerializedError` (core `errors.ts`) carries `code`, `message`,
`details?`, `nodeId?`, `retryable?`, `cause?`.

---

## 5. Layer 2 — `@briarflow/authoring`

Everything the UI does to a context, as JSON commands. Pure, synchronous, deterministic.

```ts
const editor = createContextEditor(doc, { catalog, idGenerator? });
const result = editor.apply({ op: "flow.create", name: "Portrait", id: "flow_abc" });
// result: { ok: true, doc, created: { flowId }, diagnostics } | { ok: false, error: CommandError }
editor.applyBatch([...]);   // atomic: all or nothing
editor.undo(); editor.redo(); editor.canUndo; editor.doc;
```

Rules:
- Commands are plain JSON `{ op, ...payload }`. Created entities accept an optional client
  `id`; when absent the injected `idGenerator` creates one. Clients that sync with a server
  must send ids so local and remote results are identical.
- **Hard violations are rejected** (`CommandError` with code + message): unknown references,
  duplicate names in a scope, invalid identifiers, connecting incompatible ports,
  visibility-rule violations, readonly global without a value, recursive struct.
- **Soft breakage is allowed and reported as diagnostics**: changing a type that makes
  existing edges or constant values invalid keeps them and flags them. Nothing is deleted
  implicitly except edges attached to a removed node/port.
- Each changed batch increments `revision` and sets `updatedAt` (time injected for tests);
  a batch that changes nothing is `changed: false` and keeps the revision.
- Types in payloads may be IR or shorthand strings; shorthand is resolved in the scope of the
  command's target and stored as IR.
- Deleting referenced things: `type.delete` is rejected while used (`type.in_use`);
  `global.delete` / `flow.variable.delete` are rejected while get/set nodes use them unless
  `cascade: true` (removes those nodes and their edges).
- **Undo/redo is command-based.** Every successful apply returns `inverse: Command[]` and
  `resolved: Command[]` (generated ids filled in). `undo()` applies the inverse as a new batch
  (revision goes up), `redo()` re-applies the resolved batch, so the editor can sync undo to
  the server as ordinary commands. Inverse commands carry `restore: true`, which turns value
  and type hard checks into soft diagnostics so that soft-broken state (an invalid constant,
  a mismatched edge) can be restored exactly; structural checks (unknown refs, ids, cycles)
  still apply. Documents still use structural sharing.

Command set (v1; authoritative list and payloads in `docs/specs/commands.md`):

| Group | Commands |
|---|---|
| context | `context.rename`, `context.setDescription` |
| types | `type.defineStruct`, `type.defineEnum`, `type.rename`, `type.setDescription`, `type.delete`, `type.moveScope`, `type.field.add`, `type.field.remove`, `type.field.rename`, `type.field.setType`, `type.field.reorder`, `type.field.setDescription`, `type.field.setDefault`, `type.field.clearDefault`, `type.enum.addMember`, `type.enum.removeMember`, `type.enum.renameMember`, `type.enum.setMemberLabel` |
| globals | `global.create`, `global.rename`, `global.setType`, `global.setAccess`, `global.setValue`, `global.clearValue`, `global.setDescription`, `global.delete` |
| flows | `flow.create`, `flow.rename`, `flow.setDescription`, `flow.duplicate`, `flow.delete` |
| signature | `flow.input.add/remove/rename/setType/reorder/setDescription/setDefault/clearDefault`, `flow.output.add/remove/rename/setType/reorder/setDescription` |
| flow variables | `flow.variable.create/rename/setType/setAccess/setDefault/clearDefault/setDescription/delete` |
| nodes | `node.add`, `node.remove`, `node.move`, `node.setTitle`, `node.setValue`, `node.clearValue`, `node.setConfig` |
| edges | `edge.connect` (replaces an existing edge into the same input), `edge.disconnect` |
| ui | `flow.setViewport` (does not create an undo step) |

Types scope payload: `scope: { kind: "global" } | { kind: "flow"; flowId }`.

---

## 6. Layer 1 — `@briarflow/runtime` and the `briarflow` facade

### 6.1 Engine

```ts
const engine = createEngine({ catalog, media, secrets, logger?, cache?, concurrency?,
  maxConcurrentRuns?, clock?, idGenerator?, random?, fetch?, cancelGraceMs? });
const run = engine.run({ context: doc, flowId, inputs, signal?, useCache?, timeoutMs?, runId? });

// Types from @briarflow/core (§4.12); full semantics in docs/specs/runtime.md
interface Run {
  readonly id: string;
  readonly status: RunStatus;              // queued | running | succeeded | failed | cancelled
  readonly result: Promise<RunResult>;     // never rejects; failures are in RunResult
  events(options?: { after?: number }): AsyncIterable<RunEvent>;  // replay (seq > after), then live
  cancel(reason?: string): void;
}
interface RunResult {
  runId: string; flowId: string; contextId: string; contextRevision: number;
  status: "succeeded" | "failed" | "cancelled";
  outputs?: Record<string, unknown>;
  variables?: Record<string, unknown>;     // public flow variables, final values
  globalWrites?: Record<string, unknown>;
  error?: SerializedError;
  startedAt: string; finishedAt: string;
}
// Every event: { runId, seq (0-based, gap-free), at } plus one of
//   run.started {flowId, contextId} · node.started {nodeId, attempt} · node.progress
//   node.retrying {attempt, nextAttempt, delayMs, error} · node.completed {outputs, cached, durationMs}
//   node.failed {error} · node.skipped {reason: "upstream_failed" | "cancelled", cause?}
//   run.completed {result}
```

Algorithm:
1. Validate the flow; errors → run fails immediately with diagnostics.
2. Validate inputs against the signature.
3. Snapshot globals; initialize flow variables from defaults.
4. Ready-queue scheduling: a node is ready when all connected upstream nodes have completed.
   Ready nodes run concurrently up to `concurrency` (global and per-node-type limits).
5. Constraint check on node inputs that declare constraints; then `run()`.
6. Cache key = hash(node type, pack version, resolved inputs, config). `cache: false`
   disables. Default cache: in-memory LRU; interface `RunCache` for persistent caches.
7. Failure: the failed node's downstream branch is skipped; independent branches finish;
   run status `failed`. Retries with exponential backoff and timeouts per node definition.
8. Cancellation: one `AbortController` per run; the signal is passed to every node.
9. Variable and global semantics: reads/writes happen in execution order. Nodes that write
   variables/globals form ordering dependencies with nodes that read them (see
   `docs/specs/variables.md`). Global writes are applied to the stored context by the facade
   **after a successful run** (last write wins).

### 6.2 Facade: `briarflow`

```ts
import { createBriar, MemoryContextStore, envSecrets } from "briarflow";
import { FsMediaStore } from "@briarflow/storage-fs";
import { SqliteContextStore } from "@briarflow/storage-sqlite";
import { stdPack } from "@briarflow/nodes-std";

const briar = createBriar({
  store: new SqliteContextStore({ file: "./data/briar.db" }),
  media: new FsMediaStore({ dir: "./data/media" }),
  secrets: envSecrets(),
  packs: [stdPack, openaiPack],
});

// Contexts (indexing + persistence)
const ctx = await briar.contexts.create({ name: "Marketing" });
await briar.contexts.list({ search: "mark" });
await briar.contexts.get(ctxId);        // → ContextHandle
await briar.flows.get(flowId);          // → FlowHandle (locates its context)

// Authoring from code (fluent handles over @briarflow/authoring commands)
ctx.types.defineEnum("ArtStyle", ["anime", "realistic", "pixel"]);
ctx.types.defineStruct("Character", { name: "text", age: "int", style: "ArtStyle" });
ctx.globals.create("brandGuide", "text", { access: "readonly", value: "Pastel colors…" });
const flow = ctx.flows.create("Portrait");
flow.inputs.add("character", "Character");
flow.outputs.add("portrait", "image");
const tpl = flow.nodes.add("text.template", { at: [300, 100] });
flow.connect(flow.input.port("character"), tpl.port("values"));
ctx.apply({ op: "node.move", … });     // raw commands always available
await ctx.save();

// Execution
const run = await briar.run(flowId, { character: { name: "Aria", age: 27, style: "anime" } });
const result = await run.result;
briar.runs.get(runId);                  // run registry (in-memory in v1, RunStore later)
```

---

## 7. Layer 3 — server ⇄ client

### 7.1 `@briarflow/server`

`createBriarApp(briar, { basePath = "/api/v1", authorize?, cors? })` returns a Hono app.
`serve(app, { port })` helper for Node. Users add their own routes to the same app, or call
`briar` directly from any framework (the facade is the real API; HTTP is a thin layer).

| Method | Path | Purpose |
|---|---|---|
| GET | `/contexts?search=&limit=&cursor=` | list summaries |
| POST | `/contexts` | create `{ name, description? }` |
| GET | `/contexts/:contextId` | full document |
| DELETE | `/contexts/:contextId` | delete |
| POST | `/contexts/:contextId/commands` | `{ baseRevision, commands[] }` → `{ revision, created, diagnostics }`; 409 on revision conflict, 422 on command error |
| GET | `/contexts/:contextId/diagnostics` | validation findings |
| GET | `/flows/:flowId` | `{ contextId, flow, signature (JSON Schema) }` |
| POST | `/flows/:flowId/runs` | `{ inputs, useCache? }` → `202 { runId, status }`; `?wait=true&waitMs=` (default 60 s, max 300 s) → `RunResult`, or 202 if not finished in time |
| GET | `/runs/:runId` | status + result |
| GET | `/runs/:runId/events` | **SSE** stream of `RunEvent` (replays past events; resume with `Last-Event-ID` or `?after=<seq>`) |
| POST | `/runs/:runId/cancel` | cancel |
| GET | `/node-types` | node descriptors + pack types |
| POST | `/media` | raw body upload (`Content-Type` = mime, `?filename=`) → `MediaRef` |
| GET | `/media/:mediaId` | download |

Errors: `{ "error": { "code": "…", "message": "…", "details"?: … } }`. `@briarflow/server` also
exports `UnauthorizedError` (thrown from `authorize` → `401 auth.unauthorized`) and
`briarError(c, err)` (answers any `BriarError` with the standard body and status) for custom
routes. Full contract: `docs/specs/rest-api.md`.

### 7.2 `@briarflow/client`

```ts
const client = createBriarClient({ baseUrl: "http://localhost:3000/api/v1", fetch? });
await client.contexts.list();
const doc = await client.contexts.get(id);
await client.contexts.apply(id, { baseRevision: doc.revision, commands });
const run = await client.flows.run(flowId, inputs);   // RemoteRun implements Run
for await (const e of run.events()) …                  // SSE parsed from fetch stream
```

### 7.3 `@briarflow/editor` and `@briarflow/editor-react`

- `createEditorStore({ client, contextId })`: loads the document, applies commands locally
  through `@briarflow/authoring` (instant feedback), queues them to the server with
  `baseRevision`, reconciles on response. No collaboration: on a 409 the store reloads and
  reports. Undo/redo, selection, clipboard (later), viewport.
- `editor-react`: `<FlowEditor store flowId />`, `<TypePanel />`, `<VariablesPanel />`,
  `<NodePalette />`, `<RunPanel />`. Port colors come from a type-color map (theme tokens).

---

## 8. Python extension

### 8.1 Protocol (`docs/specs/python-protocol.md` is authoritative)

Worker = an HTTP server started by the Python SDK. The spec adds to the summary below:
`protocol`, `attempt`, `secrets` (declared names only) and `timeoutMs` in the execute body; a
`log` NDJSON line type; `port: "auto"` with a ready line on stdout; an optional bearer token
between bridge and worker; and default node types `<pack>.<camelCase(function_name)>`.

- `GET /briarflow/manifest` → `{ protocol: 1, pack: { name, version }, types: TypeDecl[], nodes: NodeDescriptor[] }`
- `POST /briarflow/execute` → body `{ nodeType, inputs, config, runId, nodeId }`;
  response is **NDJSON**: `{"type":"progress","fraction":0.4,"message":"…"}` lines, then exactly
  one `{"type":"result","outputs":{…}}` or `{"type":"error","code":"…","message":"…"}`.
  Cancellation = the TS side aborts the HTTP request.
- `GET /briarflow/health` → `{ ok: true }`.
- Media in: inputs carry `MediaRef` plus a fetchable `url`. Media out: the worker returns
  `{"$media": {"mime": "image/png", "base64": "…"}}`; the bridge stores it via `MediaStore`
  and substitutes a real `MediaRef`.

### 8.2 Python SDK (`python/briarflow`)

Zero runtime dependencies (stdlib only). Python ≥ 3.10.

```python
from dataclasses import dataclass
from enum import Enum
from typing import Annotated
from briarflow import node, struct, Image, MaxLength, ExecContext, pack, serve

class ArtStyle(str, Enum):
    ANIME = "anime"
    PIXEL = "pixel"

@struct
@dataclass
class Character:
    name: Annotated[str, MaxLength(40)]
    style: ArtStyle

@node(type="imaging.upscale", title="Upscale image", category="Image")
def upscale(image: Image, factor: int = 2, *, ctx: ExecContext) -> Image:
    ctx.progress(0.5, "upscaling")
    data = ctx.media.read(image)
    return ctx.media.create(do_upscale(data, factor), mime="image/png")

my_pack = pack("imaging", version="0.1.0", nodes=[upscale], types=[Character, ArtStyle])

if __name__ == "__main__":
    serve(my_pack, port=8765)
```

Type bindings: `str→text`, `int→int`, `float→float`, `bool→boolean`, `Image/Video/Audio/Model3D/File`
→ media primitives, `list[T]→list`, `T | None`/`Optional[T]→optional`, `@struct` dataclass →
struct, `str`-valued `Enum` → enum, `Annotated[..., MaxLength/Min/Max/…]` → constraints.
Outputs: a single return type becomes port `result`; a `@outputs` dataclass return type
gives one port per field.

### 8.3 TS bridge (`@briarflow/python`)

```ts
const imaging = await pythonPack({ url: "http://127.0.0.1:8765" });   // fetch manifest → NodePack
const worker = await spawnPythonWorker({ command: "python", args: ["-m", "my_nodes"], port: 8765 });
const briar = createBriar({ …, packs: [stdPack, await worker.pack()] });
```

---

## 9. Example apps

- `apps/server`: Node service. SQLite contexts, fs media, std + mock packs, optional Python
  worker via env (`BRIAR_PYTHON_WORKER_URL`). Serves the studio build at `/`.
- `apps/studio`: Vite + React app. **Brutalist** visual style: dark gray (`#1F1F1F`/`#2A2A2A`)
  and yellow (`#FFD400`) base; pastel accents (mint, lavender, peach, sky, pink) for type
  colors and status; thick borders, hard offset shadows, square corners, monospace
  headings, visible grid. Design tokens: `docs/specs/design-system.md`.

---

## 10. Tooling and conventions

- Node ≥ 20, npm workspaces, TypeScript (strict, ESM only, `moduleResolution: "bundler"`).
- During development packages resolve each other from source through `tsconfig.base.json`
  `paths`; Vitest uses `vite-tsconfig-paths`; apps run with `tsx` / Vite.
- Build with `tsdown` per package (ESM + `.d.ts`). Versioning with Changesets (later).
- Tests: Vitest (`packages/*/test/**/*.test.ts`), pytest for Python.
- Deployment: one Docker image (`apps/server` + studio static build). Lite mode by default
  (SQLite + fs + in-process queue); production mode via env (Postgres/Redis/S3, later).
