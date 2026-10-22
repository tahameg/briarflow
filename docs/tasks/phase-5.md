# Phase 5 — `@briarflow/server` and client ⇄ server integration

Owner: backend-developer (`@briarflow/server`, `apps/server`); frontend-developer (client
alignment, studio wiring); tester (integration suites). Lead reviews. Written by
lead-developer, 2026-10-21.

Specs: `docs/specs/rest-api.md` (authoritative for paths, bodies, status codes, SSE),
`docs/specs/runtime.md` §7 (events), `docs/specs/storage.md` §2 (media). Facade contract:
`docs/tasks/phase-4.md` (the server only calls the facade; it never touches the engine or
authoring directly). Decisions: DECISIONS #27 (`UnauthorizedError`, `briarError` live here).

## 1. Goal

A thin HTTP layer over the `briarflow` facade: `createBriarApp(briar, options)` returns a Hono
app with the REST + SSE API of rest-api.md, and `serve(app, { port })` runs it on Node. The
real `@briarflow/client` talks to it unchanged.

**Exit check:** `npm run typecheck` and `npm test` green; the integration suite (§6, tester)
runs the real client against a real server on an ephemeral port: create context → commands →
run with SSE → result → media upload/download, plus every error class of the client.

## 2. Package layout (`packages/server`)

| Path | Contents |
|---|---|
| `package.json` | name `@briarflow/server`; deps `@briarflow/core`, `@briarflow/authoring` (for `CommandError` instanceof), `briarflow`, `hono@^4`, `@hono/node-server@^1` |
| `src/index.ts` | public surface (§3) |
| `src/app.ts` | `createBriarApp`, route wiring, CORS, not-found handler, `onError` |
| `src/errors.ts` | `UnauthorizedError`, `briarError`, `errorStatus`, request error helpers |
| `src/authorize.ts` | `AuthorizeRequest`, `AuthorizeAction`, the per-route resolve → authorize step |
| `src/routes/*.ts` | `contexts.ts`, `flows.ts`, `runs.ts`, `node-types.ts`, `media.ts` |
| `src/sse.ts` | event-stream writer (§4.4) |
| `src/body.ts` | JSON body reading with `maxBodyBytes`, upload stream limiter |
| `src/serve.ts` | `serve` (Node, dynamic import of `@hono/node-server`) |

**Portability:** nothing under `src/` imports `node:*` or `@hono/node-server` statically.
`serve.ts` loads `@hono/node-server` with `await import(...)`, so `createBriarApp` runs on
Bun, Deno and workers (`app.fetch`). Use only web `Request`/`Response`/`ReadableStream`.
`hono` is the only HTTP dependency (its `cors`, `streamSSE` / `stream` helpers are fine).

Root config: `tsconfig.base.json` `paths` already map `@briarflow/*`; no root change needed
except `npm install` adding the new workspace (backend runs
`npm install -w @briarflow/server hono @hono/node-server`).

## 3. Public API

