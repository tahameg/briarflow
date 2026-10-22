# briarflow (Python SDK)

Write Briarflow nodes in Python and serve them to a Briarflow engine over HTTP.
Python ≥ 3.10, no runtime dependencies. Protocol: `docs/specs/python-protocol.md`.

## Quick start

```python
# my_nodes.py
from dataclasses import dataclass
from typing import Annotated
from briarflow import node, outputs, pack, serve, Image, Min, Max, ExecContext

@node(title="Uppercase", category="Text")
def uppercase(text: str) -> str:
    """Returns the text in upper case."""
    return text.upper()

@outputs
@dataclass
class Thumb:
    image: Image
    width: int

@node(title="Thumbnail", category="Image")
def thumbnail(image: Image, size: Annotated[int, Min(16), Max(1024)] = 256, *, ctx: ExecContext) -> Thumb:
    data = ctx.media.read(image)             # GETs the url the bridge attached
    ctx.progress(0.5, "scaling")              # raises Cancelled once the run is cancelled
    out = data                                # … your image code here …
    return Thumb(image=ctx.media.create(out, mime="image/png", width=size), width=size)

my_pack = pack("imaging", version="0.1.0", nodes=[uppercase, thumbnail])

if __name__ == "__main__":
    serve(my_pack)                            # 127.0.0.1:8765
```

```bash
python my_nodes.py
curl http://127.0.0.1:8765/briarflow/manifest
curl -N -X POST http://127.0.0.1:8765/briarflow/execute \
  -d '{"protocol":1,"nodeType":"imaging.uppercase","inputs":{"text":"hi"}}'
```

On the TypeScript side: `pythonPack({ url })` or `spawnPythonWorker({ args: ["my_nodes.py"] })`
from `@briarflow/python`.

## Types

| Python | Briarflow |
|---|---|
| `str`, `int`, `float`, `bool` | text, int, float, boolean |
| `Image`, `Video`, `Audio`, `Model3D`, `File` | media primitives (values are `MediaRef`s) |
| `list[T]`, `T \| None` | `list<T>`, `T?` |
| `@struct` dataclass, `class X(str, Enum)` | pack struct / enum `<pack>.X` |
| `Annotated[T, MaxLength(40), Port(description=…)]` | constraints and port metadata |

Node types default to `<pack>.<camelCase(function_name)>`. A single return type gives one
output port `result`; an `@outputs` dataclass gives one port per field.

## Errors and cancellation

Raise `NodeError(code, message, retryable=False, details=None)` for expected failures; any other
exception becomes `node.failed`. When the engine cancels a run the bridge closes the connection:
`ctx.cancelled` becomes `True` and `ctx.progress()` raises `Cancelled`. A node may also raise
`Cancelled` itself; the engine then sees a `node.cancelled` error.

## Worker

`serve(pack, host="127.0.0.1", port=8765, token=None)`; env `BRIARFLOW_HOST`,
`BRIARFLOW_PORT` (`0` = free port), `BRIARFLOW_TOKEN` override the arguments. Once listening it
prints `briarflow-worker ready port=<n>`. `Worker(pack, port=0).start()` runs it in a
background thread (handy in tests).

## Development

```bash
uv venv python/.venv && uv pip install -e 'python[test]'
cd python && .venv/bin/python -m pytest
```

Example pack: `examples/imaging_nodes.py`.
