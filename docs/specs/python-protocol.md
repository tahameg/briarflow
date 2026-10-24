# Spec: Python worker protocol v1, Python SDK, TS bridge

Status: draft v1 (phase 0). Owner: ux-designer. **Authoritative** for `@briarflow/python`
and `python/briarflow` (phase 6).

## Deviations from ARCHITECTURE.md

1. **Execute request** adds `protocol`, `attempt`, `secrets`, `timeoutMs` to the body.
2. **NDJSON** adds a `log` line type.
3. **Port readiness**: for `port: "auto"` the worker binds port 0 and prints a ready line with
   the real port on stdout (no port race).
4. **Optional shared token** (`Authorization: Bearer …`) between bridge and worker.
5. **Python node types may omit `type`**; it defaults to `<pack>.<function_name>` in camelCase
   (`upscale_image` → `imaging.upscaleImage`).

Clarifications from the first SDK implementation (requests.md REQ-1 from backend-developer,
2026-10-21) and from the first bridge implementation (REQ-5) are folded into §1–§3 below; they
are behaviour of protocol v1, not new versions.

---

## 1. Wire protocol v1

Transport: HTTP/1.1, JSON (UTF-8). Every response carries `X-Briarflow-Protocol: 1`. If the
worker was started with a token, **every** request to **every** endpoint — health included —
must carry `Authorization: Bearer <token>`; otherwise
`401 {"error":{"code":"protocol.unauthorized","message":"…"}}`. (The bridge's readiness poll
sends the token too.)

Plain-JSON errors share one body shape, `{"error":{"code","message","details"?}}`, and apply
to every endpoint:

| Status | code | When |
|---|---|---|
| 401 | `protocol.unauthorized` | token required and missing or wrong (checked first) |
| 404 | `protocol.not_found` | unknown path, e.g. `GET /briarflow/nodes` |
| 405 | `protocol.method_not_allowed` | known path, wrong method (`GET /briarflow/execute`, `POST /briarflow/health`); message names the right method |

### 1.1 `GET /briarflow/health`
`200 {"ok": true, "protocol": 1, "pack": {"name": "imaging", "version": "0.1.0"}}`

### 1.2 `GET /briarflow/manifest`
```json
{
  "protocol": 1,
  "sdk": { "name": "briarflow-python", "version": "0.1.0" },
  "pack": { "name": "imaging", "version": "0.1.0", "title": "Imaging", "description": "…" },
  "types": [ { "kind": "enum", "id": "imaging.ArtStyle", "name": "ArtStyle", "members": [ { "value": "anime" } ] } ],
  "nodes": [ { "type": "imaging.upscale", "title": "Upscale image", "category": "Image",
               "inputs": [ { "name": "image", "type": { "kind": "primitive", "name": "image" } },
                           { "name": "factor", "type": { "kind": "primitive", "name": "int", "constraints": { "min": 1, "max": 8 } }, "default": 2 } ],
               "outputs": [ { "name": "result", "type": { "kind": "primitive", "name": "image" } } ],
               "config": [], "dynamicPorts": false, "secrets": [], "cache": true,
               "timeoutMs": 300000, "retry": { "maxAttempts": 1 }, "concurrency": null } ]
}
```
`nodes` are `NodeDescriptor`s (node-api.md §7). Descriptor rules for the Python SDK:
- Every port has `name`, `type` and `title`. `title` is `Port(title=…)` or derived from the
  name: snake_case split into words, first letter capitalized (`max_tokens` → `"Max tokens"`);
  the single output port `result` → `"Result"`. `description` and `default` appear only when
  set; `widget` is never emitted (Python has no widget hints in v1).
- Node `description` is always a string (`""` when there is no docstring); `icon`, `color`,
  `deprecated` are `null` when unset.
- `concurrency` is `null` unless `@node(concurrency=n)` sets it (the default is unlimited,
  same as TS).
- `pack.title` / `pack.description` are omitted when not given to `pack()`.
- Struct fields carry `name`, `type`, and `description` / `default` when set. Python v1
  cannot express **enum member labels** (members carry only `value`) or **struct field
  titles**; clients derive labels/titles as for TS packs.
 Python nodes never have dynamic ports or
config in v1. The bridge validates the manifest with core (`pack.invalid` on failure) and
rejects `protocol !== 1` with `python.unsupported_protocol`.

