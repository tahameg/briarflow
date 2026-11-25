# Media: registry, loader, transient artifacts and last runs

Status: implemented 2026-10-25; values as media structs since 2026-11-25 (types v2). Replaces
`readMedia` of storage.md §2.6.

## 1. Media values

The value of the `binary` primitive is the id of an entry in the **media registry**:

```json
{ "mediaId": "med_3kq9x2LmP0aZ" }
```

The built-in media structs (`Image`, `Video`, `Audio`, `Model3D`, `File`, types.md §1.2) hold
that `binary` in `data`, next to the facts a node reads without the registry:

```json
{ "data": { "mediaId": "med_3kq9x2LmP0aZ" }, "mime": "image/png", "name": "cat.png", "size": 20480, "width": 512, "height": 512 }
```

The registry entry stays authoritative. Before a node runs, facts a value lacks (an empty
`mime`, as in values migrated from format 1, or a `null` size, name, width, height, duration,
fps) are filled from its entry (`completeMediaValues`).

- Validation of a `binary` (types.md §8) checks the shape only: an object with exactly the key
  `mediaId`, matching `^[A-Za-z0-9_-]{1,128}$` → else `media.invalid_ref`.
- Whether the entry exists, its mime against the struct's kind and the struct's limits (its
  static fields `formats`, `maxBytes`, `minWidth`, …) are checked when a node reads it (§4).
- `toText` of a media value is its media id.
- `mediaValue(kind, ref, { mime, bytes, meta })` (core) makes a media struct value from what a
  node put: `return { image: mediaValue("image", ref, { mime: "image/png", meta: { width, height } }) }`.

## 2. The registry

A database of entries (`MediaRegistry`, core). Implementations: `createMemoryMediaRegistry()`
(core, tests and `createBriar()` without storage) and `SqliteMediaRegistry` (storage-sqlite,
table `media_entries`, same file as the contexts).

```ts
interface MediaEntry {
  id: string;
  mime: string;                       // lowercase, no parameters
  source: { kind: "data" }            // bytes in the registry row itself
        | { kind: "stored"; uri: string }  // briar-media://<id> in a blob store (MediaStore)
        | { kind: "link"; url: string };   // http(s) URL, fetched when read
  bytes?: number;
  hash?: string;                      // sha-256, lowercase hex
  meta?: { width?, height?, durationSec?, fps?, filename?, … };
  owner?: { runId: string; flowId?: string; contextId?: string };  // transient entries only
  createdAt: string;
}
```

- `add(entry, data?)` checks the entry (`media.invalid_entry`): valid mime, `data` exactly for
  `data` entries, `briar-media://` uri for `stored`, http(s) url for `link`, meta rules
  (width/height whole > 0, durationSec ≥ 0, fps > 0, filename text). An id in use →
  `media.exists`.
- Entries never change, except the owner of a transient entry (`adopt`, §5).
- `deleteOwned(match)` removes transient entries by owner; `owners()` lists owners for the
  start-up clean-up.
- Images get their width and height from the file header (PNG, JPEG, GIF, WebP) when the
  writer does not give them, so `.width` works on uploads too.

