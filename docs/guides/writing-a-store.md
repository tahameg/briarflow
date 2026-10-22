# Writing a store (adding a new save target)

Briarflow saves two kinds of things:

- **contexts** (the workspace documents with types, globals and flows) through a
  `ContextStore`, and
- **media** (images, audio, video, 3D models, files) through a `MediaStore`.

Both are small interfaces in `@briarflow/core`. Briarflow ships a memory store (in
`briarflow`), `FsContextStore` / `FsMediaStore` (`@briarflow/storage-fs`) and
`SqliteContextStore` (`@briarflow/storage-sqlite`). This guide shows how to write your own,
for example on Redis, DynamoDB, Postgres, a cloud bucket or a git repository, and how to
prove it behaves like the built-in ones.

The exact rules live in [`docs/specs/storage.md`](../specs/storage.md). This guide explains
them in plain words and walks through a complete example. It takes about 30 minutes.

Core does the fiddly parts for you: `normalizeListQuery`, `matchesContextSearch`,
`compareContextOrder`, `isAfterCursor` and `buildContextPage` implement every `list` rule, and
`normalizeMime` / `MIME_PATTERN` the mime rule. A store only decides where the bytes go.

## 1. When to write a store

Write a store when your contexts or media must live somewhere the built-in stores cannot
reach:

| You want | Write |
|---|---|
| Contexts in Redis, DynamoDB, Postgres, Firestore, etcd… | a `ContextStore` |
| Contexts in a git repo (one file per context, diff-friendly) | a `ContextStore` (the serialized format is already sorted and diff-friendly) |
| Media in S3, R2, GCS, Azure Blob… | a `MediaStore` |
| Media served straight from a CDN to browsers and Python workers | a `MediaStore` with `resolveUrl` |

You do **not** need a store to change *where* files go: `FsContextStore({ dir })` and
`FsMediaStore({ dir })` already take a directory.

## 2. The contracts in plain words

### `ContextStore`

```ts
interface ContextStore {
  readonly kind: string;                                    // "redis", "s3", …
  load(id: string): Promise<ContextDocument | undefined>;
  save(doc: ContextDocument, options?: { expectedRevision?: number }): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(query?: { search?: string; limit?: number; cursor?: string }): Promise<Page<ContextSummary>>;
  locateFlow(flowId: string): Promise<string | undefined>;
  close?(): Promise<void>;
}
```

| Method | What it must do |
|---|---|
| `load(id)` | Return the last saved document, or `undefined`. Each call returns a **fresh object** (callers must be able to mutate it without touching the store). |
| `save(doc, { expectedRevision })` | Upsert by `doc.id`. **Do not change the document** (authoring already bumped `revision`). If `expectedRevision` is given, the stored revision must equal it (a missing document counts as `0`), otherwise throw `RevisionConflictError`. If any flow id of `doc` belongs to **another** context, throw `FlowIdConflictError`. The check and the write are **one atomic step**. |
| `delete(id)` | `true` if it existed. Afterwards the context is gone from `load`, `list` and `locateFlow`. |
| `list(query)` | Summaries ordered by `updatedAt` newest first, then `id` A→Z. Optional case-insensitive `search`, `limit` (default 50, max 200) and an opaque `cursor` for the next page. |
| `locateFlow(flowId)` | Id of the context that contains the flow, or `undefined`. The REST API calls this on every `/flows/:id` request, so make it an index lookup. |
| `close()` | Optional, idempotent. Afterwards every other call throws `StoreClosedError`. |

You always store the text produced by `serializeContext(doc)` and read it back with
`deserializeContext(text)`. `deserializeContext` also runs **format migrations**, so a store
written today keeps working when the document format changes. Never store your own JSON
shape of a document.

### `MediaStore`

