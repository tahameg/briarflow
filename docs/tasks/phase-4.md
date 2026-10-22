# Phase 4 — the `briarflow` facade

Owner: backend-developer (reassigned from the lead on 2026-10-21, see `AGENTS.md`; the lead
reviews). Storage packages (`@briarflow/storage-fs`, `@briarflow/storage-sqlite`) are already
implemented by the backend; conformance suites in `@briarflow/testing` belong to the tester.

## 1. Goal

`createBriar()` wires stores, packs, secrets and the runtime into one object that is the real
API of Briarflow: the REST server (phase 5) is a thin layer over it, and scripts use it
directly. ARCHITECTURE.md §6.2 is the sketch; this file is the contract.

**Exit check:** `npm run typecheck` and `npm test` green; the quick start (§5.1) runs as a test
against the memory, fs and sqlite stores; `MemoryContextStore` / `MemoryMediaStore` pass the
conformance suites once `@briarflow/testing` ships them.

Portability: the main entry `briarflow` imports no `node:*` module and no Node-only package
(it runs on Node, Bun, Deno, workers). `envSecrets` reads `globalThis.process?.env` and works
wherever such an object exists; elsewhere pass `env` explicitly.

## 2. Module layout (`packages/briarflow/src`)

| Path | Contents |
|---|---|
| `index.ts` | public surface |
| `briar.ts` | `createBriar`, `Briar`, `BriarOptions`, `ApplyCommandsRequest/Result`, `FlowInfo`, `NodeTypesInfo` |
| `handles.ts` | `ContextHandle`, `FlowHandle`, `NodeHandle`, `TypeHandle`, `GlobalHandle`, `VariableHandle`, field/port helper types |
| `runs.ts` | `BriarRun`, `RunInfo`, run registry, global write-back |
| `memory-context-store.ts`, `memory-media-store.ts` | `MemoryContextStore`, `MemoryMediaStore` |
| `secrets.ts` | `envSecrets`, `staticSecrets` |
| `internal/*` | store helpers (same rules as storage-fs/sqlite `common.ts`) |

## 3. Public API

```ts
// ---- createBriar ----
interface BriarOptions {
  store?: ContextStore;            // default new MemoryContextStore()
  media?: MediaStore;              // default new MemoryMediaStore()
  secrets?: SecretResolver;        // default: no secrets (every get → undefined)
  packs?: readonly NodePack[];     // default []; stdPack is added unless `std: false` or a pack named "briar" is present
  std?: boolean;                   // default true
  logger?: Logger;                 // default noopLogger
  engine?: Omit<EngineOptions, "catalog" | "media" | "secrets" | "logger" | "clock" | "idGenerator">;
  clock?: Clock;                   // documents, runs, registry ages
  idGenerator?: IdGenerator;       // ids of contexts, created entities and runs
  runRetention?: { maxRuns?: number /* 200 */; maxAgeMs?: number /* 3 600 000 */ };
  globalWriteAttempts?: number;    // default 5 (variables.md §8)
}
function createBriar(options?: BriarOptions): Briar;

interface Briar {
  readonly store: ContextStore;
  readonly media: MediaStore;
  readonly catalog: NodeCatalog;
  readonly engine: Engine;

  contexts: {
    create(input: { name: string; description?: string; id?: string }): Promise<ContextHandle>; // saved, revision 0
    list(query?: ContextListQuery): Promise<Page<ContextSummary>>;
    iterate(query?: { search?: string; pageSize?: number }): AsyncIterable<ContextSummary>;
    get(contextId: string): Promise<ContextHandle>;           // context.not_found
    find(contextId: string): Promise<ContextHandle | undefined>;
    delete(contextId: string): Promise<boolean>;
  };
  flows: {
    get(flowId: string): Promise<FlowHandle>;                 // via store.locateFlow; flow.not_found
    locate(flowId: string): Promise<string | undefined>;      // → contextId
    info(flowId: string): Promise<FlowInfo>;                  // { contextId, revision, flow, signature }
  };
  nodeTypes(): NodeTypesInfo;                                 // { packs, nodes: NodeDescriptor[], types: TypeDecl[] }
  diagnostics(contextId: string): Promise<{ revision: number; diagnostics: Diagnostic[] }>;

  /** What `POST /contexts/:id/commands` calls (rest-api.md §3). */
  applyCommands(contextId: string, request: { baseRevision: number; commands: readonly Command[] }): Promise<ApplyCommandsResult>;

  run(flowId: string, inputs?: Record<string, unknown>, options?: BriarRunOptions): Promise<BriarRun>;
  runs: {
    get(runId: string): BriarRun | undefined;
    list(filter?: { flowId?: string; contextId?: string; status?: RunStatus; limit?: number }): BriarRun[]; // newest first
  };
  close(): Promise<void>;
}

interface ApplyCommandsResult {
  revision: number; changed: boolean; created: CreatedIds[]; diagnostics: Diagnostic[];
  doc: ContextDocument;            // not part of the REST body; handy for callers
}
interface BriarRunOptions {
  useCache?: boolean; signal?: AbortSignal; timeoutMs?: number; runId?: string;
  throwOnInvalid?: boolean;        // throw run.invalid_flow / run.invalid_inputs instead of returning a failed run
  context?: ContextDocument;       // run this document instead of the stored one (FlowHandle.run uses it)
}
interface BriarRun extends Run {   // Run from @briarflow/core
  readonly flowId: string; readonly contextId: string; readonly createdAt: string;
  readonly finished: RunResult | undefined;                   // set once `result` resolved
  readonly globalWriteStatus: "applied" | "partial" | "failed" | undefined;
  info(): RunInfo;                 // { runId, flowId, contextId, status, createdAt, result?, globalWriteStatus? } (GET /runs/:id)
}

// ---- stores and secrets ----
class MemoryContextStore implements ContextStore { kind = "memory"; writeRaw(id, text): Promise<void> }
class MemoryMediaStore implements MediaStore { kind = "memory"; constructor(options?: { maxBytes?: number; idGenerator?: () => string }) }
function envSecrets(options?: string | { prefix?: string; env?: Record<string, string | undefined> }): SecretResolver;
function staticSecrets(values: Record<string, string>): SecretResolver;
```

