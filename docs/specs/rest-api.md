# Spec: REST + SSE API

Status: draft v1 (phase 0). Owner: ux-designer. Implemented in `@briarflow/server`
(phase 5); consumed by `@briarflow/client`.

## Deviations from ARCHITECTURE.md

1. **`POST /flows/:flowId/runs?wait=true` has a wait limit** (`waitMs`, default 60 000). If
   the run is not finished by then the server answers `202 { runId, status }` as without
   `wait`. Reason: avoid unbounded HTTP requests.
2. **Media upload is a raw body** (`Content-Type` = media mime, `?filename=`), not multipart.
   Reason: streaming-friendly and trivial to call from `fetch`.
3. **`GET /runs/:runId/events` supports `?after=<seq>`** in addition to `Last-Event-ID`.

---

## 1. Conventions

- Base path: `basePath` option, default `/api/v1`. All paths below are relative to it.
- JSON in and out (`application/json; charset=utf-8`) except media and SSE.
- Ids in paths are validated against the id regexes (types.md §1); malformed → `400 request.invalid_id`.
- **Error body** (every non-2xx):
  ```json
  { "error": { "code": "store.revision_conflict", "message": "…", "details": { } } }
  ```
- Status codes:

| Status | Codes |
|---|---|
| 400 | `request.invalid_json`, `request.invalid_body` (details: `{ path, problem }[]`), `request.invalid_id`, `request.invalid_query`, `store.invalid_cursor` |
| 401 | `auth.unauthorized` |
| 403 | `auth.forbidden` |
| 404 | `context.not_found`, `flow.not_found`, `run.not_found`, `media.not_found`, `route.not_found` |
| 409 | `store.revision_conflict`, `store.flow_id_conflict`, `context.exists` |
| 413 | `media.too_large`, `request.too_large` |
| 415 | `media.invalid_mime` (upload without a usable `Content-Type`) |
| 422 | any `command.*` / type / edge code from a command batch; `run.invalid_inputs`; `run.invalid_flow` |
| 500 | `internal` (message is generic; details logged server-side) |

- JSON request body limit: 5 MB (`maxBodyBytes`) → `413 request.too_large`.

## 2. Pagination

`GET /contexts?limit=&cursor=&search=` maps 1:1 to `ContextStore.list` (storage.md §1.4).
Response: `{ "items": [...], "nextCursor": "…" }` (`nextCursor` omitted on the last page).
`limit` default 50, max 200 (clamped). Invalid `limit` → `400 request.invalid_query`.

## 3. Endpoints

### Contexts

**GET `/contexts`** → `200 { items: ContextSummary[], nextCursor? }`

**POST `/contexts`** — body `{ "name": "Marketing", "description"?: "…", "id"?: "ctx_…" }`
→ `201` full `ContextDocument` (revision 0, no flows), header `Location: /api/v1/contexts/ctx_…`.
Name 1–120 chars else `400 request.invalid_body`. Existing `id` → `409 context.exists`.

**GET `/contexts/:contextId`** → `200 ContextDocument`, header `ETag: "<revision>"`.
404 `context.not_found`.

**DELETE `/contexts/:contextId`** → `204`. Unknown → 404. Runs in progress continue (they own
their snapshot); global writes of such runs are dropped.

**POST `/contexts/:contextId/commands`**
```json
{ "baseRevision": 12, "commands": [ { "op": "node.move", "flowId": "flow_p", "nodeId": "n_tpl", "position": { "x": 10, "y": 20 } } ] }
```
→ `200`
```json
{ "revision": 13, "changed": true, "created": [ {} ], "diagnostics": [ ] }
```
- Server: load → `baseRevision !== doc.revision` → `409 store.revision_conflict`
  (`details: { expected: 12, actual: 14 }`) → `applyBatch` → error → `422` with the
  `CommandError` (`details` include `commandIndex`, `op`) → save with `expectedRevision` (a
  race also gives 409) → respond.
- `changed: false` → `revision` unchanged, nothing saved.
- `commands` must be a non-empty array of ≤ 1000 commands (`400 request.invalid_body`).
- 422 example:
  ```json
  { "error": { "code": "edge.type_mismatch", "message": "Cannot connect Prompt.text (text) to Generate image.size (Size). …",
               "details": { "commandIndex": 3, "op": "edge.connect" } } }
  ```

**GET `/contexts/:contextId/diagnostics`** → `200 { "revision": 13, "diagnostics": Diagnostic[] }`.

### Flows

**GET `/flows/:flowId`** → `200`
```json
{ "contextId": "ctx_1", "revision": 13, "flow": { "...": "FlowDocument" },
  "signature": { "inputs": { "$schema": "…", "type": "object", "properties": {} }, "outputs": { } } }
```
Resolved via `locateFlow`; unknown → `404 flow.not_found`.

**POST `/flows/:flowId/runs`** — body `{ "inputs": { … }, "useCache"?: true }`; query
`wait=true`, `waitMs` (1–300 000, default 60 000).
- Inputs validated before the run is created → `422 run.invalid_inputs` with
  `details.diagnostics`. Invalid flow → `422 run.invalid_flow`.
- Without wait → `202 { "runId": "run_7", "status": "queued" | "running" }`,
  `Location: /api/v1/runs/run_7`.
- With wait and finished in time → `200 RunResult` (also when `status` is `failed` or
  `cancelled` — the HTTP call itself succeeded).
- If the client disconnects while waiting, the run continues.

