# Python nodes

Some models and libraries only exist in Python (PyTorch, diffusers, OpenCV, Blender…). With
the Briarflow Python SDK you write nodes as plain Python functions, run them in a small
**worker** process, and the TypeScript engine loads them as an ordinary node pack. In the
editor they look and behave exactly like TypeScript nodes: typed ports, constraints,
progress, cancellation, retries, media.

This guide builds the example pack in
[`python/examples/imaging_nodes.py`](../../python/examples/imaging_nodes.py) step by step.
It takes about 30 minutes. The full reference is
[`docs/specs/python-protocol.md`](../specs/python-protocol.md).

```
 TypeScript (your server)                         Python (worker process)
 ┌──────────────────────────────┐   HTTP + NDJSON  ┌──────────────────────────┐
 │ createBriar({ packs })       │ ───────────────▶ │ serve(pack)              │
 │   └─ pack from @briarflow/   │  manifest,       │   @node functions        │
 │      python (bridge)         │  execute         │   ctx.progress / media   │
 └──────────────────────────────┘ ◀─────────────── └──────────────────────────┘
```

## 1. Install

Python side (Python 3.10 or newer, no third-party dependencies):

```bash
pip install briarflow                 # the SDK (package "briarflow")
# working from this repository instead:
uv venv python/.venv && uv pip install -e 'python[test]'
```

TypeScript side:

```bash
npm install briarflow @briarflow/python @briarflow/nodes-std
```

## 2. Your first node

```python
# imaging_nodes.py
from typing import Annotated
from briarflow import node, pack, serve, MaxLength

@node(title="Uppercase", category="Text")
def uppercase(text: Annotated[str, MaxLength(10_000)]) -> str:
    """Returns the text in upper case."""
    return text.upper()

imaging = pack("imaging", version="0.1.0", nodes=[uppercase])

if __name__ == "__main__":
    serve(imaging)
```

Run it and look at what the engine will see:

```bash
python imaging_nodes.py
# briarflow-worker ready port=8765

curl http://127.0.0.1:8765/briarflow/manifest
curl -N -X POST http://127.0.0.1:8765/briarflow/execute \
  -d '{"protocol":1,"nodeType":"imaging.uppercase","inputs":{"text":"hi"}}'
# {"type":"result","outputs":{"result":"HI"}}
```

What happened:

- **Node type.** `imaging.uppercase`: the pack name, a dot, and the function name in
  camelCase (`solid_image` → `imaging.solidImage`). Pass `@node(type="shout")` to choose
  another name (it is prefixed to `imaging.shout`); a dotted type must start with `imaging.`.
- **Inputs** are the function's parameters, in order. `text` became an input port of type
  `text`. A Python default becomes the port default.
- **Output.** A single return type gives one output port named `result`. Return `None` (and
  annotate `-> None`) for no outputs.
- **Description.** The first paragraph of the docstring.
- **Port titles** come from the names: `delay_ms` → "Delay ms". Override with
  `Port(title=…)` (§5).

Other `@node` options: `category`, `description`, `icon`, `color` (a pastel accent name such
as `"peach"`), `cache=True`, `timeout_ms=300_000`, `retry=0` (number of **extra** attempts:
`retry=2` → up to 3 attempts; or a retry-policy dict), `concurrency=None` (unlimited) and
`secrets=[...]` (§10).

## 3. Types

Every parameter and the return value need a type annotation; `pack()` raises a clear
`TypeError` naming the parameter otherwise.

| Python | Briarflow type | Your function receives |
|---|---|---|
| `str` | `text` | `str` |
| `int` | `int` | `int` |
| `float` | `float` (ints accepted) | `float` |
| `bool` | `boolean` | `bool` |
| `Image`, `Video`, `Audio`, `Model3D`, `File` | media primitives | a `MediaRef` subclass (§9) |
| `list[T]` | `list<T>` | `list` |
| `T \| None`, `Optional[T]` | `T?` | the value or `None` |
| `@struct` dataclass | struct `<pack>.<ClassName>` | a dataclass instance |
| `class X(str, Enum)` | enum `<pack>.X` | an `Enum` member |