```ts
import type { Context, Env, Hono } from "hono";
import type { Briar } from "briarflow";
import type { BriarError, Logger } from "@briarflow/core";

/** Options of {@link createBriarApp}. Every field is optional. */
export interface BriarAppOptions<E extends Env = Env> {
  /** Prefix of every built-in route. Default "/api/v1". "" mounts at the root. */
  basePath?: string;
  /**
   * CORS. Default `{ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }` (the studio
   * dev server, REQ-7). `false` sends no CORS headers (same-origin deployments).
   */
  cors?: false | BriarCorsOptions;
  /** Called once per request after id resolution (§4.2). Default: everything allowed. */
  authorize?: (req: AuthorizeRequest<E>) => boolean | Promise<boolean>;
  /** JSON body limit in bytes → 413 `request.too_large`. Default 5 * 1024 * 1024. */
  maxBodyBytes?: number;
  /** Media upload limit in bytes → 413 `media.too_large`. Default 50 * 1024 * 1024. */
  maxUploadBytes?: number;
  /** SSE keep-alive comment interval. Default 15 000 ms (tests use less). */
  pingIntervalMs?: number;
  /** Server-side log of 500s and dropped streams. Default `noopLogger`. */
  logger?: Logger;
}

export interface BriarCorsOptions {
  origin: string | readonly string[] | ((origin: string) => boolean);
  /** Default false. */
  credentials?: boolean;
}

export type AuthorizeAction =
  | "contexts.list" | "contexts.create" | "contexts.read" | "contexts.delete" | "contexts.edit"
  | "flows.read" | "flows.run"
  | "runs.read" | "runs.cancel"
  | "nodeTypes.read" | "media.upload" | "media.read";

export interface AuthorizeRequest<E extends Env = Env> {
  action: AuthorizeAction;
  /** Resolved ids: flowId → contextId (locateFlow), runId → flowId + contextId (registry). */
  resource: { contextId?: string; flowId?: string; runId?: string; mediaId?: string };
  /** The standard Fetch Request (headers, url). */
  request: Request;
  /** Escape hatch, e.g. `c.get("user")` set by your middleware. */
  c: Context<E>;
}

/**
 * Builds the REST + SSE API over a facade instance. Returns a normal Hono app: add routes to
 * it or mount it in your own app.
 *
 * @example
 * ```ts
 * const briar = createBriar({ packs: [mockPack] });
 * const app = createBriarApp(briar, { authorize: ({ c }) => Boolean(c.get("user")) });
 * const server = await serve(app, { port: 3000 });
 * ```
 */
export function createBriarApp<E extends Env = Env>(briar: Briar, options?: BriarAppOptions<E>): Hono<E>;

/**
 * Throw from `authorize` (or a custom route) to answer 401 `auth.unauthorized`.
 * Default message: "Sign in to use this API."
 */
export class UnauthorizedError extends BriarError {
  constructor(message?: string, options?: BriarErrorOptions);   // code "auth.unauthorized"
}

/**
 * Answers with the standard error body and the status of {@link errorStatus}. Non-Briar
 * errors (and Briar errors mapped to 500 other than `store.corrupt`) become
 * `500 { code: "internal", message: "Something went wrong on the server. …" }`; the original
 * is logged, never sent.
 *
 * @example
 * ```ts
 * app.post("/api/v1/portraits", async (c) => {
 *   try { … } catch (err) { return briarError(c, err); }
 * });
 * ```
 */
export function briarError(c: Context, err: unknown): Response;

/** HTTP status for an error (§4.1). Exported for custom routes and tests. */
export function errorStatus(err: unknown): number;

/** Options of {@link serve}. */
export interface ServeOptions {
  /** Default 3000. `0` picks a free port (tests). */
  port?: number;
  /** Default "127.0.0.1" (local only); "0.0.0.0" to listen on all interfaces. */
  hostname?: string;
}

/** A running Node HTTP server. */
export interface BriarServer {
  readonly port: number;
  /** e.g. "http://127.0.0.1:41234" (no base path). */
  readonly url: string;
  /** Stops accepting connections, ends open SSE streams, resolves when closed. Idempotent. */
  close(): Promise<void>;
}

/**
 * Serves a Hono app on Node (`@hono/node-server`, loaded lazily). Resolves once listening.
 *
 * @example
 * ```ts
 * const server = await serve(app, { port: 0 });
 * const client = createBriarClient({ baseUrl: `${server.url}/api/v1` });
 * ```
 */
export function serve(app: { fetch: (request: Request) => Response | Promise<Response> }, options?: ServeOptions): Promise<BriarServer>;

export const PACKAGE_NAME = "@briarflow/server";
```

Note: rest-api.md §6 shows `serve(app, { port: 3000 })` without `await`; that still works (the
promise is simply not awaited). `hostname` default `127.0.0.1` matches the "local use unless an
`authorize` hook is configured" stance; `apps/server` passes `0.0.0.0` when `HOST` says so.

## 4. Behaviour

### 4.1 Errors → status (rest-api.md §1)

Every non-2xx body is `{ "error": { "code", "message", "details"? } }` (no `cause`, no stack).
`errorStatus(err)`:

| Status | Rule |
|---|---|
| 400 | codes `request.*` (except `request.too_large`), `store.invalid_cursor`, `store.invalid_query`, `document.invalid_id`, `document.invalid_name` |
| 401 | `auth.unauthorized` (`UnauthorizedError`) |
| 403 | `auth.forbidden` |
| 404 | any code ending in `.not_found` (`context`, `flow`, `run`, `media`, `route`) |
| 409 | `store.revision_conflict`, `store.flow_id_conflict`, `context.exists` |
| 413 | `media.too_large`, `request.too_large` |
| 415 | `media.invalid_mime` |
| 422 | **any `CommandError`** from `@briarflow/authoring` (whatever its code: `command.*`, `type.*`, `edge.*`, …) — body is `err.toJSON()` minus `cause`, so `details.commandIndex` / `details.op` are kept; `run.invalid_inputs`, `run.invalid_flow` |
| 503 | `briar.closed` (the facade is shutting down) |
| 500 | everything else. `store.corrupt` keeps its code and message (actionable, no secrets); all others become `internal` with a generic message, logged with `logger.error("http.internal_error", { method, path, error: serializeError(err) })` |