### Runs

**GET `/runs/:runId`** → `200 { "runId", "flowId", "contextId", "status", "result"?: RunResult }`
(`result` once terminal). Unknown or evicted → `404 run.not_found`.

**GET `/runs/:runId/events`** → `200 text/event-stream` (§4).

**POST `/runs/:runId/cancel`** — body optional `{ "reason"?: "…" }` → `202 { "runId", "status" }`
(status after the request; may still be `running` while nodes settle). Terminal run → `200`
with its terminal status (idempotent).

### Node types

**GET `/node-types`** → `200`
```json
{ "packs": [ { "name": "briar", "version": "1.0.0", "title": "Briarflow standard" } ],
  "nodes": [ NodeDescriptor ], "types": [ TypeDecl ] }
```
`types` are pack types (ids `<pack>.<Name>`). `ETag` = hash of the body; supports
`If-None-Match` → 304.

### Media

**POST `/media`** — raw body, `Content-Type: image/png`, optional `?filename=cat.png`.
→ `201 MediaRef`. Limit `maxUploadBytes` (default 50 MB) → `413 media.too_large`.
Missing/invalid content type → `415 media.invalid_mime`.

**GET `/media/:mediaId`** → `200` bytes. Headers: `Content-Type` (stored mime),
`Content-Length`, `ETag: "<hash>"`, `Cache-Control: private, max-age=31536000, immutable`,
`Content-Disposition: inline; filename="<meta.filename>"` when known. `If-None-Match` → 304.
SVG is served with `Content-Security-Policy: sandbox` to neutralize scripts.
Unknown → `404 media.not_found`.

## 4. SSE format

```
id: 0
event: run.started
data: {"type":"run.started","runId":"run_7","seq":0,"at":"…","flowId":"flow_p","contextId":"ctx_1"}

id: 1
event: node.started
data: {"type":"node.started","runId":"run_7","seq":1,"at":"…","nodeId":"n_in","attempt":1}

: ping

```

- `event:` = `RunEvent.type`; `id:` = `seq`; `data:` = the event as one-line JSON.
- Resume: header `Last-Event-ID: 5` or query `?after=5` → only events with `seq > 5`
  (header wins if both). Without either, the full history is replayed.
- `: ping` comment every 15 s while idle.
- After `run.completed` the server sends it and closes the stream. Clients must not
  reconnect after seeing `run.completed` (`EventSource` would: the client SDK uses `fetch`
  streaming instead, and the server answers a reconnect after completion by replaying
  nothing newer and closing immediately).
- Response headers: `Cache-Control: no-cache`, `X-Accel-Buffering: no`.

## 5. `authorize` hook

```ts
createBriarApp(briar, {
  basePath?: string,
  cors?: { origin: string | string[] | ((origin: string) => boolean); credentials?: boolean },
  authorize?: (req: AuthorizeRequest) => boolean | Promise<boolean>,
  maxBodyBytes?: number, maxUploadBytes?: number,
});

interface AuthorizeRequest {
  action:
    | "contexts.list" | "contexts.create" | "contexts.read" | "contexts.delete" | "contexts.edit"
    | "flows.read" | "flows.run"
    | "runs.read" | "runs.cancel"
    | "nodeTypes.read" | "media.upload" | "media.read";
  resource: { contextId?: string; flowId?: string; runId?: string; mediaId?: string };
  request: Request;          // the standard Fetch Request (headers, url)
  c: HonoContext;            // escape hatch, e.g. c.get("user") set by your middleware
}
```

- Called once per request, **after** id resolution: `flowId` → `contextId` (via `locateFlow`),
  `runId` → `flowId`/`contextId` (from the registry). Unknown resources → 404 before
  `authorize` (documented trade-off: existence of ids is not secret; ids are random).
- `true` → continue. `false` → `403 auth.forbidden` (`"You are not allowed to {action}."`).
- Throw `new UnauthorizedError(message?)` (exported by `@briarflow/server`) → `401
  auth.unauthorized`. Any other thrown error → 500.
- Default (no hook): everything allowed. `apps/server` documents that it is meant for local
  use unless an `authorize` hook is configured.
- `contexts.list` cannot filter items in v1 (see OPEN_QUESTIONS Q-REST-1).
- `/media/:mediaId` is authorized with `media.read` and only `mediaId` (media is not linked
  to contexts in v1).

## 6. Adding your own endpoints

`createBriarApp` returns a normal Hono app. Add routes to it, or mount it inside your app.

```ts
import { Hono } from "hono";
import { createBriarApp, serve } from "@briarflow/server";

const api = createBriarApp(briar, { authorize: ({ c }) => Boolean(c.get("user")) });

// 1) next to the built-in routes (same basePath, same error format helpers)
api.post("/api/v1/portraits", async (c) => {
  const { character } = await c.req.json();
  const run = await briar.run("flow_portrait", { character });
  const result = await run.result;
  return result.status === "succeeded" ? c.json(result.outputs) : c.json({ error: result.error }, 500);
});

// 2) or inside your own app with your middleware
const app = new Hono();
app.use("*", myAuthMiddleware);           // sets c.set("user", …)
app.route("/", api);
app.get("/health", (c) => c.text("ok"));

serve(app, { port: 3000 });
```

- `@briarflow/server` exports `briarError(c, err)` to answer with the standard error body and
  status for any `BriarError`.
- The facade is the real API: custom endpoints call `briar.*` directly; HTTP is only a thin
  layer.
