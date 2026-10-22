# Phase 3 — `@briarflow/runtime`, `@briarflow/nodes-std`, `@briarflow/nodes-mock`

Status: **reviewed and accepted by lead-developer (2026-10-21)**. Written by
backend-developer (the orchestrator started phase 3 before the lead wrote this file); review
notes in §7. This is the contract the tester writes suites against. Specs: `docs/specs/runtime.md`, `variables.md`, `node-api.md` §6, §9,
§10, `types.md`. Decisions: `docs/DECISIONS.md` #15, #19, #23, #24.

## 1. Goal

Execute flows: a deterministic, cancellable, concurrency-limited engine with retries,
timeouts, caching, replayable events and variable/global semantics; the standard node pack
(`briar`, namespaces `text`, `list`, `convert`); and the deterministic offline mock pack
(`mock`) used by tests and demos.

**Exit check:** `npm run typecheck` and `npm test` green; the phase exit test runs end to end:
a context with a `Character` struct input → `briar.struct.break` → `text.template` →
`mock.llm` → `mock.image` → output, with an in-memory `MediaStore`.

All three are **shared packages**: no `node:*`, no Node-only dependencies. Only web-standard
primitives (`Promise`, `AbortController`, `setTimeout`, `crypto.subtle`, `fetch`,
`ReadableStream`, `TextEncoder`, `btoa`).

## 2. Public API

### 2.1 `@briarflow/runtime`

```ts
/** Creates an execution engine. One engine is shared by many runs. */
export function createEngine(options: EngineOptions): Engine;

export interface EngineOptions {
  catalog: NodeCatalog;
  media: MediaStore;
  secrets: SecretResolver;
  logger?: Logger;                       // default noopLogger
  cache?: RunCache;                      // default createMemoryCache({ maxEntries: 500 })
  concurrency?: number;                  // node slots across all runs, default 8
  maxConcurrentRuns?: number;            // runs in "running", default 16; more are "queued"
  clock?: () => Date;                    // default () => new Date()
  idGenerator?: (prefix: string) => string;  // default createIdGenerator()
  random?: () => number;                 // retry jitter, default Math.random
  fetch?: typeof fetch;                  // ctx.fetch, default globalThis.fetch
  cancelGraceMs?: number;                // default 5000
}

export interface Engine {
  readonly catalog: NodeCatalog;
  /** Never throws for user errors (they end in a failed RunResult); throws
   *  BriarError("run.invalid_call") for programmer errors (missing context/flowId). */
  run(options: RunOptions): Run;        // Run from @briarflow/core
}

export interface RunOptions {
  context: ContextDocument;
  flowId: string;
  inputs?: Record<string, unknown>;      // default {}
  signal?: AbortSignal;                  // abort = run.cancel()
  useCache?: boolean;                    // default true
  timeoutMs?: number;                    // whole-run timeout (from leaving "queued")
  runId?: string;                        // default idGenerator("run")
}

/** Node result cache (runtime.md §6). Errors are logged and treated as misses. */
export interface RunCache {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, outputs: Record<string, unknown>): Promise<void>;
}
export interface MemoryCache extends RunCache { readonly size: number; clear(): void }
export function createMemoryCache(options?: { maxEntries?: number }): MemoryCache; // LRU, default 500

/** Cache key of runtime.md §6 (sha-256 hex of canonical JSON). Exported for tools/tests. */
export interface CacheKeyInput {
  nodeType: string; pack: string /* "name@version" */; cacheVersion: string;
  config: Record<string, unknown>; typeBindings: Record<string, TypeRef>;
  inputs: Record<string, unknown>;       // MediaRefs already replaced by { $media }
}
export function computeCacheKey(input: CacheKeyInput): Promise<string>;

export const PACKAGE_NAME = "@briarflow/runtime";
```

`Run`, `RunEvent`, `RunResult`, `RunStatus` are the core types (core `run/types.ts`); the
package re-exports them as types for convenience.

### 2.2 `@briarflow/nodes-std`

