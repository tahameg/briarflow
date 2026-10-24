# Spec: Runtime

Status: draft v1 (phase 0). Owner: ux-designer. Implemented in `@briarflow/runtime`
(phase 3). Variable semantics: `variables.md`. Node API: `node-api.md`.

## Deviations from ARCHITECTURE.md

1. **Extra event fields and one extra event.** Every `RunEvent` carries `runId` and `seq`
   (0-based, gap-free, per run) so that streams can be resumed (`Last-Event-ID`). A new event
   `node.retrying` reports retries. `node.completed` events for cache hits are preceded by
   `node.started` like any other.
2. **`RunResult` gains `runId`, `flowId`, `contextId`, `contextRevision`.** Needed by REST and
   the run registry.
3. **`SerializedError` gains optional `nodeId`, `retryable`, `cause`** (compatible with
   `packages/core/src/errors.ts`, which has `code`, `message`, `details`).
4. **`events(options?)`** takes `{ after?: number }` (resume after a `seq`).

---

## 1. Engine API

```ts
const engine = createEngine({
  catalog, media, secrets,
  logger?,                         // default: no-op
  cache?: RunCache,                // default: createMemoryCache({ maxEntries: 500 })
  concurrency?: number,            // nodes running at once across all runs; default 8
  maxConcurrentRuns?: number,      // runs in "running" state; default 16; more are "queued"
  clock?: () => Date, idGenerator?: (prefix: string) => string, random?: () => number,
  fetch?: typeof fetch,            // given to nodes as ctx.fetch
  cancelGraceMs?: number,          // default 5000
});

const run = engine.run({
  context: doc, flowId, inputs,
  signal?: AbortSignal,            // aborting it = run.cancel()
  useCache?: boolean,              // default true; false = neither read nor write the cache
  timeoutMs?: number,              // whole-run timeout; default none
  runId?: string,                  // default idGenerator("run")
});
```

`engine.run` never throws for user errors; problems end in a failed `RunResult`. It throws
only for programmer errors with `BriarError("run.invalid_call")`: no options object, missing
`context`, missing `flowId`, or `timeoutMs` that is not a number `> 0`. Messages name the
option, e.g. `engine.run needs the id of the flow to run in options.flowId.`,
`engine.run: timeoutMs must be a number > 0 (got -1).`

`createEngine` throws `BriarError("engine.invalid_options")` for missing `catalog`/`media`/
`secrets` (`createEngine needs { catalog, media, secrets }.`), a `concurrency` or
`maxConcurrentRuns` that is not a whole number `>= 1`
(`createEngine: concurrency must be a whole number >= 1 (got 0).`), or a `cancelGraceMs` that
is not a number `>= 0`.

**Type lookup.** Every `ExecContext` the engine creates also has
`resolveType(id: string): TypeDecl | undefined` (local → global → pack, in the node's flow
scope). Until it is part of core's `ExecContext` (REQ-6, lead), the runtime exports the type
`EngineExecContext = ExecContext & { resolveType }`. See node-api.md §6.

## 2. Run lifecycle

```
          ┌────────┐ slot free ┌─────────┐ all nodes settled, output node completed ┌───────────┐
 create ─▶│ queued │──────────▶│ running │──────────────────────────────────────────▶│ succeeded │
          └───┬────┘           └────┬────┘                                            └───────────┘
              │ cancel()            │ any node failed (after retries) / validation
              │                     │ error / input error / run timeout            ┌───────────┐
              │                     ├─────────────────────────────────────────────▶│  failed   │
              │                     │ cancel() / signal aborted                     └───────────┘
              │                     ▼                                               ┌───────────┐
              └────────────────────────────────────────────────────────────────────▶│ cancelled │
                                                                                    └───────────┘
```

- Terminal states never change. `cancel()` on a terminal run is a no-op.
- `status` getter reflects the state synchronously.
- `result` resolves exactly once, at the same time as the `run.completed` event is emitted;
  it never rejects.

### 2.1 Start sequence (in `running`)