### 1.3 `POST /briarflow/execute`
Request:
```json
{ "protocol": 1, "nodeType": "imaging.upscale", "runId": "run_7", "nodeId": "n_up", "attempt": 1,
  "timeoutMs": 300000,
  "inputs": { "image": { "uri": "briar-media://m_abc", "mime": "image/png", "bytes": 2048, "hash": "…",
                         "url": "http://127.0.0.1:41234/media/tok_9f…" },
              "factor": 2 },
  "config": {}, "secrets": { } }
```
- Inside Briarflow a media value is `{ mediaId }` (media.md); the bridge expands each one into
  the MediaRef below from its registry entry, so this wire format did not change (2026-10-25).
  Pass-through refs come back as `{ mediaId }`, `$media` outputs become transient entries.
- Every MediaRef in `inputs` (also nested) gets an extra `url` the worker can GET without
  auth for the duration of the request (see §3.3).
- `secrets` contains only the names the node declared.
- **Required fields:** `protocol` (integer) and `nodeType` (string). Missing or wrong JSON
  type → 400 `protocol.bad_request`. Defaults for the rest: `inputs`, `config`, `secrets` →
  `{}`; `attempt` → `1`; `runId`, `nodeId` → `""`; `timeoutMs` → none. The bridge always
  sends every field; the defaults exist for hand-written tests (`curl`).
- **Unknown keys:** unknown top-level request keys are ignored (forward compatibility,
  §1.5). Unknown keys in `inputs` (names that are not input ports) are ignored. Inside values
  the type rules apply: an unknown **struct** field is rejected (422, types.md §7); an inbound
  **MediaRef** may carry only `uri, mime, bytes, hash, meta, url` — other keys are ignored
  (not rejected; the engine already validated the ref).
- **Missing inputs:** port `default` → `null` if the type is optional → otherwise 422
  `node.invalid_input` with message `inputs.<name> is required` and `details.path`.
- **Input checks** (422) are the SDK's type check: JSON kinds, struct fields, enum members,
  media refs, and the declared constraints. The engine checked them already, so a 422 in
  practice means the worker and the engine disagree about the pack (e.g. a stale manifest).

Errors **before** streaming starts (plain JSON body):

| Status | code | When |
|---|---|---|
| 400 | `protocol.bad_request` | invalid JSON, body not an object, `protocol` or `nodeType` missing or of the wrong JSON type |
| 404 | `protocol.unknown_node` | `nodeType` not in this pack |
| 409 | `protocol.unsupported_version` | `protocol` ≠ 1 |
| 422 | `node.invalid_input` | inputs fail the SDK's type check (with `details.path`) |

Otherwise `200`, `Content-Type: application/x-ndjson`, `Transfer-Encoding: chunked` (no
`Content-Length`), one JSON object per line, **one line per chunk**, flushed per line. The
connection stays keep-alive after the terminating zero-length chunk. The bridge must read a
chunked body as a stream (WHATWG `fetch` does) and must not assume a line maps to a chunk —
it splits on `\n` across chunk boundaries. Pre-stream errors (table above) are ordinary
responses with `Content-Length`.

```json
{"type":"progress","fraction":0.4,"message":"upscaling"}
{"type":"log","level":"info","message":"model loaded","data":{"ms":120}}
{"type":"result","outputs":{"result":{"$media":{"mime":"image/png","base64":"iVBORw0…","filename":"up.png","meta":{"width":1024,"height":1024}}}}}
```
or as the last line:
```json
{"type":"error","code":"node.failed","message":"CUDA out of memory","retryable":false,"details":{}}
```

Rules:
- Exactly one terminal line (`result` or `error`), and it is the last. A stream that ends
  without one → bridge fails the node with `python.protocol_error`
  ("Worker closed the stream without a result.").
- Unknown line types are ignored (forward compatibility). Malformed JSON line →
  `python.protocol_error`.
- `fraction` in [0,1]; `level` ∈ `debug|info|warn|error`.
- **Media out:** any value position whose type is a media primitive may be either a MediaRef
  passed through unchanged (e.g. an input image) or `{"$media": {"mime", "base64", "filename"?, "meta"?}}`.
  The bridge decodes it, calls `MediaStore.put`, and substitutes the resulting MediaRef before
  the engine validates outputs. Max decoded size per item: 100 MiB, `MAX_MEDIA_OUT_BYTES` (`python.media_too_large`).