```ts
interface MediaStore {
  readonly kind: string;
  put(data: Uint8Array | ReadableStream<Uint8Array>,
      info: { mime: string; filename?: string; meta?: Record<string, unknown> }): Promise<MediaRef>;
  get(ref: MediaRef | string): Promise<{ ref: MediaRef; body: ReadableStream<Uint8Array> } | undefined>;
  delete(ref: MediaRef | string): Promise<boolean>;
  resolveUrl?(ref: MediaRef): Promise<string | undefined>;
}
```

| Method | What it must do |
|---|---|
| `put` | Read the whole body. Return `{ uri: "briar-media://<id>", mime, bytes, hash, meta? }`: `mime` lowercased without parameters (`"Image/PNG; q=1"` → `"image/png"`), `bytes` the exact length, `hash` the sha-256 hex of the content, `meta` = `info.meta` plus `filename`. Empty bodies are fine. |
| `get` | Accept a `MediaRef`, a `briar-media://` uri or a bare id. Anything else (e.g. `https://…`) → `undefined`; the store never fetches remote URLs. Each call returns a **new** stream. |
| `delete` | Same inputs as `get`. `true` if it existed. |
| `resolveUrl` | Optional. A URL a browser or a Python worker can GET without extra auth (public or signed). |

Ids are chosen by the store and match `^[A-Za-z0-9_-]{1,128}$`. They are unique and never
reused after delete (unless the store is content-addressed, see §8).

### Errors

Use the error classes from `@briarflow/core`; their `code`s are part of the contract and the
REST API passes them to clients unchanged.

| Situation | Throw | Code |
|---|---|---|
| Revision check failed | `new RevisionConflictError({ id, name, expected, actual })` | `store.revision_conflict` |
| Flow id owned by another context | `new FlowIdConflictError({ flowId, contextId })` (`contextId` = the owner) | `store.flow_id_conflict` |
| Stored document cannot be read | `new StoreCorruptError({ id }, { cause })` | `store.corrupt` |
| Bad `limit` / `search` | `normalizeListQuery` throws `InvalidQueryError` for you | `store.invalid_query` |
| Bad cursor | `normalizeListQuery` throws `InvalidCursorError` for you | `store.invalid_cursor` |
| `save` of something that is not a context document | `new InvalidDocumentError(message)` | `store.invalid_document` |
| Call after `close()` | `new StoreClosedError(kind)` | `store.closed` |
| Media mime invalid | `normalizeMime` throws `MediaError` for you | `media.invalid_mime` |
| Media too large / stored ref unreadable | `new MediaError("media.too_large" \| "media.corrupt", message, { details })` | as given |
| Your database has a newer schema than your code knows | `new BriarError("store.unsupported_schema", message, { details: { schemaVersion, supported } })` | `store.unsupported_schema` |

Everything else (network errors from your database client, for example) may propagate as is.

## 3. The worked example: a key-value `ContextStore`

We write `KvContextStore` against a **tiny key-value interface** instead of a real Redis
client. Every serious backend can provide these three operations, so you can port the store
by writing one small adapter:

```ts
// src/kv.ts
export interface KvEntry {
  value: string;
  /** Changes on every write of the key. */
  version: number;
}

/** `version: null` = the key must not exist. */
export interface KvCheck {
  key: string;
  version: number | null;
}

export type KvOp = { set: string; value: string } | { delete: string };

export interface Kv {
  get(key: string): Promise<KvEntry | undefined>;
  /** All keys starting with `prefix`, with their values. */
  list(prefix: string): Promise<{ key: string; value: string }[]>;
  /** All-or-nothing: applies `ops` only if every check still holds. Returns `false` if not. */
  atomic(checks: KvCheck[], ops: KvOp[]): Promise<boolean>;
}
```

How `atomic` maps to real backends:

| Backend | `atomic(checks, ops)` |
|---|---|
| Redis | `WATCH` the checked keys, `GET` them, `MULTI` … `EXEC` (returns `null` if a watched key changed) — or one Lua script |
| DynamoDB | `TransactWriteItems` with a `ConditionExpression` on a `version` attribute |
| Postgres / MySQL | one transaction with `SELECT … FOR UPDATE`, or `UPDATE … WHERE version = $1` |
| etcd | `Txn().If(ModRevision(key) == v).Then(...)` |
| Deno KV | `kv.atomic().check(...).set(...).commit()` |