`CommandError` detection: `err instanceof CommandError` (import the class from
`@briarflow/authoring`); fall back to `err.name === "CommandError"` for duplicated module
instances. `hono`'s `app.onError` uses `briarError`; `app.notFound` answers
`404 route.not_found` ("No route for GET /api/v1/foo. See docs/specs/rest-api.md.").

Request-validation errors are `BriarError("request.invalid_body", message, { details: [{ path, problem }] })`
with `path` like `"commands"` / `"baseRevision"` / `"name"` and `problem` a short sentence.

### 4.2 Request pipeline (every built-in route)

1. **Path ids** checked with core `isValidId` (`contextId` → `"context"`, `flowId` → `"flow"`,
   `runId` → `"run"`); media ids with `^[A-Za-z0-9_-]{1,128}$`. Bad → `400 request.invalid_id`
   (`details: { param, value }`).
2. **Resolve**: `contextId` must exist (`store.load` for read/delete/edit; the loaded doc is
   reused by the handler where possible); `flowId` → `briar.flows.locate`; `runId` →
   `briar.runs.get`; `mediaId` → `briar.media.get` (body cancelled when not used). Unknown →
   404 **before** `authorize` (documented trade-off, rest-api.md §5).
3. **Authorize** with the action of the route and the resolved resource. `false` →
   `403 auth.forbidden` ("You are not allowed to {action}."); thrown `UnauthorizedError` →
   401; any other throw → 500.
4. **Body / query** parsed and validated (400 / 413 / 415), then the facade call.

Actions: GET `/contexts` `contexts.list`; POST `/contexts` `contexts.create`; GET context and
`/diagnostics` `contexts.read`; DELETE `contexts.delete`; POST `/commands` `contexts.edit`;
GET `/flows/:id` `flows.read`; POST runs `flows.run`; GET run / events `runs.read`; POST
cancel `runs.cancel`; GET `/node-types` `nodeTypes.read`; POST `/media` `media.upload`; GET
`/media/:id` `media.read` (resource `{ mediaId }` only).

JSON bodies: read as text with the `maxBodyBytes` limit (check `Content-Length` first, then
count while reading) → `413 request.too_large`; empty or unparsable → `400 request.invalid_json`
(except the optional body of `cancel`, where empty = `{}`). `Content-Type` is not enforced.

### 4.3 Endpoints (facade calls)

| Route | Facade | Success |
|---|---|---|
| GET `/contexts?limit&cursor&search` | `briar.contexts.list({ limit, cursor, search })` | `200 { items, nextCursor? }`; `limit` must be an integer ≥ 1 (string → number) else `400 request.invalid_query`; > 200 clamped |
| POST `/contexts` | body `{ name, description?, id? }` validated (name string, 1–120 chars after trim; description string; id `isValidId("context")`) → `briar.contexts.create(...)` | `201` the handle's `doc`, `Location: {basePath}/contexts/{id}` |
| GET `/contexts/:id` | `briar.store.load` | `200` doc, `ETag: "<revision>"` |
| DELETE `/contexts/:id` | `briar.contexts.delete` | `204` |
| POST `/contexts/:id/commands` | body `{ baseRevision: int ≥ 0, commands: non-empty array ≤ 1000 }` → `briar.applyCommands(id, body)` | `200 { revision, changed, created, diagnostics }` (drop `doc`) |
| GET `/contexts/:id/diagnostics` | `briar.diagnostics(id)` | `200 { revision, diagnostics }` |
| GET `/flows/:flowId` | `briar.flows.info` | `200 { contextId, revision, flow, signature }` |
| POST `/flows/:flowId/runs?wait&waitMs` | body `{ inputs?: object, useCache?: boolean }` → `briar.run(flowId, inputs, { useCache, throwOnInvalid: true })` | see below |
| GET `/runs/:runId` | `run.info()` | `200 RunInfo` (`{ runId, flowId, contextId, status, createdAt, result?, globalWriteStatus? }`) |
| GET `/runs/:runId/events` | `run.events({ after })` | SSE (§4.4) |
| POST `/runs/:runId/cancel` | body `{ reason?: string }` | terminal → `200 { runId, status }`; else `run.cancel(reason)` → `202 { runId, status: run.status }` |
| GET `/node-types` | `briar.nodeTypes()` | `200 { packs, nodes, types }`, `ETag` = `"` + sha-256 hex of `canonicalJson(body)` + `"` (computed once; the catalog is immutable); `If-None-Match` equal → `304` |
| POST `/media?filename=` | `briar.media.put(body stream, { mime, filename })` | `201 MediaRef`, `Location: {basePath}/media/{id}` |
| GET `/media/:mediaId` | `briar.media.get(mediaId)` | bytes (§4.5) |