- Error `code` follows node-api.md §6 codes; `retryable` maps to `NodeError.retryable`.
- **Output checks are split.** The SDK checks output **shape and types** (every declared
  output present, JSON kinds, struct fields, enum members, media refs or `$media`) and on
  failure sends the terminal line `{"type":"error","code":"node.invalid_output","message":"…","retryable":false,"details":{"path":"outputs.result"}}`
  (`details.path` uses the types.md §7 path syntax). The SDK does **not** check output
  **constraints** (min/max, lengths, formats…): the engine validates every output after the
  bridge has replaced `$media` items, as for TS nodes (types.md §6).
- **Pass-through MediaRefs** in outputs have their `url` key stripped by the SDK (it is a
  per-request loopback URL). The bridge strips `url` again defensively before validation.
- **`Cancelled` with the client still connected** (a node raises `Cancelled` itself, or
  catches the cancellation of some inner work and re-raises it): the worker sends the
  terminal line `{"type":"error","code":"node.cancelled","message":"…","retryable":false,"details":{}}`.
  The bridge maps it to `NodeError("node.cancelled")` (not retryable); the engine reports the
  node as failed with `node.cancelled` (runtime.md §4) — a cancelled node, not a protocol
  error. If the client has already disconnected, nothing can be written and nothing is sent.

### 1.4 Cancellation and timeouts
- The bridge aborts the HTTP request (closes the connection) on cancel or timeout. The SDK
  detects the closed connection (write failure or a watcher on the socket) and sets
  `ctx.cancelled = True`. Nodes should check `ctx.cancelled` in loops; the SDK also raises
  `Cancelled` from `ctx.progress()` once cancelled.
- After the connection is closed the worker writes nothing more, whatever the node returns
  or raises.
- The bridge does not wait for the worker after aborting.
- A node may also raise `Cancelled` on its own while the connection is open: see §1.3
  (`node.cancelled` terminal line).

### 1.5 Versioning
- `protocol` is an integer. Additive changes (new optional fields, new line types) keep `1`.
  Both sides ignore unknown fields. A breaking change bumps to `2`; a bridge may support
  several versions and picks the one in the manifest.

## 2. Python SDK (`python/briarflow`, pip `briarflow`)

Python ≥ 3.10, stdlib only (`http.server` + `ThreadingHTTPServer`, `json`, `dataclasses`,
`typing`, `urllib.request`, `base64`, `hashlib`).

### 2.1 Surface

```python
from briarflow import (
    node, struct, outputs, pack, serve,
    Image, Video, Audio, Model3D, File, MediaRef,
    MinLength, MaxLength, Pattern, Multiline, Min, Max, MinItems, MaxItems, Formats, MaxBytes,
    MinWidth, MaxWidth, MinHeight, MaxHeight, MaxDurationSec,
    Port, ExecContext, MediaHelper, NodeError, Cancelled,
    Pack, Worker, Constraint, PROTOCOL_VERSION, __version__,
)
```

