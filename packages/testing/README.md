# @briarflow/testing

Conformance suites, fixtures and helpers for testing Briarflow and its extensions (stores,
node packs). Uses Vitest (`vitest` is a peer dependency): the suites register `describe` / `it`
blocks, so you call them at the top level of a `*.test.ts` file.

```ts
import { describeContextStore, describeMediaStore, describeNodePack, runNode } from "@briarflow/testing";
```

## `describeContextStore(name, factory, options?)`

Runs the ContextStore checks of `docs/specs/storage.md` §3 (1–14, plus a few extras such as
`store.invalid_document`).

```ts
describeContextStore("redis", async () => {
  const store = new RedisContextStore({ url, prefix: crypto.randomUUID() });
  return {
    store,                                       // required: a fresh, EMPTY store
    cleanup: () => store.dropAll(),              // optional, after every test
    writeRaw: (id, text) => store.writeRaw(id, text), // optional, see below
  };
});
```

`factory` is called **before every test** and may be sync or async. It returns a
`ContextStoreFixture`:

| Field | Type | Meaning |
|---|---|---|
| `store` | `ContextStore` | A fresh, empty store. |
| `cleanup?` | `() => void \| Promise<void>` | Runs after every test, **after** the suite has called `store.close?.()`. |
| `writeRaw?` | `(id: string, text: string) => void \| Promise<void>` | Writes `text` as the stored document of `id` with **no validation**. |

**Raw-write hook (check 13).** The suite needs a way to plant data the store would never write
itself: a compact/unsorted document (stands in for an older format version), invalid JSON
(`store.corrupt` with `cause.code = "format.invalid"`) and a too-new `formatVersion`
(`cause.code = "format.unsupported_version"`). Resolution order:

1. `fixture.writeRaw`, if given;
2. otherwise `store.writeRaw(id, text)`, if the store object has such a method
   (`FsContextStore`, `SqliteContextStore` and `MemoryContextStore` do);
3. otherwise check 13 is **skipped** (reported as skipped, not failed).

**Close (check 14)** runs only when the store has `close()`; otherwise it is skipped.

`options.slowTimeoutMs` (default 30 000) is the timeout of the slower checks (205-context
pagination, 1 MB round-trip).

## `describeMediaStore(name, factory, options?)`

Runs the MediaStore checks of storage.md §3 (1–8).

```ts
describeMediaStore("s3", async () => {
  const bucket = await createTestBucket();
  return { store: new S3MediaStore({ bucket }), cleanup: () => bucket.destroy(), contentAddressed: true };
});
```

`factory` returns a `MediaStoreFixture`:

| Field | Type | Meaning |
|---|---|---|
| `store` | `MediaStore` | A fresh, empty store. |
| `cleanup?` | `() => void \| Promise<void>` | Runs after every test. |
| `contentAddressed?` | `boolean` | The store derives ids from content (storage.md §2.1). |

**Content-addressed flag (check 6).** The `MediaStore` interface has no such field, so the suite
uses, in order:

1. `fixture.contentAddressed`, if given;
2. otherwise `store.contentAddressed === true` (an optional instance member; `FsMediaStore`
   sets it to `true`, `MemoryMediaStore` to `false`);
3. otherwise `false`.

With `false`, 1000 puts of identical content must give 1000 distinct uris, and ids are never
reused after delete. With `true`, identical puts must give the same ref.

`resolveUrl` (check 8) is tested only when the store has it. `options.slowTimeoutMs` (default
60 000) covers the 5 MB and 1000-put checks.

Exported helpers: `storeTestDoc(id, spec)`, `readStream(body)`, `bytesEqual(a, b)`.

## `describeNodePack(pack, options?)`

Checks a pack: `definePack` shape (name, semver, namespaces), catalog loading, qualified pack
type ids, node types unique and inside the namespaces, `defineNode` invariants (re-defining
does not throw), naming conventions (titles, port names), visible port types, plain-JSON
descriptors — and runs each node's samples through `runNode`.

```ts
describeNodePack(wordsPack, {
  dependencies: [stdPack],                    // packs needed in the catalog
  requireSamples: false,                      // true: every node must have a sample
  samples: {
    "words.shout": [{ inputs: { text: "hi" }, outputs: { text: "HI!" } }],
    "words.fail":  [{ inputs: {}, errorCode: "words.failed" }],
  },
});
```

A sample is `{ name?, inputs?, outputs?, errorCode?, check?(result), ...RunNodeOptions }`.

## `runNode(def, inputs, options?)`

Runs one node definition without an engine, with a fake `ExecContext`:

- ports resolved like the engine (static, or `resolvePorts` with the validated `config`);
- inputs resolved (given → port default → `null` for optional) and normalized/validated;
  problems reject with `NodeError("node.invalid_input")`;
- declared secrets resolved from `options.secrets` (missing → `node.missing_secret`;
  undeclared `ctx.secrets.get` → `node.secret_not_declared`);
- `ctx.globals` / `ctx.variables` from `options.globals` / `options.variables` (default: the
  context's global values / flow variable defaults); unknown name → `variable.unknown`;
- `ctx.resolveType` from the context (`options.context`, `options.flowId`) and the pack types
  of `options.packs`;
- `ctx.media` = `options.media` or a fresh in-memory store; `ctx.fetch` = `options.fetch`
  (default: rejects); `ctx.signal` = `options.signal`;
- outputs checked (`node.invalid_output`); omitted optional outputs become `null`.

It resolves with `{ outputs, progress, logs, media, inputs, ports, usedState }` and rejects
with whatever `run` threw. Progress is clamped like the engine but not throttled.

```ts
const { outputs, progress } = await runNode(textTemplate, { name: "Aria" }, { config: { template: "Hi {name}" } });
```

## Fixtures

Documents (`portraitContext`, `everyTypeContext`, `variablesContext`, builders `context`,
`flow`, `node`, `edge`, `ir`), packs (`briarTestPack`, `kitPack`, `wordsPack`, `testCatalog`),
`memoryMediaStore()`, value tables and error assertions (`expectBriarError`,
`expectBriarRejection`).