**Runs:** `wait` is true only for `wait=true` or `wait=1`. `waitMs` integer 1–300 000 (default
60 000), else `400 request.invalid_query`. Without wait → `202 { runId, status }` with
`Location: {basePath}/runs/{runId}`. With wait → race `run.result` against `waitMs` and the
request's `signal`: finished in time → `200 RunResult` (also for `failed` / `cancelled`
results); else `202` as without wait. The run is never cancelled because the HTTP request ended.

### 4.4 SSE (`GET /runs/:runId/events`, rest-api.md §4)

- Headers: `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`,
  `X-Accel-Buffering: no`, `Connection: keep-alive` (Node only).
- Resume point: `Last-Event-ID` header, else `?after=`; both must be integers ≥ -1 else
  `400 request.invalid_query` (header wins when both are present). None → full history.
- Each event: `id: <seq>\nevent: <type>\ndata: <one-line JSON>\n\n`. Keep-alive comment
  `: ping\n\n` every `pingIntervalMs` while no event was written.
- After writing `run.completed` the server ends the response. A request for a finished run
  whose `after` ≥ the last seq replays nothing and ends immediately (200, empty stream).
- Client disconnect (`request.signal` aborts / Hono stream `onAbort`): stop the iterator
  (`return()`), clear the ping timer. Never cancels the run.
- Many concurrent streams per run are fine (each gets its own `run.events()` iterable).

### 4.5 Media