| Name | Purpose |
|---|---|
| `@node(type=None, title=None, category=None, description=None, cache=True, timeout_ms=300_000, retry=0, concurrency=None, secrets=(), icon=None, color=None)` | Marks a function as a node. Ports come from the signature. Description defaults to the docstring's first paragraph. **Type rule:** `type=None` → `<pack>.<camelCase(function name)>`; `type` without a dot (`"shout"`) → prefixed with the pack name (`"<pack>.shout"`); a dotted `type` must start with `<pack>.` (node-api.md §7 namespace rule; Python packs cannot claim extra namespaces in v1) else `pack()` raises `ValueError`. The result must match the node type regex (node-api.md §1). **Retry rule:** an integer `retry=N` means N extra attempts, i.e. `retry: { maxAttempts: N + 1 }` (`retry=0` → `maxAttempts: 1`); a dict is passed through as the retry policy. |
| `@struct` | On a `@dataclass`: becomes a pack struct type named after the class. Field docs via `Annotated[..., Port(description=…)]`. |
| `@outputs` | On a `@dataclass` used as a return type: one output port per field. |
| `pack(name, version, nodes, types=(), title=None, description=None)` | Builds the pack; resolves default node types; validates (raises `ValueError` with a clear message). |
| `serve(pack, host="127.0.0.1", port=8765, token=None)` | Runs the worker (blocking). Env `BRIARFLOW_HOST`, `BRIARFLOW_PORT`, `BRIARFLOW_TOKEN` override arguments. Port `0` = pick a free port. **Always** prints `briarflow-worker ready port=<n>` (the real bound port) on stdout once listening, whatever port was requested. Handles SIGTERM gracefully. |
| `NodeError(code, message, retryable=False, details=None)` | Expected failures. |
| `Cancelled` | Raised by `ctx.progress()` after cancellation; a node may raise it too (§1.3). |
| `MinWidth`, `MaxWidth`, `MinHeight`, `MaxHeight`, `MaxDurationSec` | Media constraint markers (types.md §6), used like `Formats` / `MaxBytes`. |
| `Worker(pack, host="127.0.0.1", port=8765, token=None, verbose=False)` | Worker bound to a socket, for tests and embedding: `start()` (background thread, returns the worker), `serve_forever()` (blocking), `url`, `host`, `port`, `stop()`. Does not read env vars, install signal handlers or print the ready line — `serve()` does those. |
| `Pack` | Type returned by `pack()`: `name`, `version`, `title`, `description`, `nodes`, `types`, `manifest()`, `node(type)`. |
| `MediaHelper` | Type of `ctx.media` (§2.4), exported for type hints and tests. |
| `Constraint`, `PROTOCOL_VERSION`, `__version__` | Base class of the markers; protocol integer (`1`); SDK version. |

### 2.2 Ports from the signature

```python
@node(title="Upscale image", category="Image")
def upscale(image: Image, factor: Annotated[int, Min(1), Max(8)] = 2, *, ctx: ExecContext) -> Image:
    ...
```
- Positional-or-keyword parameters = input ports, in order. Name used as-is (snake_case OK).
- Python default → port `default` (must be JSON-serializable).
- Keyword-only `ctx: ExecContext` is injected; it is not a port. Optional.
- Return annotation: a single type → one port named `result`; an `@outputs` dataclass → one
  port per field; `None` → no outputs.
- Missing annotations → `pack()` raises `TypeError("node imaging.upscale: parameter 'factor' needs a type annotation")`.

### 2.3 Type bindings

| Python | Briarflow |
|---|---|
| `str` | text |
| `int` | int |
| `float` | float (accepts int values) |
| `bool` | boolean |
| `Image`, `Video`, `Audio`, `Model3D`, `File` | media primitives (values arrive as `MediaRef` instances) |
| `list[T]` | `list<T>` |
| `T \| None`, `Optional[T]` | `T?` |
| `@struct` dataclass | struct `<pack>.<ClassName>` |
| `class X(str, Enum)` | enum `<pack>.X`, member values = enum values |
| `Annotated[T, MinLength(n) / MaxLength(n) / Pattern(r) / Multiline()]` | text constraints (see the `Pattern` note below) |
| `Annotated[T, Min(n) / Max(n)]` | int/float constraints |
| `Annotated[list[T], MinItems(n) / MaxItems(n)]` | list constraints |
| `Annotated[Image, Formats("png","jpeg") / MaxBytes(n) / MinWidth(n) / MaxWidth(n) / MinHeight(n) / MaxHeight(n)]`, `Annotated[Video, MaxDurationSec(s)]` | media constraints |
| `Annotated[T, Port(title=…, description=…)]` | port metadata |

Anything else (dict, tuple, Any, unions of non-None types) → `pack()` raises `TypeError` naming
the parameter and listing supported types. Struct field and enum value rules follow types.md §1.

**`Pattern` regex dialect.** The SDK checks `Pattern(r)` with Python `re.fullmatch`; the engine
checks the same pattern string with ECMAScript `RegExp` (whole-string match). The manifest
carries the string unchanged. Authors must use the subset both dialects read the same way:
literals, classes `[...]`, `\d \w \s`, quantifiers `* + ? {m,n}`, groups `(...)` /
`(?:...)`, alternation `|`. Avoid named groups (`(?P<n>…)` vs `(?<n>…)`), lookbehind, inline
flags (`(?i)`), possessive quantifiers, `\A`/`\Z`, and Unicode property escapes.

