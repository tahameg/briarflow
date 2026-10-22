# Spec: Storage contracts

Status: v1 (phase 0; storage decisions of phase 3 added, DECISIONS #56, #57). Owner: ux-designer. Interfaces in `@briarflow/core`;
implementations in `briarflow` (memory), `@briarflow/storage-fs`, `@briarflow/storage-sqlite`;
conformance suites in `@briarflow/testing` (phase 4).

## Deviations from ARCHITECTURE.md

1. **Flow id uniqueness is enforced by `ContextStore.save`** (`FlowIdConflictError`), because
   the store is the only component that sees every context. ARCH says flow ids are unique
   across contexts but not who enforces it.
2. **`MediaStore.put` info accepts `meta?`** (copied into `MediaRef.meta`), so producers can
   record width/height/duration without a second call.
3. **Content-addressed media ids may reappear after delete** (DECISIONS #56): `FsMediaStore`
   derives the id from content + info, so delete followed by an identical `put` returns the
   same id (§2.1). Random-id stores still never reuse ids.

---

## 1. `ContextStore`

```ts
interface ContextStore {
  readonly kind: string;
  load(id: string): Promise<ContextDocument | undefined>;
  save(doc: ContextDocument, options?: { expectedRevision?: number }): Promise<void>;
  delete(id: string): Promise<boolean>;
  list(query?: { search?: string; limit?: number; cursor?: string }): Promise<Page<ContextSummary>>;
  locateFlow(flowId: string): Promise<string | undefined>;
  close?(): Promise<void>;
}
```

**Not part of the interface:** stores may expose `writeRaw(id: string, text: string): Promise<void>`,
which stores `text` as the stored document of `id` with no validation or serialization. It is a
test and repair hook (conformance check 13, corrupt-document tests); `FsContextStore` and
`SqliteContextStore` have it. Application code never calls it.

### 1.1 load
- Returns a document equal (deep) to the last saved one, or `undefined`.
- The returned object is **not shared**: mutating it (which callers must not do anyway) never
  changes what the store holds or what another `load` returns.
- Stores persist via `serializeContext` and read via `deserializeContext` (which runs format
  migrations). A stored document that fails to deserialize → throws `StoreCorruptError`
  (`store.corrupt`, `details: { id }`, `cause` = the `FormatError`, see §5).
- A corrupt document stays in `list` and can be deleted (§1.3, §1.4); an unconditional `save`
  (no `expectedRevision`) overwrites it.

### 1.2 save
- Upsert by `doc.id`. The store does not modify the document (it does **not** bump
  `revision`; authoring did).
- `expectedRevision` given: the stored revision must equal it, where a missing document
  counts as revision `0`. Otherwise throws `RevisionConflictError`
  (`store.revision_conflict`, `details: { id, expected, actual }`, `actual = 0` when missing).
  Message: `Context "{name}" was changed by someone else (revision {actual}, you had {expected}). Reload and try again.`
- `expectedRevision` omitted: unconditional write (also over a corrupt stored document).
- `expectedRevision` given and the stored document is corrupt: the result depends on where the
  store keeps the revision. `FsContextStore` reads it from the file and throws `store.corrupt`;
  `SqliteContextStore` compares against its indexed `revision` column (conflict or write as
  usual). Callers that hit `store.corrupt` should delete or overwrite the context.
- Check-and-write is **atomic** per context (two concurrent saves with the same
  `expectedRevision`: exactly one succeeds).
- Flow ids: if any `doc.flows[i].id` belongs to a **different** stored context → throws
  `FlowIdConflictError` (`store.flow_id_conflict`, `details: { flowId, contextId }`). Atomic
  with the write.
- Invalid input (not an object with `format: "briarflow.context"`, bad id) → `store.invalid_document`.

### 1.3 delete
- Returns `true` if the context existed. Afterwards `load` → `undefined`, `locateFlow` of its
  flows → `undefined`, it disappears from `list`. Deleting twice → second returns `false`.

### 1.4 list
- Items: `ContextSummary { id, name, revision, updatedAt, flows: {id,name}[] }` (flows in
  document order).
- **Order:** `updatedAt` descending, then `id` ascending (ties). `updatedAt` is compared as
  ISO strings (all timestamps are UTC with `Z`).
- **search:** case-insensitive substring match (`toLowerCase()` on both sides, no trimming
  of inner spaces, leading/trailing whitespace of the query trimmed; empty query = no filter)
  against the context `name`, `description`, and every flow `name`. No ranking; order rule
  above still applies.
- **limit:** default 50; values > 200 are clamped to 200; `< 1` or non-integers →
  `store.invalid_query`.
- **cursor:** opaque string from a previous `nextCursor`. The `search` must be the same as in
  the call that produced it; `limit` may change between pages. Keyset pagination on (`updatedAt`, `id`):
  the cursor encodes the last item's position.
  - `nextCursor` is present iff more items exist after this page; the last page has none.
  - With no writes between calls, walking all pages yields every matching context exactly
    once in the order above.
  - With concurrent writes, a context updated during the walk may be missing or appear twice;
    no other guarantees (documented).
  - Malformed cursor or cursor from another search → `store.invalid_cursor` (InvalidCursorError).
- Empty store → `{ items: [] }`.
- **Corrupt documents are listed**, with best-effort summary fields (whatever the store's
  stored text still yields: `id` always; `name` falls back to the id, `revision` to `0`,
  `updatedAt` to `1970-01-01T00:00:00.000Z`, `flows` to the readable `{ id, name }` entries or
  `[]`), so a user can find and delete them. `load` of such an entry throws
  `store.corrupt` (§1.1).
- Core helpers implement these rules (DECISIONS #57, `@briarflow/core`):
  `normalizeListQuery` (limit/search/cursor checks), `matchesContextSearch`,
  `compareContextOrder`, `isAfterCursor`, `buildContextPage`, `CONTEXT_LIST_DEFAULT_LIMIT` (50),
  `CONTEXT_LIST_MAX_LIMIT` (200). All built-in stores use them; third-party stores should too.

### 1.5 locateFlow
- Returns the id of the context that currently contains the flow, or `undefined`. Reflects
  the latest successful save/delete (a save that removed the flow → `undefined`; a flow
  moved by deleting it in A and creating it in B (two saves) → B after the second save).
- Expected to be fast (indexed) — the REST API calls it on every `/flows/:id` request.

### 1.5a `FsContextStore` — one writer process per directory
- `FsContextStore` supports **one writer process per directory**. `load` and the `save`
  revision check read the file, so they see other processes' writes. `list`, `locateFlow`
  and flow-id conflict checks use an in-memory index built at open time; it sees other
  processes' writes only after `refresh()`, which re-reads the index from disk.
- Two processes writing the same directory can break flow-id uniqueness and list order. Use
  `SqliteContextStore` (or a server) when several processes write.

### 1.6 close
- Optional; idempotent. After `close`, other calls throw `store.closed`.

### 1.7 Opening a store
- `new SqliteContextStore(...)` on a database whose `migrations` table records a schema
  version newer than the library knows → `BriarError` `store.unsupported_schema`
  (`details: { schemaVersion, supported }`). Message: `This database uses schema version
  {schemaVersion}; this @briarflow/storage-sqlite supports up to {supported}. Update Briarflow.`

## 2. `MediaStore`

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

### 2.1 Media id and uri scheme
- `uri = "briar-media://" + id`; `id` matches `^[A-Za-z0-9_-]{1,128}$` and is chosen by the
  store. Two schemes are allowed:
  - **Random ids** (memory store): `m_` + 24 random base62 chars. Unique across the store and
    never reused after delete.
  - **Content-addressed ids** (`FsMediaStore`, DECISIONS #56): `id` = sha-256 lowercase hex of
    `canonicalJson({ hash, mime, meta })`, where `hash`, `mime` and `meta` are the fields of
    the returned `MediaRef`. Equal bytes put with a different mime, filename or meta get a
    different id, so `get` returns exactly the ref `put` returned. Equal content + equal info →
    the same ref. An id can reappear after delete + identical `put`. Such stores expose
    `contentAddressed: true` (read by the conformance suite, §3 MediaStore 6).
- `briar-media://` uris are only meaningful to the store that created them; a deployment uses
  one MediaStore.

### 2.2 put
- Reads the whole body; returns `MediaRef { uri, mime, bytes, hash, meta? }`:
  `mime` lowercased and stripped of parameters (`"Image/PNG; q=1"` → `"image/png"`); invalid
  mime → `media.invalid_mime` (core's `normalizeMime` does both; `MIME_PATTERN` is the check); `bytes` = exact length; `hash` = sha-256 lowercase hex of the
  content (always computed); `meta` = `info.meta` plus `filename` when given.
- Empty data is allowed (`bytes: 0`).
- Stores may enforce a size limit → `media.too_large` (`details: { maxBytes }`).

### 2.3 get
- Accepts a `MediaRef`, a `briar-media://` uri, or a bare id. Anything else (e.g. `https://`)
  → `undefined` (the store does not fetch remote URLs; core's `readMedia` (§2.6) does).
- Unknown → `undefined`. Returned `ref` is the stored one (same fields as `put` returned).
- Stored ref data that cannot be parsed → `MediaError` `media.corrupt` (`details: { uri }`).
  Message: `Stored media {uri} cannot be read. Delete it and upload it again.` `delete` still works.
- `body` yields exactly the bytes that were put. Each `get` returns a new stream.

### 2.4 delete
- Same accepted inputs as `get`. Returns `true` if it existed. No reference counting in v1
  (deleting media still referenced by a document leaves a dangling ref).

### 2.5 resolveUrl
- Optional. Returns a URL a browser or Python worker can GET without extra auth (public or
  signed), or `undefined`. Memory and fs stores do not implement it (the REST API serves
  `/media/:id` instead).

### 2.6 `readMedia` (in `@briarflow/core`, DECISIONS #27)

```ts
readMedia(ref: MediaRef | string, options: {
  media: MediaStore;        // used for briar-media:// uris and bare ids
  fetch?: typeof fetch;     // used for https:// and http:// uris; default global fetch
  signal?: AbortSignal;
  maxBytes?: number;        // default: no limit
}): Promise<Uint8Array>
```

- Lives in core (not runtime) so the Python bridge, stores and nodes can use it without
  depending on `@briarflow/runtime`. Nodes call it as
  `readMedia(inputs.image, { media: ctx.media, fetch: ctx.fetch, signal: ctx.signal })`.
- `briar-media://<id>` or bare id → `media.get`; missing → `MediaError("media.not_found")`.
- `https://` / `http://` → `fetch(uri, { signal })`; 404 → `media.not_found`; other non-2xx
  → `media.fetch_failed` (`details: { status, uri }`, DECISIONS #40); network errors propagate (a `TypeError`,
  which the engine maps to the retryable `node.unavailable`).
- More than `maxBytes` bytes → `MediaError("media.too_large")` (`details: { maxBytes }`). A
  `content-length` header above `maxBytes` fails before reading the body; otherwise it stops
  reading as soon as the limit is passed.
- Any other scheme → `MediaError("media.invalid_uri")`.
- Aborting `signal` rejects with the signal's reason.

## 3. Conformance suites (`@briarflow/testing`)

```ts
describeContextStore("sqlite", async () => ({ store: new SqliteContextStore({ file: ":memory:" }), cleanup? }));
describeMediaStore("fs", async () => ({ store: new FsMediaStore({ dir: tmp }), cleanup }));
```

The factory is called before each test (fresh, empty store) and returns
`{ store, cleanup?, writeRaw?, contentAddressed? }`; `writeRaw` / `contentAddressed` fall back
to `store.writeRaw` / `store.contentAddressed` (see `packages/testing/README.md`). Required
checks:

**ContextStore**
1. load of unknown id → `undefined`.
2. save then load → deep-equal; mutation of the loaded object doesn't affect the next load.
3. save is upsert; second save with a new revision replaces.
4. `expectedRevision` correct → ok; wrong → `RevisionConflictError` with `expected/actual`;
   `expectedRevision: 0` on a new id → ok; on an existing id → conflict.
5. Concurrent saves with the same `expectedRevision` (`Promise.all` of 5) → exactly one ok.
6. Flow id belonging to another context → `FlowIdConflictError`; the failing save changed nothing.
7. delete → true then false; load → undefined; list excludes it; locateFlow → undefined.
8. list order (updatedAt desc, id asc) with ≥ 3 ties.
9. list search: name, description and flow name matches; case-insensitivity (`"MARK"` finds
   "Marketing"); non-match → empty.
10. pagination: 7 contexts, limit 3 → pages of 3, 3, 1; last has no `nextCursor`; union =
    all, no duplicates. limit 500 → clamped to 200. Invalid cursor → `store.invalid_cursor`.
11. locateFlow after save, after removing a flow, after delete.
12. Round-trip of a document with every type kind, unicode names, large text (1 MB).
13. Older `formatVersion` document stored raw (via `writeRaw`, §1) is migrated on load
    (skipped if the store cannot inject raw data).
14. close is idempotent; calls after close throw `store.closed`.

**MediaStore**
1. put returns `uri` matching the scheme, correct `bytes`, `hash` (known vector:
   `"hello"` → `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`), normalized mime.
2. put from `Uint8Array` and from `ReadableStream` (chunked) give identical results.
3. get by ref, by uri, by id → same bytes; unknown → undefined; `https://…` → undefined.
4. Empty and 5 MB payloads round-trip.
5. delete → true then false; get after delete → undefined.
6. ids unique over 1000 puts of identical content (unless content-addressed: then same ref,
   and the test accepts either via a `contentAddressed` flag).
7. meta and filename preserved.
8. If `resolveUrl` exists: returns a string URL or undefined.

## 4. Outline of `docs/guides/writing-a-store.md` (written in phase 4)

1. **When to write a store** — new database, cloud bucket, git-backed contexts.
2. **The contract in 10 lines** — load/save/delete/list/locateFlow; links to this spec.
3. **Step by step: a `RedisContextStore`**
   - storing serialized documents (`serializeContext` / `deserializeContext`)
   - revision check-and-write atomically (transaction / WATCH / compare-and-swap)
   - flow index for `locateFlow` and flow-id conflicts
   - list ordering, search and keyset cursors (with a cursor encoding helper from
     core: `encodeCursor` / `decodeCursor`, base64url JSON of `{ updatedAt, id, search }`)
4. **Running the conformance suite** — `describeContextStore` setup, fresh store per test,
   cleanup.
5. **A MediaStore on S3-like storage** — ids, hashing while streaming, `resolveUrl` with signed
   URLs, size limits.
6. **Wiring it in** — `createBriar({ store, media })`, closing on shutdown.
7. **Checklist** — errors use the right classes/codes, no shared mutable objects, atomic
   saves, no Node-only imports if the store targets browsers/edge.

## 5. Documents and serialization helpers (core) — errors

These core helpers are used by every store and client; their thrown codes are part of the
contract (DECISIONS #28 for the format).

| Function | Code | When | Message / details |
|---|---|---|---|
| `createContextDocument` | `document.invalid_id` | `id` given and not a valid context id (types.md §1) | `"{id}" is not a valid context id. Expected {pattern}.` |
| `createContextDocument` | `document.invalid_name` | name empty after trimming, or > 120 chars | `Context name must be 1–120 characters (got {n}).` |
| `createFlowDocument` | `document.invalid_id` | flow id or `inputNodeId` / `outputNodeId` invalid, or input and output node ids equal | as above, naming the kind |
| `createFlowDocument` | `document.invalid_name` | name empty after trimming, or > 80 chars, or contains control chars | `Flow name must be 1–80 characters without control characters.` |
| `deserializeContext` | `format.invalid` | not JSON, `format` ≠ `"briarflow.context"`, missing `formatVersion`, missing or ill-typed fields | `Not a Briarflow context: {problem} at {path}.` `details: { path }` (dotted, e.g. `flows[0].nodes[2].position.x`; `""` for the root) |
| `deserializeContext` | `format.unsupported_version` | `formatVersion` present but not a positive integer, or newer than the library | `This context uses format version {v}; this Briarflow supports up to {supported}. Update Briarflow.` `details: { formatVersion, supported }` |
| `canonicalJson`, `jsonEquals` | `json.invalid` | `NaN`/`±Infinity`, functions, symbols, bigints, cycles | `Value is not JSON: {problem} at {path}.` `details: { path }` |

- Both document errors are `BriarError`s (no subclass); format errors are `FormatError`.

Store error codes (all stores; classes in `@briarflow/core`):

| Code | Class | When | details |
|---|---|---|---|
| `store.revision_conflict` | `RevisionConflictError` | §1.2 | `{ id, expected, actual }` |
| `store.flow_id_conflict` | `FlowIdConflictError` | §1.2 | `{ flowId, contextId }` |
| `store.invalid_document` | `InvalidDocumentError` | §1.2 | — |
| `store.invalid_query` | `InvalidQueryError` | §1.4 limit / search | `{ limit }` or `{ search }` |
| `store.invalid_cursor` | `InvalidCursorError` | §1.4 | — |
| `store.corrupt` | `StoreCorruptError` | §1.1 load, §1.2 fs revision check | `{ id }`, `cause` |
| `store.closed` | `StoreClosedError` | §1.6 | — |
| `store.unsupported_schema` | `BriarError` | §1.7 | `{ schemaVersion, supported }` |
| `media.invalid_mime` | `MediaError` | §2.2 | `{ mime }` |
| `media.too_large` | `MediaError` | §2.2, §2.6 | `{ maxBytes }` |
| `media.corrupt` | `MediaError` | §2.3 | `{ uri }` |
| `media.not_found`, `media.fetch_failed`, `media.invalid_uri` | `MediaError` | §2.6 | see §2.6 |
- `deserializeContext` keeps unknown extra keys (forward compatibility). `jsonEquals` is
  defined as equality of `canonicalJson` output, so it throws the same `json.invalid`
  (DECISIONS #38, #39).
- `deserializeContext` only checks structure; semantic problems (unknown types, broken edges)
  are diagnostics of `validateContext`, not throws.
- `serializeContext` output: keys sorted at every level, 2-space indent, trailing newline.