Not supported: `dict`, `tuple`, `Any`, unions of two non-`None` types. Use a `@struct`
instead of a dict.

## 4. Structs and enums

```python
from dataclasses import dataclass
from enum import Enum
from typing import Annotated
from briarflow import struct, Min, Max, Port

class Color(str, Enum):
    """A named fill color."""
    RED = "red"
    GREEN = "green"
    BLUE = "blue"
    BRIAR = "briar"

@struct
@dataclass
class Swatch:
    """A color and the size of the image to fill with it."""
    color: Color
    width: Annotated[int, Min(1), Max(512), Port(description="Width in px")] = 64
    height: Annotated[int, Min(1), Max(512), Port(description="Height in px")] = 64
```

- `@struct` goes **above** `@dataclass`. The struct becomes the pack type `imaging.Swatch`;
  the enum becomes `imaging.Color` with members `red`, `green`, `blue`, `briar` (the enum
  *values*). Both are registered automatically when a node uses them; pass
  `pack(..., types=[...])` only for types no node uses.
- They are **pack types**: read-only and usable in every context that loads the pack,
  including flow inputs and outputs.
- Field defaults make fields optional in values (`{"color": "red"}` is a valid `Swatch`).
- Your node receives a real `Swatch` instance with a `Color` member, and may return them; the
  SDK converts both ways.
- Not expressible in Python v1: enum member **labels** and struct field **titles**. The
  editor derives them from the values and names.

## 5. Constraints and port metadata

Add constraints with `typing.Annotated`. The editor uses them for input widgets, and both
the engine and the worker check them.

| Marker | Applies to |
|---|---|
| `MinLength(n)`, `MaxLength(n)`, `Pattern(r)`, `Multiline()` | `str` |
| `Min(n)`, `Max(n)` | `int`, `float` |
| `MinItems(n)`, `MaxItems(n)` | `list[T]` |
| `Formats("png", "jpeg")`, `MaxBytes(n)`, `MinWidth(n)`, `MaxWidth(n)`, `MinHeight(n)`, `MaxHeight(n)` | media |
| `MaxDurationSec(s)` | `Video`, `Audio` |
| `Port(title=…, description=…)` | any port or struct field |

```python
@node(title="Repeat text", category="Text", cache=False)
def repeat(text: str, times: Annotated[int, Min(0), Max(1000)] = 2, separator: str = " ") -> str:
    """Repeats the text `times` times."""
    ...
```

**`Pattern`:** the worker checks it with Python's `re.fullmatch`, the engine with JavaScript
`RegExp`. Stick to what both read the same way: literals, `[...]`, `\d \w \s`, `* + ? {m,n}`,
`(...)`, `(?:...)`, `|`. Avoid named groups, lookbehind, `(?i)`, `\A` / `\Z`.

Output constraints are checked by the engine after the node returns, the same as for
TypeScript nodes.

## 6. Several outputs

Return an `@outputs` dataclass to get one output port per field:

```python
from briarflow import outputs, Image

@outputs
@dataclass
class ImageInfo:
    image: Image
    mime: str
    bytes: int | None
    is_png: bool

@node(title="Image info", category="Image")
def image_info(image: Image, *, ctx: ExecContext) -> ImageInfo:
    """Passes the image through unchanged and reports its mime, size and whether it is a PNG."""
    head = ctx.media.read(image)[:8] if image.url else b""
    return ImageInfo(image=image, mime=image.mime, bytes=image.bytes, is_png=head == b"\x89PNG\r\n\x1a\n")
```

Every field must be set; a missing or wrongly typed output fails the node with
`node.invalid_output` and a path such as `outputs.mime`.

## 7. The execution context: progress, logs, cancellation