Values passed to the function: `str`/`int`/`float`/`bool`, `MediaRef` objects, struct
**dataclass instances**, `Enum` members, lists, `None`. Returned values are converted back the
same way (dataclass → dict, Enum → value).

### 2.4 `ExecContext`

```python
class ExecContext:
    run_id: str; node_id: str; node_type: str; attempt: int
    timeout_ms: int | None                            # from the request; None = no timeout
    cancelled: bool                                   # becomes True when the bridge disconnects
    def progress(self, fraction: float, message: str | None = None) -> None   # raises Cancelled if cancelled
    def log(self, level: str, message: str, **data) -> None
    secrets: Mapping[str, str]                        # only declared names; ctx.secrets["OPENAI_API_KEY"]
        # undeclared name → raises NodeError("node.secret_not_declared")
        # declared but not sent in the request → raises NodeError("node.missing_secret")
    media: MediaHelper

class MediaHelper:
    def read(self, ref: MediaRef) -> bytes            # GETs ref.url
    def open(self, ref: MediaRef) -> BinaryIO         # streaming variant
    def create(self, data: bytes, mime: str, filename: str | None = None, **meta) -> MediaRef
        # returns a MediaRef placeholder serialized as {"$media": …}
```

Exceptions: `NodeError` → `error` line with its code; `Cancelled` → `error` line with
`node.cancelled` if the client is still connected, otherwise nothing (§1.3, §1.4); any other
exception → `node.failed` with `str(exc)` and the traceback logged to the worker's stderr
(not sent). After a disconnect no exception produces a line.

`async def` nodes are supported: the SDK runs them with `asyncio.run` in the request thread.

### 2.5 Example

```python
from dataclasses import dataclass
from typing import Annotated
from briarflow import node, outputs, pack, serve, Image, Min, Max, ExecContext

@outputs
@dataclass
class Thumb:
    image: Image
    width: int

@node(title="Thumbnail", category="Image")
def thumbnail(image: Image, size: Annotated[int, Min(16), Max(1024)] = 256, *, ctx: ExecContext) -> Thumb:
    """Scales an image down so its longest side is `size` pixels."""
    data = ctx.media.read(image)
    out, w = make_thumb(data, size)
    return Thumb(image=ctx.media.create(out, mime="image/png", width=w), width=w)

imaging = pack("imaging", version="0.1.0", nodes=[thumbnail])

if __name__ == "__main__":
    serve(imaging)
```

## 3. TS bridge (`@briarflow/python`)

### 3.1 `pythonPack`

```ts
function pythonPack(options: {
  url: string;                 // "http://127.0.0.1:8765"
  token?: string;
  fetch?: typeof fetch;
  manifestTimeoutMs?: number;  // default 10_000
  mediaServer?: MediaServerOptions;   // §3.3
}): Promise<PythonNodePack>;

interface PythonNodePack extends NodePack {
  close(): Promise<void>;      // stops the pack's loopback media server; idempotent
}
```
Fetches the manifest, validates it, and returns a `PythonNodePack` whose node `run` functions
call `/briarflow/execute`, forward progress/logs to `ctx`, map errors to `NodeError`, and
convert `$media` outputs.

Other exports: `PROTOCOL_VERSION` (`1`), `MAX_MEDIA_OUT_BYTES` (`100 * 1024 * 1024`, the
decoded-size limit of one `$media` output item, §1.3), and `class PythonBridgeError extends BriarError` — thrown for **load and spawn**
failures (`pythonPack` / `spawnPythonWorker` / `pack()`); failures during an execute are
`NodeError`s as in the table below.

Error codes: `python.unreachable` (connection refused / timeout / connection dropped; retryable
for executes), `python.unsupported_protocol`, `python.protocol_error`, `python.worker_exited`,
`python.worker_not_ready` (§3.2).