```ts
export const stdPack: NodePack;                 // name "briar", version "1.0.0",
                                                // namespaces ["briar", "text", "list", "convert"]
export const RoundingMode: EnumType<"round" | "floor" | "ceil" | "trunc">;  // briar.RoundingMode
// Node definitions (all in stdPack.nodes):
export const variableGet, variableSet, globalGet, globalSet,   // briar.variable.* / briar.global.*
  structMake, structBreak, constant,                           // briar.struct.make/break, briar.constant
  textTemplate, textJoin,                                      // text.template, text.join
  listMake, listLength, listGet,                               // list.*
  convertToText, convertParseInt, convertParseFloat, convertFloatToInt; // convert.* (REQ-11: no global shadowing)
/** toText rules (node-api.md §9). `type` (optional) disambiguates media vs struct. */
export function valueToText(value: unknown, type?: TypeRef): string;
/** Placeholders of a template in order of first appearance, or a PortError. */
export function templatePlaceholders(template: string): string[] | PortError;
/** Renders a template: `{name}` → valueToText(values[name]); `{{`/`}}` → literal braces. */
export function renderTemplate(template: string, values: Readonly<Record<string, unknown>>, types?: Readonly<Record<string, TypeRef>>): string;
export const PACKAGE_NAME = "@briarflow/nodes-std";
```