For tests, an in-memory version (JavaScript runs the body of `atomic` without interruption,
so it is atomic for free):

```ts
// src/memory-kv.ts
import type { Kv, KvCheck, KvEntry, KvOp } from "./kv.js";

export class MemoryKv implements Kv {
  #data = new Map<string, KvEntry>();
  #seq = 0;

  async get(key: string): Promise<KvEntry | undefined> {
    const e = this.#data.get(key);
    return e && { ...e };
  }

  async list(prefix: string): Promise<{ key: string; value: string }[]> {
    return [...this.#data].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, value: e.value }));
  }

  async atomic(checks: KvCheck[], ops: KvOp[]): Promise<boolean> {
    for (const c of checks) if ((this.#data.get(c.key)?.version ?? null) !== c.version) return false;
    for (const op of ops) {
      if ("set" in op) this.#data.set(op.set, { value: op.value, version: ++this.#seq });
      else this.#data.delete(op.delete);
    }
    return true;
  }
}
```

### 3.1 Key layout

| Key | Value | Used by |
|---|---|---|
| `ctx/<contextId>` | `serializeContext(doc)` text | `load` |
| `idx/<contextId>` | small JSON summary: id, name, description, revision, updatedAt, flows | `list`, the revision check, `delete` |
| `flow/<flowId>` | the owning context id | `locateFlow`, flow-id uniqueness |

The summary in `idx/` means `list` never parses whole documents, and the flow keys turn
`locateFlow` into one `get`.

### 3.2 The store