**Manifest request errors.** Connection failures → `python.unreachable`. Any non-2xx response
(401, 404, …) or an invalid manifest → `python.protocol_error` with
`details: { status, workerCode }` (`workerCode` = the body's `error.code` when present).

Mapping of worker responses to node errors:

| Worker says | Bridge throws |
|---|---|
| terminal `error` line | `NodeError(code, message, { retryable, details })` with the line's fields; `node.cancelled` is never retryable |
| 422 `node.invalid_input` | `NodeError("node.invalid_input")` with the body's message and details |
| 404 `protocol.unknown_node`, 400, 401, 404 `protocol.not_found`, 405, 409 | `python.protocol_error` (not retryable), message includes the worker's code; `details: { status, workerCode }` |
| 502, 503, 504 (never sent by the SDK; a proxy or load balancer in front of the worker) | `python.unreachable` (retryable) — the worker behind it is down or slow |
| any other 5xx (also not from the SDK) | `python.protocol_error` (not retryable), `details: { status, workerCode }` |
| stream ends without a terminal line, malformed line | `python.protocol_error` |
| connection dropped mid-stream (`pythonPack({ url })`) | `python.unreachable` (retryable; the node's retry policy decides) |
| connection dropped mid-stream on a `spawnPythonWorker` pack | the bridge waits up to 1 s for the child to exit; if it exits → `python.worker_exited` (§3.2), otherwise `python.unreachable` |

### 3.2 `spawnPythonWorker`

```ts
function spawnPythonWorker(options: {
  command?: string;            // default "python3" ("python" on Windows)
  args: string[];              // e.g. ["-m", "my_nodes"]
  cwd?: string;
  env?: Record<string, string>;   // merged over process.env
  host?: string;               // default "127.0.0.1"
  port?: number | "auto";      // default "auto"
  token?: string | false;      // default: random 32-byte hex; false = no token
  readyTimeoutMs?: number;     // default 20_000
  restart?: "never" | "on-failure" | "always";   // default "on-failure"
  maxRestarts?: number;        // default 5 within restartWindowMs
  restartWindowMs?: number;    // default 60_000
  restartDelayMs?: number;     // default 500, doubled per consecutive restart, max 10_000
  shutdownTimeoutMs?: number;  // default 5_000
  logger?: Logger;             // stdout → info, stderr → warn, line by line, tagged "python"
}): Promise<PythonWorker>;

interface PythonWorker {
  readonly url: string;
  readonly status: "starting" | "ready" | "restarting" | "stopped" | "failed";
  pack(): Promise<PythonNodePack>;   // pythonPack bound to this worker; stays valid across restarts
  restart(): Promise<void>;
  stop(): Promise<void>;       // idempotent; also closes the pack's media server
}
```

Behaviour:
- Env passed to the child: `BRIARFLOW_HOST`, `BRIARFLOW_PORT` (`0` for auto), `BRIARFLOW_TOKEN`.
- **Readiness:** wait for the stdout line `briarflow-worker ready port=<n>` (gives the port),
  then poll `GET /briarflow/health` every 100 ms until `ok`. Timeout → kill the child, reject
  with `python.worker_not_ready` including the last 20 stderr lines.
- **Restart:** when the child exits unexpectedly and policy allows, in-flight executions fail
  with `python.worker_exited` (retryable), the worker restarts (new port possible; `url`
  updates; the pack uses the current url). More than `maxRestarts` in the window →
  `status: "failed"`; executes fail with `python.worker_exited` (not retryable).
- **Executes during `starting` / `restarting`** wait until the worker is `ready`, then run;
  the wait is aborted by `ctx.signal` (cancel or node timeout). In `failed` or `stopped` they
  fail at once with `python.worker_exited` (not retryable).
- If a restarted worker's manifest differs (pack name/version), the bridge logs an error
  and keeps the old node set (manifest is read once per pack).
- **Shutdown:** `stop()` sends SIGTERM, waits `shutdownTimeoutMs`, then SIGKILL. The bridge
  also stops children on parent `exit`/`SIGINT`/`SIGTERM` (best effort).

### 3.3 Media to the worker

For each input media value the bridge adds `url`, first match wins (`ctx.media.url`):
1. a `link` entry: its own URL (the worker fetches the origin directly);
2. a `stored` entry whose blob store implements `resolveUrl`: that URL;
3. otherwise (transient `data` entries included) a **loopback media server** the bridge starts lazily on `127.0.0.1:<random>`
   serving `GET /media/<token>`, where `token` is a random id mapped to the ref, valid
   (any number of reads) until the execute call settles.

Options: `mediaServer: { host?: "127.0.0.1", port?: 0 }`. Remote workers (not on the same
host) require a MediaStore with `resolveUrl` or a reachable `host` (documented).