### 3.1 Fluent handles (authoring from code)

Handles are thin views over `@briarflow/authoring` (one `ContextEditor` per `ContextHandle`).
Every authoring method is **synchronous**, applies one command batch, and **throws the
`CommandError`** when authoring rejects it (its message says what, where and how to fix).
Only `save()`, `reload()` and `run()` are async. Nothing is persisted until `save()`.

```ts
interface ContextHandle {
  readonly id: string; readonly name: string; readonly doc: ContextDocument;
  readonly revision: number;       // of doc
  readonly savedRevision: number;  // revision in the store as far as this handle knows
  readonly dirty: boolean;
  types: TypesApi;                 // global scope
  globals: {
    create(name: string, type: TypeLike, options?: { access?: "readonly" | "readwrite" /* default "readwrite" */; value?: unknown; description?: string; id?: string }): GlobalHandle;
    get(nameOrId: string): GlobalHandle;  list(): GlobalHandle[];
  };
  flows: {
    create(name: string, options?: { description?: string; id?: string }): FlowHandle;
    get(nameOrId: string): FlowHandle;  list(): FlowHandle[];
  };
  apply(command: Command): CreatedIds;  apply(commands: readonly Command[]): CreatedIds[];
  save(): Promise<void>;           // expectedRevision = savedRevision; no-op when not dirty
  reload(): Promise<void>;         // replaces doc with the stored one, clears history
  diagnostics(): Diagnostic[];
  undo(): boolean;  redo(): boolean;   // false = nothing to undo/redo
}
interface TypesApi {
  defineStruct(name: string, fields: Record<string, FieldLike>, options?: { description?: string; id?: string }): TypeHandle;
  defineEnum(name: string, members: readonly EnumMemberSpec[], options?: { description?: string; id?: string }): TypeHandle;
  get(nameOrId: string): TypeHandle;
}
type TypeLike = string | TypeRef | TypeSpec;               // "list<Character?>", IR, or t.text()
type FieldLike = TypeLike | { type: TypeLike; description?: string; default?: unknown };

interface FlowHandle {
  readonly id: string; readonly name: string; readonly context: ContextHandle; readonly doc: FlowDocument;
  readonly input: NodeHandle;  readonly output: NodeHandle;  // built-ins: input.port("character")
  types: TypesApi;                                           // flow-local scope
  inputs:  { add(name: string, type: TypeLike, options?: { description?: string; default?: unknown }): FlowHandle; remove(name: string): FlowHandle };
  outputs: { add(name: string, type: TypeLike, options?: { description?: string }): FlowHandle; remove(name: string): FlowHandle };
  variables: { create(name: string, type: TypeLike, options?: { access?: "public" | "private" /* default "private" */; default?: unknown; description?: string; id?: string }): VariableHandle; get(nameOrId: string): VariableHandle };
  nodes: {
    add(type: string, options?: { at?: [number, number] | Position; config?: Record<string, unknown>; values?: Record<string, unknown>; title?: string; id?: string }): NodeHandle;
    get(id: string): NodeHandle; list(): NodeHandle[];
    getGlobal(global: GlobalHandle | string, options?): NodeHandle;  setGlobal(...): NodeHandle;
    getVariable(variable: VariableHandle | string, options?): NodeHandle;  setVariable(...): NodeHandle;
  };
  connect(from: PortRef, to: PortRef): string;               // → edgeId
  disconnect(to: PortRef): void;
  run(inputs?: Record<string, unknown>, options?: Omit<BriarRunOptions, "context">): Promise<BriarRun>; // runs the handle's current doc (unsaved edits included)
}
interface NodeHandle {
  readonly id: string; readonly type: string; readonly flow: FlowHandle; readonly instance: NodeInstance;
  port(name: string): PortRef;     // { node: id, port: name }; checked by connect
  set(port: string, value: unknown): NodeHandle;   clear(port: string): NodeHandle;
  configure(config: Record<string, unknown>): NodeHandle;  move(at): NodeHandle;  setTitle(title: string | null): NodeHandle;
  remove(): void;
}
```