1. Emit `run.started`.
2. Find the flow. Unknown `flowId` → `failed`, `run.invalid_flow`, message
   `Flow "{flowId}" does not exist in context "{context name}". Check the flow id.`,
   `details.diagnostics` = one error diagnostic with code `flow.not_found` (`path: { flowId }`).
   An unknown flow is a user error (the id usually comes from a request), not a programmer
   error, so it does not throw.
3. `validateFlow` (including variable ordering). Errors → `failed` with
   `error = { code: "run.invalid_flow", message, details: { diagnostics } }` where `message` is
   `Flow "{name}" has 1 error: {message}` for one error and
   `Flow "{name}" has {n} errors. First: {first message}` for n > 1.
   Warnings are ignored. (A dependency cycle that only appears with implicit variable edges is
   reported the same way, as a `flow.cycle` diagnostic with `details.nodes`.)
4. Validate + normalize inputs against the signature (defaults applied; optional inputs
   without default → `null`; unknown keys rejected). Errors → `failed`, `run.invalid_inputs`,
   `details.diagnostics`, message `Flow "{name}" received 1 invalid input: {message}` /
   `Flow "{name}" received {n} invalid inputs. First: {first message}`. Diagnostics: code
   `value.invalid` for an unknown key or a missing required input, otherwise the codes of
   `normalizeValue` (`value.*`, `media.*`); `path.valuePath` = `inputs.<name>…`.
5. Snapshot globals and initialize variables (variables.md §6).
6. Schedule nodes (§3).

When validation fails, no node events are emitted: the stream is `run.started`,
`run.completed`.

## 3. Scheduling

- The **dependency graph** = data edges + implicit variable-ordering edges.
- All nodes of the flow run (also nodes whose outputs are unused).
- A node is **ready** when all its dependencies are `completed`. Ready nodes start in a
  deterministic order: ascending by (topological depth, node id).
- Concurrency: a node starts only if the engine-wide `concurrency` slot count and its node
  type's `concurrency` limit allow it. Waiting nodes keep their ready order; slots are shared
  fairly between runs in FIFO order of becoming ready.
- **Input resolution** per port: edge value → constant → port default → `null` (optional) .
  Then `int` values flowing into `float` ports stay JS numbers (no conversion needed).
- Before `run()`: secrets resolved; **every** input normalized and validated against its
  resolved port type (type bindings applied; struct defaults filled; constraints checked).
  Failure → `node.invalid_input`, not retried, message
  `Node {title} got an invalid input: {first diagnostic message}.`, `details.diagnostics`.
  A port whose type still contains an unbound generic is passed through unchecked.
- After `run()`: every declared output port must be present (omitted optional → `null`);
  outputs normalized and validated against resolved output types; a missing, ill-typed or
  undeclared output → `node.invalid_output`, not retried
  (`Node {title} returned an invalid output: {first diagnostic message}.`).

### 3.1 Engine-executed nodes

`briar.input`, `briar.output` and the four variable nodes (`briar.variable.get/set`,
`briar.global.get/set`) are executed by the engine itself, recognized by node **type** (so
any pack providing these types works, e.g. `briarTestPack`). For these nodes:

- no concurrency slot is taken (engine-wide or per type) and the cache is never used;
- no retries and no node timeout apply; secrets are not resolved;
- events are as for any node: `node.started {attempt: 1}`, then `node.completed`
  (`cached: false`) or `node.failed` (e.g. a Set with an invalid value → `node.invalid_input`).

Completion values:

- `briar.input` → `node.completed.outputs` = the normalized run inputs.
- `briar.output` → `node.completed.outputs` = its resolved inputs (one key per output port of
  the signature); this same object becomes `RunResult.outputs`.
- Get → `{ value }` per variables.md §6; Set → `{ value }` (the validated value).

The `run` functions of nodes-std's variable nodes are only a fallback outside the engine:
Get throws `NodeError("node.failed")` explaining that it only works inside the engine; Set
returns its input.

## 4. Failure, skip, cancellation, timeouts

**Failure.** A node fails when its final attempt fails. Then:
- emit `node.failed` with the error;
- every node that depends on it (directly or transitively, incl. implicit edges) is skipped
  with `node.skipped { reason: "upstream_failed", cause: <failed nodeId> }`, emitted when the
  skip is decided (immediately, in topological order);