```ts
// src/kv-context-store.ts
import {
  CONTEXT_FORMAT, FlowIdConflictError, InvalidDocumentError, RevisionConflictError, StoreClosedError,
  StoreCorruptError, buildContextPage, compareContextOrder, deserializeContext, isAfterCursor, isBriarError,
  isValidId, matchesContextSearch, normalizeListQuery, serializeContext,
} from "@briarflow/core";
import type {
  ContextDocument, ContextListEntry, ContextListQuery, ContextStore, ContextSummary, Page, SaveContextOptions,
} from "@briarflow/core";
import type { Kv, KvCheck, KvOp } from "./kv.js";

/** What `idx/<id>` holds: a summary plus the description (searched, not returned). */
type Entry = ContextListEntry;

const ctxKey = (id: string) => `ctx/${id}`;
const idxKey = (id: string) => `idx/${id}`;
const flowKey = (id: string) => `flow/${id}`;

export class KvContextStore implements ContextStore {
  readonly kind = "kv";
  readonly #kv: Kv;
  #closed = false;

  constructor(kv: Kv) {
    this.#kv = kv;
  }

  async load(id: string): Promise<ContextDocument | undefined> {
    this.#checkOpen();
    const stored = await this.#kv.get(ctxKey(id));
    if (!stored) return undefined;
    let doc: ContextDocument;
    try {
      doc = deserializeContext(stored.value); // parses, migrates, returns a fresh object
    } catch (err) {
      throw new StoreCorruptError({ id }, { cause: err });
    }
    if (doc.id !== id) throw new StoreCorruptError({ id }, { cause: new Error(`Key of "${id}" holds "${doc.id}".`) });
    return doc;
  }

  async save(doc: ContextDocument, options: SaveContextOptions = {}): Promise<void> {
    this.#checkOpen();
    const text = serializeForSave(doc);
    const entry = entryOf(doc);
    for (;;) {
      const oldIdx = await this.#kv.get(idxKey(doc.id));
      const old = oldIdx ? (JSON.parse(oldIdx.value) as Entry) : undefined;
      const actual = old?.revision ?? 0;
      if (options.expectedRevision !== undefined && options.expectedRevision !== actual) {
        throw new RevisionConflictError({ id: doc.id, name: doc.name, expected: options.expectedRevision, actual });
      }
      const checks: KvCheck[] = [{ key: idxKey(doc.id), version: oldIdx?.version ?? null }];
      const ops: KvOp[] = [
        { set: ctxKey(doc.id), value: text },
        { set: idxKey(doc.id), value: JSON.stringify(entry) },
      ];
      for (const flow of entry.flows) {
        const owner = await this.#kv.get(flowKey(flow.id));
        if (owner && owner.value !== doc.id) throw new FlowIdConflictError({ flowId: flow.id, contextId: owner.value });
        checks.push({ key: flowKey(flow.id), version: owner?.version ?? null });
        if (!owner) ops.push({ set: flowKey(flow.id), value: doc.id });
      }
      const kept = new Set(entry.flows.map((f) => f.id));
      for (const flow of old?.flows ?? []) if (!kept.has(flow.id)) ops.push({ delete: flowKey(flow.id) });
      if (await this.#kv.atomic(checks, ops)) return;
      // Another writer got in between our reads and the write. Read again: the next round
      // either succeeds or reports the real conflict.
    }
  }

  async delete(id: string): Promise<boolean> {
    this.#checkOpen();
    for (;;) {
      const idx = await this.#kv.get(idxKey(id));
      if (!idx) return false;
      const old = JSON.parse(idx.value) as Entry;
      const ops: KvOp[] = [{ delete: ctxKey(id) }, { delete: idxKey(id) }, ...old.flows.map((f) => ({ delete: flowKey(f.id) }))];
      if (await this.#kv.atomic([{ key: idxKey(id), version: idx.version }], ops)) return true;
    }
  }

  async list(query?: ContextListQuery): Promise<Page<ContextSummary>> {
    this.#checkOpen();
    const q = normalizeListQuery(query); // limit, search, cursor: checked and decoded
    const rows = (await this.#kv.list("idx/"))
      .map((r) => JSON.parse(r.value) as Entry)
      .filter((e) => matchesContextSearch(e, q.needle) && isAfterCursor(e, q.after))
      .sort(compareContextOrder);
    return buildContextPage(rows, q); // fresh summaries + nextCursor when more rows follow
  }

  async locateFlow(flowId: string): Promise<string | undefined> {
    this.#checkOpen();
    return (await this.#kv.get(flowKey(flowId)))?.value;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #checkOpen(): void {
    if (this.#closed) throw new StoreClosedError(this.kind);
  }
}

/** Rejects non-documents with `store.invalid_document`; returns the text to store. */
function serializeForSave(doc: ContextDocument): string {
  const d = doc as unknown as { format?: unknown; id?: unknown } | null;
  if (typeof d !== "object" || d === null || d.format !== CONTEXT_FORMAT || typeof d.id !== "string" || !isValidId("context", d.id)) {
    throw new InvalidDocumentError(`Only context documents with a valid ctx_ id can be saved.`);
  }
  try {
    const text = serializeContext(doc);
    deserializeContext(text); // the same structural check `load` will run later
    return text;
  } catch (err) {
    if (!isBriarError(err)) throw err;
    throw new InvalidDocumentError(`Cannot save context "${doc.id}": ${err.message}`, { cause: err, details: { id: doc.id } });
  }
}

function entryOf(doc: ContextDocument): Entry {
  return {
    id: doc.id, name: doc.name, revision: doc.revision, updatedAt: doc.updatedAt,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    flows: doc.flows.map((f) => ({ id: f.id, name: f.name })),
  };
}
```

That is the whole store: `list` is four lines because core owns the list rules. The next
sections explain the parts that are easy to get wrong.

## 4. Revision checks

Authoring increments `doc.revision` on every change. A client that loaded revision 4 and
edited it saves with `expectedRevision: 4` (the document it sends has revision 5):

```ts
await store.save(edited, { expectedRevision: edited.revision - 1 });
```

Rules to keep:

- **A missing document is revision `0`.** `expectedRevision: 0` means "create, but only if
  nobody else created it first".