The blob store (`MediaStore`, storage.md §2: `FsMediaStore`, `MemoryMediaStore`) is unchanged
and now only holds `stored` entries' bytes. Its refs are `BlobRef { uri, mime, bytes?, hash?,
meta? }`. A blob saved before the registry existed is found by its blob id: the first lookup
adds a `stored` entry with that id.

## 3. Transient artifacts

What nodes make is **transient**: `ctx.media.put(bytes, { mime, filename?, meta? })` adds a
`data` entry (raw bytes in the registry) owned by the node's run (`{ runId, flowId,
contextId }`). Keeping media for good is an explicit act: uploads (`POST /media`) and links are
kept entries without an owner. A node that stores an artifact for good is future work.

Transient entries live until their run stops being the flow's last run (§5).

## 4. The loader

`createMedia({ registry, blobs?, fetch?, memoryBytes?, memoryItemBytes? })` → `Media`, the one
place that turns a media value into bytes:

1. **Memory first.** Bytes read or written recently, least recently used dropped above
   `memoryBytes` (default 256 MB; items above `memoryItemBytes`, default 64 MB, are not kept).
   Entries are immutable, so a memory copy is never stale; a process that does not have it
   loads it from the registry.
2. Otherwise by the entry's source: `data` → the registry row; `stored` → the blob store
   (`media.unavailable` without one); `link` → `fetch(url)` with the node's signal.
3. Checks: unknown id → `media.not_found`; size different from the entry → `media.corrupt`;
   above `maxBytes` → `media.too_large`; 404 → `media.not_found`, other non-2xx →
   `media.fetch_failed` (`details.status`).

Nodes see `ctx.media: NodeMedia` (the service scoped to the node's run):

```ts
interface NodeMedia {
  put(data: Uint8Array, info: { mime; filename?; meta? }): Promise<MediaRef>;  // transient
  link(url: string, info): Promise<MediaRef>;                                   // transient
  entry(ref): Promise<MediaEntry>;          // media.not_found when gone
  read(ref, { maxBytes? }?): Promise<Uint8Array>;  // treat as read-only (may be shared)
}
// ref: a binary ({ mediaId }), a media struct value (its data is used) or a bare id.
```

Before a catalog node runs, the engine looks up every `binary` in its inputs (typed places;
vars and Json are searched by shape): a missing entry fails the node with `media.not_found`; for
a `binary` inside a media struct, a mime that does not fit the struct's kind fails with
`media.kind_mismatch` and a broken limit with `node.invalid_input` (`checkMediaEntry`).

Packs may keep decoded forms in memory by media id too (the image pack keeps decoded pixels,
256 MB, and leaves the pixels of the PNGs it makes there), since ids never change meaning.

## 5. Last run of a flow and carry-over

The facade keeps one `LastRun` per flow (`LastRunStore`: memory, or `SqliteLastRunStore`, table
`last_runs`):

```ts
interface LastRun {
  runId; contextId; flowId; revision;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  requestedAt; finishedAt?; inputs;
  nodes: Record<nodeId, { state: "completed" | "failed" | "skipped"; outputs?; error?;
                          cached?; durationMs?; skipReason?; cause?; key? }>;
  result?: RunResult;
}
```

- **Requesting a run** replaces the flow's record with a `running` one. The previous record's
  completed nodes with a `key` become the run's carry-over table (`RunOptions.reuse`).
- **Carry-over.** A node takes part when it caches (`cache`, default true), is not a frontend
  node, and has an output whose type holds media. Its reuse key is its cache key (runtime.md
  §6: type, variant, pack, cacheVersion, config, type bindings, inputs with media as their id).
  Same key as a node of the last run → it completes with those outputs (`cached: true`) and does
  not run, provided every media id in them still exists. The same check applies to hits from
  the in-memory result cache. Carried and cached media is **adopted**: its owner becomes the
  new run.
- **Force run** (`force: true` on `engine.run`, `briar.run`, `POST /flows/:id/runs`, the editor's
  "Force run"): no carry-over and no cache reads; the new results are still cached and
  recorded. `useCache: false` reads and writes nothing and records no keys.
- **When the run ends** its record is filled from its events (and the run's `result` resolves
  only after that). Then transient entries of the flow owned by any other run that is not
  running are deleted. A run that is no longer the flow's last run when it ends (a newer one was
  requested) deletes its own entries instead.
- **At start**, records still `running` become `interrupted`, and transient entries whose run is
  no flow's last run are deleted. (One server process per database; two processes sharing one
  database could delete each other's in-flight artifacts.)
- The editor shows the active flow's last run after loading (`backend.lastRun`), so node
  previews survive reloads; a restored run has `restored: true`.

## 6. REST

| Route | |
|---|---|
| `POST /media` | Raw body upload (as before) → `201 MediaEntry` (kept: `stored` with a blob store, else `data`). Use `{ mediaId: entry.id }`. |
| `POST /media/links` | `{ url, mime, filename? }` → `201 MediaEntry` (`link`). |
| `GET /media/:id/entry` | The entry (immutable; cacheable). |
| `GET /media/:id` | The bytes; `link` entries answer `302` to their URL. ETag = hash (or id). |
| `GET /flows/:id/last-run` | `{ lastRun: LastRun \| null }` (permission `runs.read`). |
| `POST /flows/:id/runs` | Body takes `force: boolean`. |

## 7. Python workers

The bridge (python-protocol.md, protocol 2) expands each `binary` (`{ mediaId }`, also the
`data` of a media struct) into `{ uri: "briar-media://<id>", mime, bytes?, hash?, meta?, url }`
(the link's own URL, or the loopback media server). On the way back, `$media` values at
`binary` positions become transient entries, a `briar-media://<id>` uri becomes
`{ mediaId: id }`, and an http(s) uri becomes a link entry.