- independent nodes keep running; when nothing is left, the run is `failed` with
  `error = { code: "run.node_failed", message: "Node {title} failed: {node message}", nodeId, cause: <node error> }`
  for the **first** failed node (lowest `seq`).

**Cancellation** (`cancel(reason)`, `signal` abort, or run timeout):
1. The run's `AbortController` aborts (every `ctx.signal`).
2. Nodes not yet started → `node.skipped { reason: "cancelled" }` immediately.
3. Running nodes: when they settle, `node.failed` with `node.cancelled` (whatever they
   returned or threw). If they do not settle within `cancelGraceMs`, the engine stops waiting
   and emits `node.failed`/`node.cancelled` for them itself; late results are discarded.
4. Run ends `cancelled` with `error = { code: "run.cancelled", message: reason ?? "The run was cancelled." }`.
   A run timeout ends `failed` with `run.timeout` instead (same steps 1–3).
5. A cancel that arrives while `queued` → straight to `cancelled`, events `run.started` is
   **not** emitted; the stream is just `run.completed`.

**Node timeout.** Per attempt, `timeoutMs` from the definition (default 300 000; `0` = none).
On expiry: the attempt's signal aborts (the node sees `ctx.signal.reason` =
`NodeError("node.timeout")`, message `Node {title} did not finish within {ms} ms.`), and the
attempt counts as failed with `node.timeout` (retryable) **at once**: the engine does not
wait for the node to settle (unlike cancellation, there is no grace period). Its concurrency
slot is released then; a late result or error from that attempt is discarded.
Each attempt gets a fresh child `AbortSignal`.

**Run timeout** message: `The run took longer than {ms} ms and was stopped.` The timer starts
when the run leaves `queued`.

## 5. Retries

```ts
interface RetryPolicy {
  maxAttempts: number;      // total attempts incl. the first; default 1
  initialDelayMs?: number;  // default 500
  factor?: number;          // default 2
  maxDelayMs?: number;      // default 10_000
  jitter?: boolean;         // default true: delay × random in [0.5, 1)
}
```

- `retry: n` (number) = `{ maxAttempts: n + 1 }` with defaults.
- An attempt is retried only if the error is retryable: `NodeError` with `retryable: true`,
  `node.timeout`, or a wrapped network `TypeError` (`node.unavailable`). Never retried:
  `node.invalid_input`, `node.invalid_output`, `node.missing_secret`, `node.cancelled`.
- Delay before attempt `k+1` = `min(maxDelayMs, initialDelayMs × factor^(k-1))`, × jitter; if
  the error has `details.retryAfterMs`, the delay is `max(computed, retryAfterMs)` capped at
  `maxDelayMs × 3`.
- `delayMs` is rounded to a whole number of milliseconds.
- Before waiting, emit `node.retrying { attempt: k, nextAttempt: k+1, delayMs, error }`.
  The concurrency slot is released during the wait. The node counts as started while it
  waits, so cancellation during the wait ends it with `node.failed` / `node.cancelled`
  immediately (not `node.skipped`).

## 6. Cache

- **Key** = lowercase hex sha-256 (via `crypto.subtle`) of the canonical JSON (sorted keys, no
  whitespace) of:
  ```json
  { "v": 1, "nodeType": "...", "pack": "name@version", "cacheVersion": "1",
    "config": { ... }, "typeBindings": { ... }, "inputs": { ... } }
  ```
  where every MediaRef inside `inputs` is replaced by `{ "$media": hash ?? uri }`. Nodes with
  variants add `"variant": "<name>"` (node-api.md §1.2); keys of other nodes are unchanged.
  Node id, title, position, run id and secrets are **not** part of the key.
- Used only when the definition has `cache: true`, the run has `useCache !== false`; never
  for engine-executed nodes (§3.1).
- Lookup happens after inputs are resolved. Hit → `node.started`, `node.completed { cached: true }`;
  `run` is not called.
- Store only successful results whose execution did **not** call `ctx.globals.get` or
  `ctx.variables.get` (the engine tracks access).
- `RunCache` interface: `get(key): Promise<Outputs | undefined>`, `set(key, outputs): Promise<void>`.
  Default: in-memory LRU, 500 entries, shared by all runs of an engine. Cache errors are
  logged and treated as misses.