- **Upload:** `Content-Type` header required (parameters allowed; the store normalizes it);
  missing or rejected by the store (`media.invalid_mime`) → `415`. `Content-Length` above
  `maxUploadBytes` → `413 media.too_large` before reading; otherwise the body stream is wrapped
  in a counter that errors with `MediaError("media.too_large", …, { details: { maxBytes } })`
  once exceeded (the store's partial write is discarded by the store). `filename` query ≤ 255
  chars. Empty body is allowed (`bytes: 0`).
- **Download:** `Content-Type` = stored mime, `Content-Length` = `ref.bytes`,
  `ETag: "<hash>"`, `Cache-Control: private, max-age=31536000, immutable`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<meta.filename>"`
  when known (quote-escaped; non-ASCII via `filename*=UTF-8''…`). SVG (`image/svg+xml`) gets
  `Content-Security-Policy: sandbox`. `If-None-Match` equal to the ETag → `304` (cancel the body).

### 4.6 Custom endpoints (guidance for users; goes into the package README and a test)

- Add routes to the returned app (paths are absolute; include the base path yourself) or mount
  it with `app.route("/", api)` inside your own Hono app with your own middleware.
- Call the facade directly (`briar.run`, `briar.flows.info`, …); HTTP is a thin layer.
- Answer errors with `briarError(c, err)`; throw `UnauthorizedError` for 401.
- `authorize` does **not** run for custom routes; protect them with your middleware.
- The README example is rest-api.md §6, with `await serve(...)`.

### 4.7 `apps/server` (backend)

Node service: `SqliteContextStore` (`BRIAR_DATA_DIR`, default `./data/briarflow.db`),
`FsMediaStore` (`./data/media`), `stdPack` + `mockPack`, optional Python pack from
`BRIAR_PYTHON_WORKER_URL`, `envSecrets()`. `PORT` (3000), `HOST` (127.0.0.1),
`BRIAR_CORS_ORIGIN` (comma list; default the §3 dev origins). `GET /health` → `200 ok` as a
custom route. Serves `apps/studio/dist` at `/` when it exists (`serveStatic` from
`@hono/node-server/serve-static`, SPA fallback to `index.html`). On SIGINT/SIGTERM:
`server.close()` then `briar.close()`. Logs one line with the URL and a warning when no
`authorize` hook is configured and `HOST` is not loopback.

## 5. Client ⇄ server alignment (frontend)

1. `RunInfo` in `@briarflow/client` gains optional `createdAt?: string` and
   `globalWriteStatus?: "applied" | "partial" | "failed"` (the server sends the facade's
   `RunInfo`).
2. `@briarflow/editor`: replace the local adapter with `createCatalogFromDescriptors` from
   `@briarflow/core` (REQ-8, done in core).
3. Studio dev: talk to `http://localhost:3000/api/v1` (CORS default allows `:5173`), or keep a
   Vite proxy — both must work.
4. `RemoteRun` resumes with `?after=`; the server also honours `Last-Event-ID`. No change.

## 6. Tasks

### Backend developer
1. `packages/server` per §2–§4 with internal tests in `packages/server/test/internal/`
   (`app.request(...)` based; no sockets needed).
2. `apps/server` per §4.7.
3. REQ-7 point 3 (CORS default) is satisfied by §3; mark it done.

### Frontend developer
§5 items 1–3.

### Tester
Suites in `packages/server/test/` (public API only):
1. **HTTP contract** (`app.request`, no sockets): every row of §4.3 incl. status codes,
   headers (`Location`, `ETag`, `Cache-Control`, CSP on SVG), every row of §4.1, the pipeline
   order of §4.2 (400 id → 404 → 403/401 → 400 body), `maxBodyBytes`, `maxUploadBytes`, CORS
   preflight from `http://localhost:5173` allowed and from another origin not, `cors: false`,
   `basePath: ""`, `route.not_found`.
2. **Integration** (`packages/server/test/integration/*.test.ts`): `createBriar({ packs: [mockPack], clock, idGenerator })`
   → `createBriarApp` → `await serve(app, { port: 0 })` → the real
   `createBriarClient({ baseUrl: server.url + "/api/v1" })`. `afterAll`: `server.close()`,
   `briar.close()`. Cover:
   - contexts: create / list (pagination with `iterate`) / get / delete; `ConflictError` on
     an existing id; `NotFoundError`.
   - `contexts.apply`: success (revision + 1, `created`), stale revision →
     `RevisionConflictError` (`expected`/`actual`), rejected command → client `CommandError`
     with `commandIndex` / `op`, `changed: false` batch.
   - `flows.get` signature; `flows.run` → `RemoteRun`: `events()` yields `run.started` …
     `run.completed` with gap-free `seq`; `result` equals `runs.get(id).result`; `wait: true`
     returns a finished run; invalid inputs → `RunRejectedError` (`run.invalid_inputs`).
   - SSE resume: a `fetch` wrapper that cuts the first event stream after 2 events; the client
     reconnects with `after` and still sees every event exactly once (use `mock.delay`).
   - cancel: `runs.cancel` on a running `mock.delay` flow → `cancelled`; on a finished run →
     unchanged terminal status.
   - node types: `nodeTypes.list()` twice → second call revalidated with `If-None-Match`
     (304) and returns equal data; `createCatalogFromDescriptors(list, { localPacks: [stdPack] })`
     validates the test context like the server does.
   - media: upload bytes with a mime + filename → `MediaRef`; download equals the bytes; a
     `mock.image` run output can be downloaded via its id.
   - `authorize`: a hook denying `flows.run` → `AuthError` (403); throwing
     `UnauthorizedError` → `AuthError` (401).
   - a custom route added next to the built-ins that calls `briar.run` and uses `briarError`.
3. Determinism: injected clock / ids; ephemeral ports only; no fixed sleeps longer than the
   `mock.delay` under test; `pingIntervalMs: 50` where pings are asserted.

### Lead
Review `packages/server` and `apps/server`; decide REQ entries; mark the phase done.

## 7. Acceptance criteria

1. Every endpoint, status code and header of rest-api.md §1–§4 behaves as specified (tester
   suite 1 green).
2. The real client works against the real server for every client method (suite 2 green), and
   the client's error classes match: 404 `NotFoundError`, 409 `RevisionConflictError` /
   `ConflictError`, 422 `CommandError` / `RunRejectedError`, 401/403 `AuthError`, 400/413/415
   `InvalidRequestError`, 5xx `ServerError`.
3. SSE: replay + live, resume by `Last-Event-ID` and `?after`, pings, stream ends after
   `run.completed`, disconnects do not cancel runs or leak iterators/timers.
4. `createBriarApp` imports no `node:*` (checked by a test that greps `packages/server/src`
   except `serve.ts`, or by adding a portable-entry rule to `check-boundaries`); `serve` works
   with `port: 0` and `close()` ends open SSE responses.
5. 500 responses never leak messages or stacks of non-Briar errors; they are logged.
6. `apps/server` starts with `npm start -w apps/server` (or `tsx src/main.ts`) and serves the
   API and, when built, the studio.