`at` defaults to a cascade (`x = 320 + 40·k`, `y = 160 + 40·k`, k = nodes already added) so
graphs built from code open readably in the studio.

## 4. Behaviour

- **contexts.create** persists at once (revision 0). An existing id → `BriarError("context.exists")`
  (checked with `load` first; a racing create of the same id may overwrite — documented).
  Name problems → core's `document.invalid_name` / `document.invalid_id`.
- **Not found:** `BriarError` codes `context.not_found` (`details: { contextId }`),
  `flow.not_found` (`details: { flowId }`), `run.not_found` (only from helpers that require a
  run; `runs.get` returns `undefined`).
- **applyCommands:** `commands` must be an array and `baseRevision` an integer ≥ 0, else
  `BriarError("request.invalid_body")` with `details: [{ path, problem }]`. Then load (→
  `context.not_found`), `baseRevision !== doc.revision` → `RevisionConflictError`
  (`details: { id, expected: baseRevision, actual }`), `applyCommands` (rejection → the
  `CommandError` is thrown as is), `changed: false` → returned without saving, else save with
  `expectedRevision: baseRevision` (a race → `RevisionConflictError`; `FlowIdConflictError`
  passes through). Ids are generated with the facade's `idGenerator`, time from its `clock`.
- **run:** `flowId` → context via `locateFlow` (unless `options.context` is given) → load →
  optional pre-check (`throwOnInvalid`: `BriarError(run.invalid_flow | run.invalid_inputs)` with
  the engine's message and `details.diagnostics`) → `engine.run` → registered. Without
  `throwOnInvalid` an invalid flow/inputs give a failed run, as in the engine.
- **Global writes (variables.md §8):** for a `succeeded` result with non-empty
  `globalWrites`, before `run.result` resolves: names → global ids from the document the run
  used; load the stored context; drop writes whose global was deleted (`reason: "deleted"`),
  became readonly (`"readonly"`) or whose value the new type rejects (`"invalid_value"`, with the
  command error message); apply the rest as one `global.setValue` batch; save with
  `expectedRevision`; on `RevisionConflictError` reload and retry, up to `globalWriteAttempts`
  (5). Each drop logs `logger.warn("global.write_dropped", { runId, globalId, reason, message? })`.
  `globalWriteStatus`: `"applied"` (all written), `"partial"` (some dropped), `"failed"` (none
  written: all dropped, context deleted, or retries exhausted / save error — logged with
  `logger.error("global.write_failed", …)`). The `RunResult` itself is never changed.
- **Run registry:** in memory. Running runs are never evicted. Finished runs are kept until more
  than `maxRuns` finished runs exist (oldest finished first) or they finished more than `maxAgeMs`
  ago (pruned lazily on `run`, `runs.get`, `runs.list`). `runs.list` is newest first
  (`createdAt` desc, then id), default limit 50.
- **nodeTypes:** `packs: { name, version, title, description }[]` in catalog order, `nodes` =
  `catalog.descriptors()`, `types` = pack types.
- **close:** idempotent. Cancels running runs (`"Briarflow is shutting down."`), waits for their
  results, then closes packs that have `close()` (e.g. Python packs), the media store and the
  context store when they have `close()`. Later calls throw `BriarError("briar.closed")`.
- **MemoryContextStore:** full `ContextStore` contract (storage.md §1) with the same helpers as
  the fs/sqlite stores; `writeRaw(id, text)` for conformance check 13. Documents are stored
  serialized, so loads never share objects.
- **MemoryMediaStore:** storage.md §2; ids `m_` + 24 base62 chars (crypto.getRandomValues),
  never reused; optional `maxBytes` → `media.too_large`; no `resolveUrl`.
- **envSecrets:** `get(name)` → `env[prefix + name]` (default prefix `""`); empty strings count
  as missing (`undefined`).

## 5. Acceptance criteria

1. **Quick start** (test): `createBriar({ packs: [mockPack] })` → `contexts.create` →
   `types.defineEnum` + `types.defineStruct` → `globals.create` → `flows.create` →
   `inputs.add/outputs.add` → `text.template` + `mock.llm` nodes → `connect` → `save` →
   `briar.run(flowId, inputs)` → `succeeded` with the deterministic mock text. The same test
   runs against `FsContextStore` + `FsMediaStore` and `SqliteContextStore`.
2. `applyCommands`: changed batch saves and returns `revision + 1`, `created`, diagnostics;
   stale `baseRevision` → `store.revision_conflict` with `expected/actual`; a rejected
   command → `CommandError` with `details.commandIndex/op`, nothing saved; no-op batch →
   `changed: false`, revision unchanged; unknown context → `context.not_found`.
3. Global writes: a flow with `briar.global.set` persists the value after success (`await
   run.result` then `load` sees it); a concurrent edit between run start and write-back is
   retried; a global deleted / made readonly meanwhile is dropped with a warning and status
   `partial`/`failed`; a failed run writes nothing.
4. `flows.get` / `flows.info` find flows across several contexts; unknown → `flow.not_found`.
5. Runs registry: `runs.get(run.id)` returns the run; `runs.list({ flowId })` filters; retention
   evicts finished runs beyond `maxRuns` and older than `maxAgeMs` (injected clock), never
   running ones.
6. `throwOnInvalid` maps invalid inputs to `run.invalid_inputs` with `details.diagnostics`.
7. Handles: rejected authoring calls throw `CommandError`; `undo/redo`; `save()` conflicts
   throw `RevisionConflictError`; `dirty` flips.
8. `close()` cancels running runs and closes packs/stores; later calls throw `briar.closed`.
9. Python: `createBriar({ packs: [await worker.pack()] })` runs a flow with
   `imaging.uppercase` from the example worker (skipped without `python/.venv`).

## 6. Notes for the tester

- Use `createSequentialIdGenerator()` and a fixed or stepping clock; pass both to `createBriar`.
- Prefer `mockPack` from `@briarflow/nodes-mock` for AI-like nodes; `stdPack` is added
  automatically.
- `MemoryContextStore.writeRaw` exists for `describeContextStore` check 13;
  `MemoryMediaStore` is **not** content-addressed.
- Global write-back is observable only through the store (`store.load`) and
  `run.globalWriteStatus`; the engine-level `RunResult.globalWrites` is unchanged.
- Facade internal tests live in `packages/briarflow/test/internal/` (backend); public suites in
  `packages/briarflow/test/*.test.ts` are yours.