- **No `expectedRevision` = unconditional write.** Used by imports and repair tools.
- **Check and write together.** Reading the revision, comparing, and then writing in a
  separate call has a race: two clients both see revision 4 and both "win". The example puts
  the version of `idx/<id>` it read into the `atomic` checks; if anyone wrote in between,
  `atomic` returns `false` and the loop re-reads, now seeing revision 5 and throwing the
  conflict. The conformance suite fires five saves with the same `expectedRevision` at once
  and expects **exactly one** to succeed.
- **Never bump `revision` in the store.** The store saves what it is given.

## 5. Flow-id uniqueness

Flow ids are unique across all contexts, because `/flows/:id` must find exactly one flow.
The store is the only component that sees every context, so it enforces this
(DECISIONS #20):

- Before writing, look up each flow id of the document. If it belongs to a **different**
  context, throw `FlowIdConflictError({ flowId, contextId: owner })`.
- Make the lookup part of the atomic step. The example adds every `flow/<id>` key to the
  checks with the version it read (or `null` if absent), so two contexts racing for the same
  new flow id cannot both win.
- When a save **removes** a flow, delete its key so `locateFlow` returns `undefined` and the id
  can be used elsewhere. Moving a flow from context A to B therefore takes two saves: A
  without it, then B with it.
- A failing save changes **nothing** (the suite checks this).

## 6. `list`: order, search and cursors

Use the core helpers; they are what the built-in stores use, so your store cannot drift:

| Helper | Rule it implements |
|---|---|
| `normalizeListQuery(query)` | `limit` default `CONTEXT_LIST_DEFAULT_LIMIT` (50), clamped to `CONTEXT_LIST_MAX_LIMIT` (200), below 1 or not whole → `store.invalid_query`; `search` trimmed (`""` = no filter), non-string → `store.invalid_query`; `cursor` decoded, garbage or another search's cursor → `store.invalid_cursor`. Returns `{ limit, search, needle, after }`. |
| `matchesContextSearch(entry, q.needle)` | Case-insensitive substring in the context `name`, its `description` and every flow `name`. No ranking. |
| `compareContextOrder(a, b)` | `updatedAt` descending, then `id` ascending, as plain strings (all timestamps are ISO-8601 UTC with `Z`; never parse them into `Date`s). |
| `isAfterCursor(entry, q.after)` | The entry sorts strictly after the cursor position (always true on the first page). |
| `buildContextPage(sorted, q)` | Takes the first `limit` entries, copies them into fresh `ContextSummary`s (no description, no shared arrays) and sets `nextCursor` only when `sorted` has more than `limit` entries. |

Pass `buildContextPage` **at least `limit + 1`** entries when more exist, or it cannot tell
that another page follows. A backend that fetches pages from an index asks for `q.limit + 1`
rows.

A cursor is base64url JSON of `{ updatedAt, id, search }` (`encodeCursor` / `decodeCursor`
in core): the position of the last item of the page. The next page starts with the first item
that sorts **after** that position. This is *keyset* pagination: unlike offsets, it does not skip
or repeat items when earlier pages change length. Rules:

- `nextCursor` is present **only** when more items exist; the last page has none.
- `limit` may change between pages; `search` may not.
- With concurrent writes, a context updated during a walk may be missed or seen twice. That is
  accepted and documented; nothing else may go wrong.

**Scaling up.** The example loads every summary and sorts in memory, which is fine for a few
thousand contexts. A real backend pushes the work down (and still uses
`normalizeListQuery` and `buildContextPage` around its query): a Redis sorted set scored by
`updatedAt`, a SQL index on `(updated_at DESC, id ASC)` with
`WHERE (updated_at, id) < (?, ?)` (see `SqliteContextStore`), or a DynamoDB GSI.

## 7. Corrupt documents

A stored document can become unreadable: a manual edit, a truncated write in a backend
without atomic writes, a document from a newer Briarflow. The rules (storage.md §1.1, §1.4,
DECISIONS #56):

- **`load` throws `StoreCorruptError`** (`store.corrupt`, `details: { id }`, `cause` = the
  `FormatError` from `deserializeContext`). Do not return `undefined`: the document exists,
  and "not found" would let a client create a new one over it.
- **`list` still shows it**, with whatever summary fields could be read (fall back to the id as
  name, revision `0`, `updatedAt` `1970-01-01T00:00:00.000Z`), so people can find it and delete it. The example gets this for free
  because `idx/` is written separately from `ctx/`.
- **An unconditional `save` overwrites it**, so a backup can be restored.
- **`save` with `expectedRevision`:** `SqliteContextStore` compares against its indexed
  revision column (like the example, which uses `idx/`); `FsContextStore` reads the file and
  therefore throws `store.corrupt`. Both are accepted.
- A document whose stored id differs from its key is also corrupt.

Documents with an **older** `formatVersion` are not corrupt: `deserializeContext` migrates
them. A **newer** version throws `format.unsupported_version`, which you wrap in
`StoreCorruptError` like any other read failure (the cause keeps the real reason).

**Raw-write hook.** Conformance check 13 stores an old-format document *without* going
through `save`. The built-in stores expose `writeRaw(id, text)` for this (no validation). For
the example:

```ts
/** Test and repair hook: stores `text` as the document of `id` without any checks. */
async writeRaw(id: string, text: string): Promise<void> {
  let entry: Entry = { id, name: id, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", flows: [] };
  try { entry = entryOf(deserializeContext(text)); } catch { /* keep the placeholder summary */ }
  await this.#kv.atomic([], [{ set: ctxKey(id), value: text }, { set: idxKey(id), value: JSON.stringify(entry) }]);
}
```

`writeRaw` is **not** part of `ContextStore`; application code never calls it. The suite uses
`fixture.writeRaw` if the factory returns one, otherwise `store.writeRaw` (§9).

## 8. A `MediaStore` on bucket storage

Same approach: write against a tiny interface, adapt it to S3/R2/GCS.

```ts
// src/bucket.ts
export interface Bucket {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
  delete(key: string): Promise<boolean>;
  /** Optional: a time-limited GET url (S3 presigned url, GCS signed url). */
  signedGetUrl?(key: string, expiresInSec: number): Promise<string>;
}
```

```ts
// src/bucket-media-store.ts
import { MEDIA_URI_SCHEME, MediaError, canonicalJson, mediaIdFromUri, normalizeMime, sha256Hex } from "@briarflow/core";
import type { MediaRef, MediaStore, PutMediaInfo, StoredMedia } from "@briarflow/core";
import type { Bucket } from "./bucket.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export class BucketMediaStore implements MediaStore {
  readonly kind = "bucket";
  readonly #bucket: Bucket;
  readonly #maxBytes: number | undefined;

  constructor(bucket: Bucket, options: { maxBytes?: number } = {}) {
    this.#bucket = bucket;
    this.#maxBytes = options.maxBytes;
  }

  async put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<MediaRef> {
    const mime = normalizeMime(info.mime); // "Image/PNG; q=1" → "image/png"; else media.invalid_mime
    const meta = { ...info.meta, ...(info.filename !== undefined ? { filename: info.filename } : {}) };
    canonicalJson(meta); // throws json.invalid for non-JSON meta
    const bytes = data instanceof Uint8Array ? data : await readAll(data, this.#maxBytes);
    if (this.#maxBytes !== undefined && bytes.byteLength > this.#maxBytes) {
      throw new MediaError("media.too_large", `Media is larger than the limit of ${this.#maxBytes} bytes.`, { details: { maxBytes: this.#maxBytes } });
    }
    const id = randomId();
    const ref: MediaRef = { uri: MEDIA_URI_SCHEME + id, mime, bytes: bytes.byteLength, hash: await sha256Hex(bytes) };
    if (Object.keys(meta).length > 0) ref.meta = meta;
    await this.#bucket.put(`blobs/${id}`, bytes, mime);
    await this.#bucket.put(`refs/${id}.json`, new TextEncoder().encode(JSON.stringify(ref)), "application/json"); // the ref "commits" the item
    return structuredClone(ref);
  }

  async get(ref: MediaRef | string): Promise<StoredMedia | undefined> {
    const id = idOf(ref);
    const stored = id === undefined ? undefined : await this.#readRef(id);
    const body = stored && (await this.#bucket.get(`blobs/${id}`));
    return stored && body ? { ref: stored, body } : undefined;
  }

  async delete(ref: MediaRef | string): Promise<boolean> {
    const id = idOf(ref);
    if (id === undefined) return false;
    const existed = await this.#bucket.delete(`refs/${id}.json`);
    await this.#bucket.delete(`blobs/${id}`);
    return existed;
  }

  async resolveUrl(ref: MediaRef): Promise<string | undefined> {
    const id = idOf(ref);
    if (id === undefined || !this.#bucket.signedGetUrl) return undefined;
    return this.#bucket.signedGetUrl(`blobs/${id}`, 15 * 60);
  }

  async #readRef(id: string): Promise<MediaRef | undefined> {
    const stream = await this.#bucket.get(`refs/${id}.json`);
    if (!stream) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(await readAll(stream))) as MediaRef;
    } catch (err) {
      throw new MediaError("media.corrupt", `Stored media ${MEDIA_URI_SCHEME}${id} cannot be read. Delete it and upload it again.`, { cause: err, details: { uri: MEDIA_URI_SCHEME + id } });
    }
  }
}