Add a **keyword-only** parameter `ctx: ExecContext` (after `*`). It is injected by the SDK and
is not a port.

```python
import time
from briarflow import ExecContext

@node(title="Count slowly", category="Utility", cache=False)
def count_slowly(
    steps: Annotated[int, Min(1), Max(10_000)],
    delay_ms: Annotated[int, Min(0), Max(1000)] = 20,
    *,
    ctx: ExecContext,
) -> int:
    """Counts to `steps`, sleeping between steps and reporting progress (stops when cancelled)."""
    for i in range(steps):
        ctx.progress(i / steps, f"step {i + 1} of {steps}")  # raises Cancelled once cancelled
        time.sleep(delay_ms / 1000)
    return steps
```

| `ctx.` | |
|---|---|
| `progress(fraction, message=None)` | `fraction` in 0…1; shown on the node in the editor and sent as run events. **Raises `Cancelled`** once the run was cancelled. |
| `log(level, message, **data)` | `level` is `debug`, `info`, `warn` or `error`; `data` must be JSON. Appears in the run's log. |
| `cancelled` | `True` once the engine cancelled the run or the node timed out. |
| `run_id`, `node_id`, `node_type`, `attempt`, `timeout_ms` | Where you are; `attempt` starts at 1. |
| `media` | Read and create media (§9). |
| `secrets` | Declared secrets (§10). |

**Cancellation.** When a run is cancelled or the node's `timeout_ms` passes, the engine
closes the connection. From then on `ctx.cancelled` is `True`, `ctx.progress()` raises
`Cancelled`, and whatever the function returns is thrown away. So:

- call `ctx.progress()` regularly in long loops (free cancellation points), or
- check `if ctx.cancelled: raise Cancelled()` before expensive steps (e.g. between diffusion
  steps or batches).

Python cannot interrupt a running C call, so a 30-second model call still finishes; the
result is just ignored. Split long work into steps where you can.

## 8. Errors and retries

```python
from briarflow import NodeError

if times == 0:
    raise NodeError("imaging.nothing_to_repeat", "times is 0, so there is nothing to output.")
```

- `NodeError(code, message, retryable=False, details=None)` is an **expected** failure. The
  user sees your message; use a code under your pack name or a standard one
  (`node.rate_limited`, `node.unavailable`, …).
- `retryable=True` lets the engine retry it under the node's `retry` policy (rate limits,
  flaky upstream services).
- Any other exception becomes `node.failed` with `str(exc)` as the message; the traceback is
  printed to the worker's stderr (and forwarded to your TS logger by `spawnPythonWorker`), not
  sent to users.
- Raising `Cancelled` yourself reports the node as `node.cancelled`.

## 9. Media in and out

Media values are `MediaRef` objects (`Image`, `Video`, `Audio`, `Model3D`, `File`) with
`uri`, `mime`, `bytes`, `hash`, `meta` and a temporary `url`.

**Reading.** The bridge attaches a `url` your worker can GET for the duration of the call:

```python
data = ctx.media.read(image)            # bytes
with ctx.media.open(video) as fh:       # streaming, for large files
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        ...
```

**Creating.** Return new media with `ctx.media.create`. Extra keyword arguments become
`meta` (e.g. image width and height):

```python
@node(title="Solid color image", category="Image", color="peach")
def solid_image(swatch: Swatch, *, ctx: ExecContext) -> Image:
    """Creates a PNG filled with one color."""
    ctx.progress(0.1, "encoding")
    data = make_png(swatch.width, swatch.height, RGB[swatch.color])
    ctx.progress(1.0, "done")
    ctx.log("info", "encoded png", bytes=len(data))
    return ctx.media.create(
        data,
        mime="image/png",
        filename=f"{swatch.color.value}.png",
        width=swatch.width,
        height=swatch.height,
    )
```

The bytes travel back to the engine, which stores them in its `MediaStore` and replaces the
placeholder with a real `briar-media://` ref before validating outputs.

