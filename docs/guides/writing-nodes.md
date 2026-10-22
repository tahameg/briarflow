# Writing nodes

This guide walks you through building a node pack for Briarflow: a few nodes, a pack type,
tests, and wiring it into an app. It takes about 20 minutes. The full reference is
[`docs/specs/node-api.md`](../specs/node-api.md).

> Status: written in phase 0 against the specs; code samples become runnable in phase 3/4.

## 1. What a node is

A node is a small function with typed inputs and outputs. You describe it once with
`defineNode`; Briarflow then:

- shows it in the editor palette with the right port colors and input widgets,
- checks wires and constants against its types,
- runs it with retries, timeouts, caching and cancellation,
- exposes it over REST and to Python-free clients.

You only write the `run` function and the port types.

## 2. Set up a pack package

```
my-nodes/
  package.json        { "name": "my-nodes", "type": "module", "dependencies": { "@briarflow/core": "*" } }
  src/
    index.ts          exports the pack
    shout.ts          one file per node
    word-count.ts
    types.ts          pack types (optional)
  test/
    pack.test.ts
```

Pick a **pack name**: lowercase letters, digits and `_` (`words`). Every node type in the pack
starts with it: `words.shout`, `words.count`.

## 3. Your first node

```ts
// src/shout.ts
import { defineNode, t } from "@briarflow/core";

export const shout = defineNode({
  type: "words.shout",
  title: "Shout",
  description: "Uppercases text and adds exclamation marks.",
  inputs: {
    text: t.text(),
    marks: { type: t.int({ min: 0, max: 10 }), default: 1, description: "How many ! to add." },
  },
  outputs: {
    text: t.text(),
  },
  run({ inputs }) {
    return { text: inputs.text.toUpperCase() + "!".repeat(inputs.marks) };
  },
});
```

Things to notice:

- `inputs.text` is a `string` and `inputs.marks` a `number` — TypeScript knows from `t.*`.
- Returning `{ text: 42 }` or forgetting `text` is a compile error.
- `marks` has a `default`, so users can leave it unconnected and empty.
- In the editor, `marks` shows a number widget with − / + and refuses 11.

## 4. Types you can use

| Builder | Value in `run` |
|---|---|
| `t.text({ maxLength, multiline })` | `string` |
| `t.int({ min, max })`, `t.float()` | `number` |
| `t.boolean()` | `boolean` |
| `t.image()`, `t.video()`, `t.audio()`, `t.model3d()`, `t.file()` | `MediaRef` (`{ uri, mime, … }`) |
| `t.list(x, { maxItems })` | array |
| `t.optional(x)` | value or `null` |
| `t.ref(MyStruct)` | the struct's object type |
| `t.var("T")` | `unknown` — generic, the editor binds it when wired |

Constraints (`maxLength`, `min`, `formats`…) are checked when values enter your node, so you
don't have to re-check them.

## 5. Pack types

Share a struct or enum with users of your pack:

```ts
// src/types.ts
import { defineEnum, defineStruct, t } from "@briarflow/core";

export const Tone = defineEnum("Tone", ["calm", "excited", "angry"]);
export const Stats = defineStruct("Stats", {
  words: t.int({ min: 0 }),
  characters: t.int({ min: 0 }),
  tone: t.ref(Tone),
});
```

Users see them as `words.Tone` and `words.Stats` in the type picker, can use them in their
flow signatures, but cannot edit them.

```ts
// src/word-count.ts
import { defineNode, t } from "@briarflow/core";
import { Stats, Tone } from "./types.js";

export const count = defineNode({
  type: "words.count",
  title: "Count words",
  inputs: { text: t.text({ multiline: true }) },
  outputs: { stats: t.ref(Stats) },
  run({ inputs }) {
    const words = inputs.text.trim().split(/\s+/).filter(Boolean).length;
    const tone = inputs.text.includes("!") ? "excited" : "calm";
    return { stats: { words, characters: [...inputs.text].length, tone } };
  },
});
```

## 6. Bundle the pack

```ts
// src/index.ts
import { definePack } from "@briarflow/core";
import { shout } from "./shout.js";
import { count } from "./word-count.js";
import { Stats, Tone } from "./types.js";

export const wordsPack = definePack({
  name: "words",
  version: "0.1.0",
  title: "Words",
  types: [Tone, Stats],
  nodes: [shout, count],
});
```

`definePack` checks names and types right away and throws a readable error if something is
off (for example a node type that does not start with `words.`).

## 7. Talking to the outside world

Real nodes call APIs. Use the execution context `ctx`:

```ts
async run({ inputs, ctx }) {
  const key = await ctx.secrets.get("ACME_API_KEY");      // declare it: secrets: ["ACME_API_KEY"]
  ctx.progress(0.2, "Calling ACME");                       // shows a progress bar in the editor
  const res = await ctx.fetch(url, { signal: ctx.signal, headers: { authorization: `Bearer ${key}` } });
  if (res.status === 429) throw new NodeError("node.rate_limited", "Slow down", { retryable: true });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const image = await ctx.media.put(bytes, { mime: "image/png" });   // store media, get a MediaRef
  return { image };
}
```

Checklist for API nodes:

- **Secrets:** list them in `secrets: [...]`. A missing secret fails the node with a clear
  message before `run` is called.
- **Cancellation:** always pass `ctx.signal` to `fetch` / SDK calls.
- **Retries:** set `retry: 2` and throw `NodeError` with `retryable: true` for 429/5xx.
- **Timeouts:** default 5 minutes per attempt; set `timeoutMs` if your API is slower.
- **Caching:** on by default (same inputs → reused result). Set `cache: false` if the node has
  side effects (sending an email) or should give a new answer each time.
- **Rate limits:** `concurrency: 2` caps parallel executions of this node type.
- **Errors:** throw `NodeError(code, message)` with a message that tells the user what to do:
  "The prompt is longer than 4000 characters. Shorten it or split it." — not "Bad request".

## 8. Test the pack

```ts
// test/pack.test.ts
import { describe, expect, it } from "vitest";
import { describeNodePack, runNode } from "@briarflow/testing";
import { wordsPack } from "../src/index.js";
import { shout } from "../src/shout.js";

describeNodePack(wordsPack);   // checks names, descriptors, defaults, JSON-serializable metadata

describe("words.shout", () => {
  it("adds marks", async () => {
    const out = await runNode(shout, { text: "hi", marks: 2 });
    expect(out).toEqual({ text: "HI!!" });
  });
});
```

`runNode` runs a single node with an in-memory media store, fake secrets
(`runNode(def, inputs, { secrets: { ACME_API_KEY: "test" } })`) and a deterministic clock.

## 9. Use it

```ts
import { createBriar } from "briarflow";
import { stdPack } from "@briarflow/nodes-std";
import { wordsPack } from "my-nodes";

const briar = createBriar({ packs: [stdPack, wordsPack] });
```

Restart your server: the nodes appear in the studio palette under their categories.

## 10. Naming tips

- Node types: `<pack>.<camelCaseVerbOrNoun>` — `words.shout`, `image.resize`.
- Titles: short, sentence case, no pack name: "Resize image".
- Ports: what the value *is*: `prompt`, `image`, `maxTokens`. Avoid `input1`, `data`, `result`.
- Put shaping options that change ports in `config` (rare); everything users might wire is an
  input.

## 11. Python nodes (short version)

Have a model or library that only exists in Python? Write the node in Python and run it as a
worker; the TypeScript side loads it as a normal pack.

```python
# my_nodes/__main__.py
from typing import Annotated
from briarflow import node, pack, serve, Image, Min, Max, ExecContext

@node(title="Upscale image", category="Image")
def upscale(image: Image, factor: Annotated[int, Min(1), Max(4)] = 2, *, ctx: ExecContext) -> Image:
    """Upscales an image with Real-ESRGAN."""
    ctx.progress(0.1, "loading")
    data = ctx.media.read(image)
    out = run_model(data, factor)
    return ctx.media.create(out, mime="image/png")

imaging = pack("imaging", version="0.1.0", nodes=[upscale])

if __name__ == "__main__":
    serve(imaging)
```

```ts
import { spawnPythonWorker } from "@briarflow/python";

const worker = await spawnPythonWorker({ args: ["-m", "my_nodes"], cwd: "./python" });
const briar = createBriar({ packs: [stdPack, await worker.pack()] });
// node type: "imaging.upscale"; output port: "result"
```

- Ports come from the function signature; Python defaults become port defaults.
- Supported types: `str`, `int`, `float`, `bool`, `Image`/`Video`/`Audio`/`Model3D`/`File`,
  `list[T]`, `T | None`, `@struct` dataclasses, `str` enums, plus `Annotated[...]` constraints.
- A single return type gives one output named `result`; return an `@outputs` dataclass for
  several outputs.
- Raise `NodeError("node.rate_limited", "…", retryable=True)` for retryable failures.
- Check `ctx.cancelled` in long loops.
- Details: [`docs/specs/python-protocol.md`](../specs/python-protocol.md).