/** Accepts a ref, a briar-media:// uri or a bare id; anything else → undefined. */
function idOf(ref: MediaRef | string): string | undefined {
  const uri = typeof ref === "string" ? ref : ref?.uri;
  if (typeof uri !== "string" || (typeof ref !== "string" && !uri.startsWith(MEDIA_URI_SCHEME))) return undefined;
  return mediaIdFromUri(uri);
}

function randomId(): string {
  const r = crypto.getRandomValues(new Uint8Array(24));
  return "m_" + Array.from(r, (b) => BASE62[b % 62]).join("");
}

async function readAll(stream: ReadableStream<Uint8Array>, maxBytes?: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new MediaError("media.too_large", `Media is larger than the limit of ${maxBytes} bytes.`, { details: { maxBytes } });
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}
```

Points worth knowing:

- **Ids.** `m_` + 24 random base62 characters (never reused after delete), or
  content-addressed. `FsMediaStore` is content-addressed: id = sha-256 hex of
  `canonicalJson({ hash, mime, meta })`, so the same bytes uploaded with another filename get
  their own ref and `get` returns exactly what `put` returned. A content-addressed store
  returns the same ref for the same content and info, an id may come back after delete, and the
  store sets `contentAddressed = true` (storage.md §2.1).
- **Stored mime values** must match `MIME_PATTERN`; `normalizeMime` guarantees it on `put`.
- **`briar-media://` uris belong to one store.** A deployment uses one `MediaStore`; refs from
  another store are not readable.