- **Pass-through.** Returning an input ref unchanged (as `image_info` does) costs nothing: no
  bytes are sent.
- **Mime and port type must match:** an `image/*` mime for an `Image` port, `video/*` for
  `Video`, and so on.
- **Size limit:** 100 MiB per created item (`python.media_too_large`). Larger outputs: upload
  them yourself and return a ref with an `https://` uri.
- **Remote workers.** By default the bridge serves input media from a loopback server on
  `127.0.0.1`, which only a worker **on the same host** can reach. For a worker on another
  machine, use a media store with `resolveUrl` (signed URLs, see
  [writing-a-store.md](writing-a-store.md#8-a-mediastore-on-bucket-storage)), or on a network
  you trust set `pythonPack({ url, mediaServer: { host: "10.0.0.5" } })` to an address of the
  TypeScript machine that the worker can reach. That host is used both to listen and in the
  URLs sent to the worker, so `"0.0.0.0"` does **not** work.

## 10. Secrets

Declare every secret a node needs; it receives only those:

```python
import hashlib

@node(title="Sign text", category="Text", secrets=["IMAGING_KEY"])
def sign(text: str, *, ctx: ExecContext) -> str:
    """Returns a SHA-256 hex digest of the secret key followed by the text."""
    return hashlib.sha256((ctx.secrets["IMAGING_KEY"] + text).encode("utf-8")).hexdigest()
```

- The **engine** resolves the value through its `SecretResolver` (e.g. `envSecrets()` in
  `createBriar`, which reads environment variables of the TypeScript process) and sends it with
  each call. The worker process itself needs no API keys.
- Reading an undeclared name raises `node.secret_not_declared`; a declared secret that is not
  configured raises `node.missing_secret` with a hint to set it.
- Secrets are never written to logs or run events.

## 11. Async nodes

`async def` nodes work too; the SDK runs each call with `asyncio.run` in its request thread:

```python
@node(title="Fetch caption", category="Text")
async def fetch_caption(image: Image, *, ctx: ExecContext) -> str:
    ...
```

## 12. Run the worker

```python
if __name__ == "__main__":
    serve(imaging)                          # blocking; 127.0.0.1:8765
```

| Setting | Argument | Env (wins over the argument) |
|---|---|---|
| Host | `host="127.0.0.1"` | `BRIARFLOW_HOST` |
| Port (`0` = any free port) | `port=8765` | `BRIARFLOW_PORT` |
| Shared token (`Authorization: Bearer …` required on every request) | `token=None` | `BRIARFLOW_TOKEN` |

Once listening, `serve` prints `briarflow-worker ready port=<n>` with the real port and stops
cleanly on SIGTERM. Keep the worker on `127.0.0.1` unless you set a token: anyone who can
reach it can run your nodes.

## 13. Connect from TypeScript

### Let Briarflow start the worker (recommended)

```ts
import { createBriar, envSecrets } from "briarflow";
import { stdPack } from "@briarflow/nodes-std";
import { spawnPythonWorker } from "@briarflow/python";

const worker = await spawnPythonWorker({
  command: "python/.venv/bin/python",       // default "python3" ("python" on Windows)
  args: ["examples/imaging_nodes.py"],      // or ["-m", "my_nodes"]
  cwd: "./python",
});
const imaging = await worker.pack();

const briar = createBriar({ packs: [stdPack, imaging], secrets: envSecrets() });

process.once("SIGTERM", () => worker.stop());
```

`spawnPythonWorker`:

- picks a free port, generates a random token and passes both through `BRIARFLOW_PORT` /
  `BRIARFLOW_TOKEN`; waits for the ready line and a healthy `/briarflow/health`
  (`readyTimeoutMs`, default 20 s; on timeout `python.worker_not_ready` with the last stderr
  lines);
- restarts a crashed worker (`restart: "on-failure"` by default, at most `maxRestarts: 5`
  within `restartWindowMs: 60_000`, with growing delays). Calls in flight fail with the
  retryable `python.worker_exited`; calls made while it restarts wait for it;
- forwards the worker's stdout/stderr to `logger` (stdout → info, stderr → warn);
- `worker.stop()` sends SIGTERM, waits `shutdownTimeoutMs` (5 s), then SIGKILL. Children are
  also stopped when your process exits.

`worker.pack()` stays valid across restarts. Other options: `env`, `host`, `port`, `token`
(`false` = none), `restart: "never" | "always"`, `restartDelayMs`.

### Connect to a worker you run yourself

For a worker in another container or on a GPU machine:

```ts
import { pythonPack } from "@briarflow/python";

const imaging = await pythonPack({
  url: "http://gpu-box:8765",
  token: process.env.IMAGING_WORKER_TOKEN,
});
const briar = createBriar({ packs: [stdPack, imaging] });
// on shutdown: await imaging.close();   (stops the pack's loopback media server)
```

`pythonPack` reads the manifest once at start-up (`manifestTimeoutMs`, default 10 s). After
changing the Python code, restart the TypeScript side too (or `worker.restart()` plus a new
`pack()` if node signatures changed).

### Use the nodes

The pack is an ordinary `NodePack`. Its nodes appear in the editor palette under their
categories, and flows refer to them by type:

```ts
flow.nodes.add("imaging.solidImage", { at: [300, 100] });
```

Types: `imaging.Swatch`, `imaging.Color`. Output port of single-output nodes: `result`.

## 14. Test your nodes

Decorated functions stay plain callables, so test the logic directly:

```python
from imaging_nodes import uppercase, imaging

def test_uppercase():
    assert uppercase("briar") == "BRIAR"

def test_manifest():
    m = imaging.manifest()
    assert "imaging.solidImage" in [n["type"] for n in m["nodes"]]
```

For end-to-end tests run a real worker in a background thread:

```python
import json, urllib.request
from briarflow import Worker

def test_execute():
    w = Worker(imaging, port=0).start()
    try:
        req = urllib.request.Request(
            f"{w.url}/briarflow/execute",
            data=json.dumps({"protocol": 1, "nodeType": "imaging.uppercase", "inputs": {"text": "hi"}}).encode(),
            method="POST",
        )
        lines = [json.loads(l) for l in urllib.request.urlopen(req).read().splitlines()]
        assert lines[-1] == {"type": "result", "outputs": {"result": "HI"}}
    finally:
        w.stop()
```

`Worker` does not read env vars, print the ready line or install signal handlers; `serve`
does. On the TypeScript side, `describeNodePack` from `@briarflow/testing` can check the
loaded pack like any other.

## 15. Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `TypeError: … needs a type annotation` at `pack()` | a parameter has no type | annotate it |
| `ValueError` at `pack()` | bad pack/node name, dotted type outside the pack | follow the message |
| `python.worker_not_ready` | the worker did not print its ready line in time | check the stderr lines in the message (import errors, wrong interpreter) |
| `python.unreachable` | connection refused or dropped | worker not running, wrong url, firewall; retryable |
| `python.worker_exited` | the spawned worker crashed | see its stderr in your logs |
| `python.protocol_error` with `workerCode: protocol.unauthorized` | token mismatch | pass the same token to `pythonPack` and `serve` |
| `python.protocol_error` with `workerCode: protocol.unknown_node` | the worker no longer has that node | restart the TS side after changing Python code |
| `python.unsupported_protocol` | SDK and bridge versions differ | update the older side |
| `node.invalid_input` from a Python node | worker and engine disagree about the pack | restart both |
| `node.invalid_output` | missing output field or wrong type | check `details.path` |
| `python.media_too_large` | a created media item is over 100 MiB | upload it yourself and return an `https://` ref |
| `Media … has no fetchable url` | a `MediaRef` built by hand | only read refs that arrived as inputs |