## 7. Events

```ts
type RunEvent = { runId: string; seq: number; at: string } & (
  | { type: "run.started"; flowId: string; contextId: string }
  | { type: "node.started"; nodeId: string; attempt: number }
  | { type: "node.progress"; nodeId: string; fraction: number; message?: string }
  | { type: "node.retrying"; nodeId: string; attempt: number; nextAttempt: number; delayMs: number; error: SerializedError }
  | { type: "node.completed"; nodeId: string; outputs: Record<string, unknown>; cached: boolean; durationMs: number }
  | { type: "node.failed"; nodeId: string; error: SerializedError }
  | { type: "node.skipped"; nodeId: string; reason: "upstream_failed" | "cancelled"; cause?: string }
  | { type: "run.completed"; result: RunResult }
);
```

**Ordering guarantees** (all tested):

1. `seq` starts at 0 and increases by exactly 1 per event of the run.
2. `run.started` is the first event (except a run cancelled while queued), `run.completed`
   is the last, exactly once.
3. Per node: either `node.skipped` alone, or `node.started (attempt 1)`, then any number of
   `node.progress`, `node.retrying` + `node.started (attempt k)` pairs, then exactly one of
   `node.completed` / `node.failed`.
4. A node's `node.started` comes after `node.completed` of all its dependencies.
5. `at` is from the injected clock and non-decreasing.
6. `node.progress` never follows the node's terminal event.

**Progress throttling** uses real timers (`setTimeout`), not the injected clock (the clock
only stamps `at`): the first report of a node is emitted at once, later ones at most one per
100 ms window (the latest report in a window wins); a pending report is dropped when the
node's terminal event is emitted.

**`events(options?)` replay semantics.**

- Each call returns a fresh `AsyncIterable` that first yields all past events with
  `seq > (options.after ?? -1)`, in order, then live events, and **ends** after
  `run.completed`. Calling it after the run finished yields the full history and ends.
- Any number of independent consumers; a slow consumer never blocks the run (events are
  buffered per run, unbounded in v1 — progress throttling keeps it small).
- Breaking out of `for await` releases the consumer.
- The run keeps its event history as long as the `Run` object is referenced (engine) or
  retained by the registry (facade: last 200 finished runs or 1 hour, whichever first —
  configurable `runRetention: { maxRuns, maxAgeMs }`).

## 8. Results and errors

```ts
interface RunResult {
  runId: string; flowId: string; contextId: string; contextRevision: number;
  status: "succeeded" | "failed" | "cancelled";
  outputs?: Record<string, unknown>;       // succeeded only; every output key present
  variables?: Record<string, unknown>;     // succeeded only; public variables
  globalWrites?: Record<string, unknown>;  // succeeded only; written readwrite globals by name
  error?: SerializedError;                 // failed / cancelled only
  startedAt: string; finishedAt: string;   // ISO; startedAt = when it left "queued"
}

interface SerializedError {
  code: string;
  message: string;
  details?: unknown;           // JSON
  nodeId?: string;             // for node errors
  retryable?: boolean;
  cause?: SerializedError;     // one level of wrapping is typical (run.node_failed → node error)
}
```

- `stack` is never serialized. Non-`BriarError` causes are serialized as
  `{ code: "internal", message: err.message }`.
- Run-level codes: `run.invalid_flow`, `run.invalid_inputs`, `run.node_failed`,
  `run.cancelled`, `run.timeout`, `run.internal` (engine bug; message
  `The engine hit an internal error: {msg}. Please report this as a Briarflow bug.`, the
  thrown error serialized as `cause`).
- A run cancelled while queued has `startedAt === finishedAt`.

Example (failed):
```json
{ "runId": "run_7", "flowId": "flow_p", "contextId": "ctx_1", "contextRevision": 12, "status": "failed",
  "error": { "code": "run.node_failed", "message": "Node Generate image failed: ACME answered 400: bad prompt",
             "nodeId": "n_img", "cause": { "code": "acme.request_failed", "message": "ACME answered 400: bad prompt", "nodeId": "n_img", "retryable": false } },
  "startedAt": "2026-10-21T10:00:00.000Z", "finishedAt": "2026-10-21T10:00:03.120Z" }
```