- **Hashing large files.** The example buffers the body, which is simple and fine for images.
  For large video, stream to a multipart upload and hash while streaming (`node:crypto`
  `createHash("sha256")`, as `FsMediaStore` does), then write the ref last.
- **Write the ref last, delete it first.** Then a crash leaves at most an orphan blob, never a
  ref pointing at nothing.
- **`resolveUrl`.** Return a URL that works without your API's auth, for long enough to finish
  a node run (minutes, not seconds). The Python bridge prefers it over its loopback media
  server, which is what makes **remote** Python workers possible (see
  [python-nodes.md](python-nodes.md#9-media-in-and-out)). Stores without public URLs leave it
  out; the REST API then serves `/media/:id`.
- **No reference counting in v1.** Deleting media that a document still references leaves a
  dangling ref.
- **Reading media in nodes** is not the store's job: nodes call core's
  `readMedia(ref, { media: ctx.media, fetch: ctx.fetch, signal: ctx.signal })`, which uses
  your `get` for `briar-media://` refs and `fetch` for `https://` ones.

## 9. Prove it with the conformance suites

`@briarflow/testing` contains the same tests the built-in stores pass. Run them against your
store and you know it behaves like them: ordering, cursors, revision races, flow-id conflicts,
corrupt documents, unicode, 1 MB texts, empty and 5 MB media, and more (the full list is in
storage.md §3).

```ts
// test/conformance.test.ts
import { describeContextStore, describeMediaStore } from "@briarflow/testing";
import { KvContextStore } from "../src/kv-context-store.js";
import { MemoryKv } from "../src/memory-kv.js";
import { BucketMediaStore } from "../src/bucket-media-store.js";
import { MemoryBucket } from "./memory-bucket.js";

describeContextStore("kv", async () => ({
  store: new KvContextStore(new MemoryKv()),
}));

describeMediaStore("bucket", async () => ({
  store: new BucketMediaStore(new MemoryBucket()),
}));
```

- The **factory is called before every test** and must return a fresh, **empty** store.
- For a real backend, give each test its own namespace (a key prefix, a fresh database or a
  temp bucket path) and return a `cleanup` function that removes it:

  ```ts
  describeContextStore("redis", async () => {
    const prefix = `test-${crypto.randomUUID()}/`;
    const kv = new RedisKv(redis, prefix);
    return { store: new KvContextStore(kv), cleanup: () => kv.dropAll() };
  });
  ```

- The factory returns `{ store, cleanup?, writeRaw?, contentAddressed? }`. `writeRaw` falls
  back to `store.writeRaw` (check 13 is skipped when neither exists); `contentAddressed` falls
  back to `store.contentAddressed === true` (check 6 then expects equal refs for equal
  content). Details: the `@briarflow/testing` README.
- The suites use Vitest (`describe` / `it`); `vitest` is a peer dependency of
  `@briarflow/testing`.

Run `npx vitest run test/conformance.test.ts`. Every failing test names the rule from
storage.md it checks, so fix the store, not the test.

## 10. Wire it in

```ts
import { createBriar } from "briarflow";
import { stdPack } from "@briarflow/nodes-std";
import { KvContextStore } from "./kv-context-store.js";
import { BucketMediaStore } from "./bucket-media-store.js";

const store = new KvContextStore(new RedisKv(redis, "briar/"));
const media = new BucketMediaStore(new S3Bucket(s3, "my-briar-media"));

const briar = createBriar({ store, media, packs: [stdPack] });

// on shutdown
process.once("SIGTERM", async () => {
  await store.close?.();
  await redis.quit();
});
```

Everything else (the REST API, the editor, runs, Python nodes) talks to Briarflow through
these two objects and needs no changes.

## 11. Checklist

- [ ] Documents stored as `serializeContext` text, read with `deserializeContext`.
- [ ] `load` returns a fresh object every time; `save` never changes the document.
- [ ] Revision check, flow-id check and write happen in **one atomic step**; a failed save
      changed nothing.
- [ ] A missing document counts as revision `0`.
- [ ] Removed flows release their ids; `delete` removes the context's flow ids.
- [ ] `list` built from `normalizeListQuery`, `matchesContextSearch`, `compareContextOrder`,
      `isAfterCursor` and `buildContextPage` (or a backend query with the same rules).
- [ ] `locateFlow` is an index lookup.
- [ ] Corrupt documents: `load` throws `StoreCorruptError`; they stay visible in `list`.
- [ ] `close` is idempotent; later calls throw `StoreClosedError`.
- [ ] Media: mime via `normalizeMime`, exact `bytes`, sha-256 `hash`, `meta` + `filename`, a new stream
      per `get`, non-`briar-media://` uris → `undefined`.
- [ ] Errors use the core classes and codes from §2.
- [ ] No `node:*` imports if the store should also run in browsers, Deno, Bun or edge
      runtimes (core's `sha256Hex`, `encodeCursor` and `canonicalJson` are portable).
- [ ] `describeContextStore` / `describeMediaStore` pass.