`briar.input` / `briar.output` are **not** in this pack (DECISIONS #23). The four variable
nodes are executed by the engine itself (their `run` only works inside the engine: outside it,
`get` throws `NodeError("node.failed")` explaining that, `set` passes the value through).

### 2.3 `@briarflow/nodes-mock`

```ts
export const mockPack: NodePack;   // name "mock", version "0.1.0"
export const mockLlm, mockStructured, mockImage, mockModel3d, mockDelay, mockFlaky, mockFail;
/** hash(x) of node-api.md §10: sha-256 hex of the UTF-8 canonical JSON of x. */
export function mockHash(value: unknown): Promise<string>;
export const PACKAGE_NAME = "@briarflow/nodes-mock";
```

## 3. Tasks

### Backend developer
1. runtime: engine, run lifecycle, scheduling, built-ins, variables, cache, retries, timeouts,
   cancellation, events, results (runtime.md, variables.md §6–§8).
2. nodes-std: every node of node-api.md §9 except the core built-ins.
3. nodes-mock: every node of node-api.md §10.
4. Internal tests in `packages/{runtime,nodes-std,nodes-mock}/test/internal/`, including the
   exit test (`packages/runtime/test/internal/exit.test.ts`).

### Tester
Suites in `packages/runtime/test/`, `packages/nodes-std/test/`, `packages/nodes-mock/test/`
against §2 and §4; `runNode` in `@briarflow/testing` (node-api.md §6) may wrap
`createEngine` with a one-node flow or call `run` directly with a fake `ExecContext`.

### Lead
Review this file; decide REQ entries filed in `docs/tasks/requests.md` for phase 3.

## 4. Acceptance criteria

### 4.1 Lifecycle and start (runtime.md §1–§2)
- `engine.run` returns synchronously with `status === "queued"`; the run starts on a microtask
  when a run slot is free (`maxConcurrentRuns`), FIFO.
- Missing `context` / `flowId` → throws `BriarError("run.invalid_call")`.
- Unknown flow id → `failed`, `run.invalid_flow` (`details.diagnostics` has one
  `flow.not_found` diagnostic).
- Validation errors → `failed`, `run.invalid_flow`, message
  `Flow "{name}" has {n} errors. First: {first message}`, `details.diagnostics`; stream is
  exactly `run.started`, `run.completed`. Warnings ignored.
- Input errors (unknown key, missing required without default, wrong type/constraint) →
  `run.invalid_inputs`, `details.diagnostics` (codes `value.invalid` / `media.*`, `valuePath`
  `inputs.<name>…`). Defaults applied; optional inputs default to `null`.
- `result` resolves once, together with `run.completed`, and never rejects. Terminal state
  never changes; `cancel()` after it is a no-op.

### 4.2 Scheduling (runtime.md §3)
- Dependencies = data edges + `computeVariableOrder(...).implicitEdges`. Every node runs.
- Ready nodes start in (topological depth, node id) order; depth = longest path from a node
  without dependencies.
- Engine-wide `concurrency` and per-type `concurrency` hold across runs; waiting nodes start
  FIFO in order of becoming ready. Built-ins and the four variable nodes run inline (no slot).
- Input resolution: edge → constant (`node.values`) → port default → `null` (optional).
  Inputs are normalized/validated against the resolved port types (bound generics); failure →
  `node.invalid_input` (not retried). Ports with unbound generics are not checked.
- Outputs: every declared port; omitted optional → `null`; missing / ill-typed / undeclared →
  `node.invalid_output` (not retried).
- `briar.input` completes with the normalized inputs; `briar.output` completes with its
  resolved inputs (its `node.completed.outputs`), which become `RunResult.outputs`.

### 4.3 Failure, skip, cancellation, timeouts (runtime.md §4)
- Failure: `node.failed`; every transitive dependent (incl. implicit edges) gets
  `node.skipped {reason:"upstream_failed", cause}` immediately, in (depth, id) order;
  independent branches finish; result `run.node_failed` for the first failed node
  (`message: "Node {title} failed: {msg}"`, `nodeId`, `cause` = the node error with `nodeId`).
- Cancel (`cancel(reason)`, `signal`, run timeout): not-started nodes skipped `cancelled`;
  running nodes end `node.failed`/`node.cancelled` when they settle or after `cancelGraceMs`
  (late results discarded); nodes waiting for a retry end cancelled. Result `run.cancelled`
  (message = reason or "The run was cancelled.") or, for the run timeout, `failed` with
  `run.timeout`. Cancel while queued: stream is only `run.completed`,
  `startedAt === finishedAt`.
- Node timeout per attempt (`timeoutMs`, 0 = none): the attempt signal aborts with reason
  `NodeError("node.timeout")`; the attempt fails `node.timeout` (retryable) without waiting
  for the node to settle.

### 4.4 Retries (runtime.md §5)
- Retryable: `NodeError.retryable`, `node.timeout`, `TypeError` thrown by `ctx.fetch`
  (wrapped as `node.unavailable`). Never: `node.invalid_input`, `node.invalid_output`,
  `node.missing_secret`, `node.cancelled`. Other exceptions → `node.failed` (message kept).
- Delay before attempt k+1 = `min(maxDelayMs, initialDelayMs × factor^(k-1))`, × `0.5 +
  random()/2` when `jitter`; `details.retryAfterMs` → `max(delay, retryAfterMs)` capped at
  `maxDelayMs × 3`. `node.retrying` precedes the wait; the slot is released during the wait;
  the next attempt emits `node.started {attempt: k+1}`.

### 4.5 Cache (runtime.md §6)
- Key = sha-256 hex of canonical JSON `{v:1,nodeType,pack:"name@version",cacheVersion,config,
  typeBindings,inputs}`; MediaRefs in inputs → `{ $media: hash ?? uri }`. Node id, title,
  position, run id and secrets are not part of it.
- Only for `cache: true` definitions and `useCache !== false`; built-ins and variable nodes
  never. Hit → `node.started`, `node.completed {cached: true}`, `run` not called.
- Not stored when the execution called `ctx.globals.get` / `ctx.variables.get`, or failed.
- Cache errors are logged (`warn`) and treated as misses.

### 4.6 Events (runtime.md §7)
- All six ordering guarantees; `seq` gap-free from 0; `at` from the clock, non-decreasing.
- `events({after})` replays then follows live, ends after `run.completed`; independent
  consumers; `break` releases the consumer.
- Progress: clamped to [0,1], NaN ignored, message ≤ 200 chars, at most one event per 100 ms
  per node (latest wins), none after the node's terminal event.

### 4.7 Variables and globals (variables.md §6–§8)
- Get reads the value of the writer given by `computeVariableOrder(...).plans[].reads`, else
  the starting value (globals snapshot; variable default, `null` for optional, `[]` for list).
- Set validates against the variable type (`node.invalid_input`) and passes the value through.
- `ctx.globals.get(name)` / `ctx.variables.get(name)` return run-start values; unknown name →
  `NodeError("variable.unknown")`.
- `RunResult.variables` (succeeded only): every public variable's final value (unset omitted).
  `RunResult.globalWrites` (succeeded only): every global with at least one executed writer.

### 4.8 ExecContext (node-api.md §6)
- `signal`, `runId`, `flowId`, `nodeId`, `attempt`, `progress`, `log` (adds `runId`,
  `nodeId`), `media`, `secrets` (declared only; resolved before the first attempt; missing →
  `node.missing_secret` with the spec message; undeclared → `node.secret_not_declared`),
  `globals`, `variables`, `fetch` (engine `fetch`; `signal` defaulted to `ctx.signal`).

### 4.9 nodes-std (node-api.md §9)
- Every node in the §9 table except `briar.input`/`briar.output`; ports exactly as specified
  (dynamic via `resolvePorts`); pack type `briar.RoundingMode`.
- `text.template`: one generic port per distinct placeholder in order of first appearance,
  type vars `T1…Tn`; `{{`/`}}` literal; invalid placeholder / unclosed brace → `PortError`
  (`text.invalid_placeholder` / `text.invalid_template`); values rendered with toText rules.
- toText: text as is; numbers `String()`; booleans; enum member value; `null` → `""`; media →
  `uri`; struct/list → canonical JSON.
- `list.get`: negative index from the end; out of range → `null`. `convert.parseInt` /
  `parseFloat`: trimmed, strict; invalid → `convert.invalid_number`. `convert.floatToInt`:
  `round` is half away from zero.

### 4.10 nodes-mock (node-api.md §10)
- Every node in the §10 table with the exact output formulas; deterministic for equal inputs;
  `mock.image` / `mock.model3d` / media in `mock.structured` stored through `ctx.media.put`.
- `mock.delay` and `mock.llm` honour `ctx.signal`; `mock.delay` reports progress.
- `mock.flaky` fails attempts `1…failures` with retryable `node.unavailable` (`retry: 3`).

## 5. Notes for the tester
- Use `createSequentialIdGenerator()`, a fixed or stepping `clock`, and `random: () => 0.5`
  for deterministic retry delays; `vi.useFakeTimers()` works (the engine only uses
  `setTimeout`/`clearTimeout` and microtasks).
- `briarTestPack` from `@briarflow/testing` also works with the engine (variable nodes are
  executed by type), but prefer `stdPack` + `mockPack` now.
- The facade's `MemoryMediaStore` arrives in phase 4; use `memoryMediaStore()` from
  `@briarflow/testing` or an in-test store.
- `mock.structured` needs type declarations at run time; see REQ-6 (`ctx.resolveType`).

## 6. Implementation notes and deviations for the lead to review (backend-developer)

1. **`ctx.resolveType(id)`**: the engine adds it to every `ExecContext` (REQ-6); needed by
   `mock.structured`. Exported type `EngineExecContext`.
2. **Inline nodes.** `briar.input`, `briar.output` and the four variable nodes are executed by
   the engine itself, by node type (works with `briarTestPack` too). They take no concurrency
   slot and are never cached. nodes-std's `briar.variable.get` / `briar.global.get` `run` throws
   `node.failed` outside the engine; the `set` nodes pass the value through.
3. **`briar.output`'s `node.completed.outputs`** carries its resolved inputs (= `RunResult.outputs`).
4. **Codes and messages chosen where the spec is silent:** unknown flow id → `run.invalid_flow`
   with one `flow.not_found` diagnostic; `run.invalid_inputs` message
   `Flow "{name}" received {n} invalid inputs. First: {msg}`; input diagnostics use
   `value.invalid` (unknown key, missing required) plus core's `normalizeValue` codes;
   `run.timeout` message `The run took longer than {ms} ms and was stopped.`; `run.internal`
   carries the thrown error as `cause`. `createEngine` throws `engine.invalid_options` for a
   bad `concurrency` / `maxConcurrentRuns` / `cancelGraceMs`; `engine.run` also rejects
   `timeoutMs <= 0` with `run.invalid_call`.
5. **Node timeout** does not wait for the node to settle (it fails the attempt at once; a late
   result is discarded). Its slot is released then.
6. **Retry delays** are rounded to whole ms. During a retry wait the node is "started", so a
   cancel ends it with `node.failed`/`node.cancelled` (not `node.skipped`).
7. **Input checks** normalize/validate every input (not only constrained ones); this also fills
   struct defaults. Ports whose type still has an unbound generic are not checked.
8. **Progress throttle** uses timers (not the injected clock): first report is emitted at once,
   then at most one per 100 ms window (latest wins), pending ones are dropped at the node's
   terminal event.
9. `mock.structured` media fields: `image`/`file` → SVG, `model3d` → glTF cube, `audio` → a
   silent WAV, `video` → `mock.unsupported_type` (no cheap fake). `mock.image` colors use
   `hash({prompt, seed})`.

## 7. Lead review (2026-10-21)

All deviations in §6 are **accepted** as written. `EngineExecContext` stays a deprecated alias
of core `ExecContext` until phase 5, then is removed (REQ-12). REQ-9, REQ-10 and REQ-11 are
implemented (singular/plural messages, cycle wording with titles; optional video → `null`,
`mock.no_type_lookup`; `convert*` export names).

Checked: shared-package boundaries (no `node:*` in runtime / nodes-std / nodes-mock;
`check-boundaries` green), public names, error codes against runtime.md / node-api.md,
determinism (ids, clock and jitter injectable; progress throttle uses timers, documented in
§6.8), tests (≈105 internal cases incl. the exit test, fake timers for retries).

Trivial fixes made by the lead:
- `nodes-std` / `nodes-mock`: removed the `as unknown as readonly AnyNodeDefinition[]` casts
  in `definePack({ nodes })` (typed definitions are assignable; the cast hid real errors).
- `runtime/src/values.ts`: uses core's `containsVar` instead of a private copy.

Follow-ups filed: REQ-14 (runtime: validate cache hits, duplicate run ids), REQ-15 (storage
id errors). Tester: public suites for runtime / nodes-std / nodes-mock are still missing
(only smoke tests in `packages/*/test/`), and `runNode` is not yet exported from
`@briarflow/testing`.

