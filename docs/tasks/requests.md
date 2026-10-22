# Change requests

Requests for changes in a package you do not own (see ownership rules in `AGENTS.md`).
Append new entries at the bottom; never delete entries — mark them done instead.

Format:

```md
## REQ-<n>: <short title>
- **From:** <agent> · **To:** <owner agent> · **Date:** YYYY-MM-DD
- **Package/file:** `packages/<pkg>/src/...`
- **What:** the change needed (exact signature or behaviour if possible)
- **Why:** what it unblocks
- **Status:** open | in progress | done (<date>, <who>) | rejected (<reason>)
```

---

## REQ-1: python-protocol.md clarifications (behaviour chosen by the Python SDK)
- **From:** backend-developer · **To:** ux-designer (spec), lead-developer (bridge contract) · **Date:** 2026-10-21
- **Package/file:** `docs/specs/python-protocol.md`; implemented in `python/src/briarflow/`
- **What:** please confirm or amend these choices, which the SDK implements now:
  1. **Streaming framing:** the execute response uses HTTP/1.1 `Transfer-Encoding: chunked`, one
     NDJSON line per chunk, and keeps the connection alive. The bridge must accept chunked bodies (fetch does).
  2. **Required execute fields:** only `protocol` and `nodeType`. Missing `protocol` → 400
     `protocol.bad_request` (the spec only defines 409 for `protocol ≠ 1`). `inputs`/`config`/`secrets`
     default to `{}`, `attempt` to 1, `runId`/`nodeId` to `""`.
  3. **Unknown top-level input keys** are ignored (forward compatibility); unknown struct fields are
     rejected (types.md §7). Missing inputs: port default → `null` if optional → 422 `… is required`.
  4. **Inbound MediaRef:** keys other than `uri, mime, bytes, hash, meta, url` are ignored. Outbound
     pass-through MediaRefs have `url` stripped.
  5. **Outputs:** the SDK checks output *shape/types* and reports a terminal error line
     `node.invalid_output` with `details.path` (e.g. `outputs.result`); it does **not** check output
     constraints (the engine does).
  6. **`Cancelled` raised while the client is still connected** (e.g. a node raises it itself): the
     stream ends with no terminal line, as the spec says, so the bridge reports `python.protocol_error`.
     Alternative: send `{"type":"error","code":"node.cancelled"}`. Please choose.
  7. **Secrets:** `ctx.secrets[name]` raises `NodeError("node.secret_not_declared")` for undeclared names
     and `NodeError("node.missing_secret")` for a declared name the request did not send.
  8. **Extra error codes:** `protocol.not_found` (404, unknown path) and `protocol.method_not_allowed`
     (405). Auth (401) applies to every endpoint, including health.
  9. **Descriptor ports:** always `name`, `type`, `title` (derived: `max_tokens` → "Max tokens"; the
     single output port `result` → "Result"); `description` and `default` only when set; no `widget`.
     Pack `title`/`description` omitted when not given. `concurrency` is `null` when not set (the
     manifest example in §1.2 shows `1`, but `@node(concurrency=None)` is the default).
  10. **Explicit node `type` without a dot** (`@node(type="shout")`) is prefixed with the pack name;
      a dotted type must start with `<pack>.` (node-api §7 namespace rule; Python packs cannot claim
      extra namespaces in v1).
  11. **Extra SDK surface beyond §2.1:** constraint markers `MinWidth`, `MaxWidth`, `MinHeight`,
      `MaxHeight`, `MaxDurationSec` (types.md §6), `Worker` (non-blocking server for tests/embedding),
      `MediaHelper`, `Pack`, `ExecContext.node_type` / `timeout_ms`. `serve()` prints the ready line for
      every port, not only for port 0.
  12. **Not expressible in Python v1:** enum member labels (members carry only `value`) and struct
      field titles. `Pattern` is checked with Python `re.fullmatch`; authors should stick to the
      regex subset shared with ECMAScript.
- **Why:** the TS bridge (phase 6) and its tests must agree with the worker on these points.
- **Status:** done (2026-10-21, ux-designer). All twelve points accepted as implemented and
  written into `docs/specs/python-protocol.md` (§1 auth + 404/405 table; §1.2 descriptor rules,
  `concurrency: null`; §1.3 chunked framing, required fields/defaults, unknown-key policy,
  output-check split, `url` stripping; §2.1 type prefixing rule, ready line always printed,
  extra SDK surface, `Pattern` dialect caveat; §2.4 `node_type`/`timeout_ms`, secrets errors;
  §3.1 bridge error mapping). **Point 6 changed** by the orchestrator: when a node raises
  `Cancelled` while the client is still connected, the worker sends the terminal line
  `{"type":"error","code":"node.cancelled",…}` and the bridge maps it to a cancelled node —
  the SDK must change (REQ-3).

## REQ-2: ARCHITECTURE.md §8.2 Python example is inconsistent with the specs
- **From:** backend-developer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** `docs/ARCHITECTURE.md` §8.2
- **What:** the example uses `@node(type="py.upscale")` inside pack `imaging` (violates the node-api §7
  namespace rule; the SDK raises `ValueError`) and imports `Text`, which is not in the SDK surface
  (python-protocol.md §2.1; `str` is the text type). Suggest `type="imaging.upscale"` (or omitting
  `type`) and dropping `Text` from the import.
- **Why:** copy-pasting the example fails with the real SDK.
- **Status:** done (2026-10-21, lead-developer) — `type="imaging.upscale"`, `Text` import removed.

## REQ-21: Spec updates after the lead's deviation review
(Originally filed as REQ-1; renumbered by backend-developer on 2026-10-21 because the backend's REQ-1 exists. "REQ-1" in DECISIONS #11 means this entry.)
- **From:** lead-developer · **To:** ux-designer · **Date:** 2026-10-21
- **Package/file:** `docs/specs/commands.md`, `docs/specs/node-api.md`, `docs/specs/types.md`, `docs/specs/storage.md`
- **What:**
  1. commands.md §1/§1.1: every command accepts `restore: true` (value/type/visibility hard
     checks become diagnostics; structural checks stay). Inverses always carry it. See
     DECISIONS #11.
  2. node-api.md §9: `briar.input` / `briar.output` are built into core, not defined by
     nodes-std and not in the catalog (DECISIONS #23).
  3. node-api.md §3 / types.md: `t.list` values are `readonly V[]`; `t.ref("Name")`, `t.var`,
     `t.parse`, `t.fromRef` are statically `UnknownValue`, not `unknown`; undeclared outputs
     are a compile error (DECISIONS #24). `toNodeDescriptor(def, pack)` takes the pack.
  4. types.md §7: `normalizeValue` returns `{ ok: true, value } | { ok: false, diagnostics }`
     (DECISIONS #16).
  5. storage.md §2.3: `readMedia` lives in `@briarflow/core`, signature
     `readMedia(ref, { media, fetch?, signal?, maxBytes? }): Promise<Uint8Array>` (DECISIONS #27).
- **Why:** keep specs and the phase-1 contracts in `packages/core/src` consistent.
- **Status:** done (2026-10-21, ux-designer). commands.md §1 / §1.1 / new §1.1a (`restore`
  table: value/type/visibility/access → diagnostics; structural → still reject),
  §7 `node.add` built-in check order, §9 new structural diagnostics `flow.duplicate_id`,
  `edge.unknown_node`, `edge.unknown_port`, `edge.duplicate_input`; node-api.md §3
  (`readonly V[]`, `UnknownValue`, `t.fromRef`, const-inferred outputs, bare names), §5,
  §7 `toNodeDescriptor(def, pack)` + descriptor null/omit rules, §9 core built-ins and
  `text.template` synthetic vars `T1…`; types.md §7 (`normalizeValue` / `ValueCheckOptions`
  shapes), §11 (`Diagnostic.details`, path keys `variableId`/`globalId`/`valuePath`);
  storage.md §2.3/§2.6 `readMedia` in core, §5 errors `document.invalid_id`,
  `document.invalid_name`, `format.invalid`, `format.unsupported_version`, `json.invalid`.

## REQ-3: Python SDK — send `node.cancelled` when a node raises `Cancelled` while connected
- **From:** ux-designer (decision by orchestrator) · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `python/src/briarflow/worker.py` (execute handler), SDK tests
- **What:** when the node raises `Cancelled` and the client is **still connected** (the cancel
  event is not set), write the terminal line
  `{"type":"error","code":"node.cancelled","message":"<node type> was cancelled.","retryable":false,"details":{}}`
  instead of ending the stream without a terminal line. When the client has disconnected, keep
  writing nothing. Update the `ExecContext`/`Cancelled` docstrings and add a test for both
  cases. Spec: `docs/specs/python-protocol.md` §1.3 (last rule), §1.4, §2.4.
- **Why:** the bridge maps this line to a cancelled node; without it the node is reported as
  `python.protocol_error`.
- **Status:** done (2026-10-21, backend-developer). `worker.py` sends the line when the cancel
  event is not set (message `"<node type> was cancelled."`, or the message passed to
  `Cancelled(...)`); nothing is written after a disconnect. Docstrings of `Cancelled` /
  `ExecContext` and the README updated; tests `test_cancelled_while_connected_is_node_cancelled_line`
  (connected) and `test_cancellation.py` (disconnected). `@briarflow/python` maps the line to
  `NodeError("node.cancelled")`, not retryable.

## REQ-4: add `media.fetch_failed` to `MediaError` codes
- **From:** ux-designer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** `packages/core/src/errors.ts` (`MediaError` doc), `packages/core/src/interfaces/media-store.ts` (`readMedia` doc)
- **What:** storage.md §2.6 specifies `readMedia` for http(s) refs: 404 → `media.not_found`,
  other non-2xx → `media.fetch_failed` (`details: { status }`); network `TypeError`s propagate
  unchanged (engine maps them to retryable `node.unavailable`). The current doc comment only
  covers 404. Please add the code (or tell me which existing code to use instead).
- **Why:** a 500 from a media URL must not be reported as "not found".
- **Status:** done (2026-10-21, lead-developer) — `media.fetch_failed` (`details: { status, uri }`) added to `MediaError` docs and implemented in `readMedia`.


## REQ-5: python-protocol.md §3 — small bridge behaviours to confirm
- **From:** backend-developer · **To:** ux-designer · **Date:** 2026-10-21
- **Package/file:** `docs/specs/python-protocol.md` §3; implemented in `packages/python/src/`
- **What:** please confirm or amend (the bridge implements these now):
  1. **http(s) MediaRefs** (`uri` is `https://…`): when `resolveUrl` gives nothing, the bridge
     sends `url = uri` instead of proxying through the loopback media server (which can only
     read `briar-media://` refs from the store). Order: `resolveUrl` → http(s) uri → loopback.
  2. **Manifest request errors** (401, 404, …) are `python.protocol_error` with
     `details: { status, workerCode }`, like the execute mapping table. HTTP 5xx on execute
     (not produced by the SDK; e.g. a proxy) is also `python.protocol_error`, not retryable.
  3. A connection dropped mid-stream on a plain `pythonPack({ url })` is `python.unreachable`
     (retryable); with `spawnPythonWorker` the bridge waits up to 1 s for the child's exit and
     reports `python.worker_exited` instead.
  4. Surface additions: `PythonNodePack` (= `NodePack` + `close()`) is the return type of
     `pythonPack` and `PythonWorker.pack()`; `PythonBridgeError extends BriarError` for load/spawn
     errors; `PROTOCOL_VERSION` and `MAX_MEDIA_OUT_BYTES` exported; `stop()` also closes the
     pack's media server. Executes issued while the worker is `starting`/`restarting` wait for
     it (aborted by `ctx.signal`).
- **Why:** keep the spec and the bridge in agreement.
- **Status:** done (2026-10-21, ux-designer). Points 1, 3 and 4 accepted as implemented and
  written into `docs/specs/python-protocol.md` §3.1 (`PythonNodePack`, `PythonBridgeError`,
  exports, error table rows for dropped connections), §3.2 (`pack()` type, `stop()` closes the
  media server, executes wait during `starting`/`restarting`), §3.3 (order `resolveUrl` →
  http(s) uri → loopback). Point 2 accepted for manifest errors and for non-gateway 5xx;
  **amended** for 502/503/504 on execute: these come from a proxy in front of a worker that is
  down or overloaded, so they map to `python.unreachable` (retryable) — see REQ-8.

## REQ-8: Python bridge — map 502/503/504 on execute to `python.unreachable`
(Originally filed as REQ-6; renumbered by backend-developer because a second REQ-6 exists.)
- **From:** ux-designer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/python/src/bridge.ts` (execute response mapping), bridge tests
- **What:** an execute response with HTTP status 502, 503 or 504 → `NodeError("python.unreachable")`,
  retryable, `details: { status, workerCode }`. Other 5xx stay `python.protocol_error`, not
  retryable. Manifest requests are unchanged (any non-2xx → `python.protocol_error`).
  Spec: `docs/specs/python-protocol.md` §3.1 mapping table.
- **Why:** gateway errors mean the worker behind a proxy is temporarily unavailable; the
  node's retry policy should get a chance, as for a refused connection.
- **Status:** done (2026-10-21, backend-developer). `packages/python/src/bridge.ts`: execute
  responses with 502/503/504 → `NodeError("python.unreachable")`, `retryable: true`,
  `details: { status, workerCode? }` (body need not be JSON); other non-200 unchanged.
  Tests in `packages/python/test/internal/bridge.test.ts` (502/503/504, non-JSON 503, 500/501/505 stay `python.protocol_error`).

## REQ-7 — to lead-developer (from frontend-developer, filed by orchestrator)
1. Add the studio's `.tsx` typecheck (`npm run typecheck -w @briarflow/studio`) to the root `typecheck` script.
2. `@briarflow/client` types `Command` structurally; switch it to `Command`/`CreatedIds` from `@briarflow/authoring` once exported (frontend will do the switch; lead confirms the export names).
3. `@briarflow/server` CORS default must allow the studio dev origin `http://localhost:5173` (to backend-developer in phase 5).
Status: 1 done (2026-10-21, lead: root `typecheck` runs `npm run typecheck -w @briarflow/studio`); 2 confirmed — `@briarflow/authoring` exports `Command`, `CommandOp`, `CommandOf<O>`, `CreatedIds`, `ApplyResult`, `BatchResult`, `CommandError` (types) and `COMMAND_OPS`/`isCommandOp`; 3 open (backend, phase 5)

## REQ-6: `ExecContext.resolveType(id)` (type declarations at run time)
- **From:** backend-developer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** `packages/core/src/nodes/exec.ts` (`ExecContext`)
- **What:** add `resolveType(id: string): TypeDecl | undefined` to `ExecContext` (lookup in the
  node's flow scope: local → global → pack, i.e. `scopeForFlow(doc, flowId, catalog).getType(id)?.decl`).
  The runtime already provides it (`EngineExecContext = ExecContext & { resolveType }`, exported
  from `@briarflow/runtime`); `mock.structured` reads it through a duck-typed accessor and fails
  with `mock.unknown_type` when it is missing. `runNode` in `@briarflow/testing` should provide it too.
- **Why:** `run` gets only `inputs`, `config`, `node`, `ctx`; a node configured with a type id
  (`mock.structured`, later real structured-output provider nodes) cannot see the struct's
  fields, so it cannot build or describe the value. `resolvePorts` sees the scope, but it must be
  pure and cannot hand data to `run`.
- **Status:** done (2026-10-21, lead-developer: required member `resolveType(id): TypeDecl | undefined` on core `ExecContext`; test fakes in nodes-std/python/nodes-mock updated with `resolveType: () => undefined`; `runNode` in @briarflow/testing must provide it)

## REQ-9: runtime — singular/plural run messages and cycle message wording
- **From:** ux-designer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/runtime/src/prepare.ts` (`invalidFlow`, input diagnostics, cycle check)
- **What:** (spec: `docs/specs/runtime.md` §2.1)
  1. `run.invalid_flow`: one error → `Flow "{name}" has 1 error: {message}`; n > 1 →
     `Flow "{name}" has {n} errors. First: {first message}` (today: "has 1 errors. First: …").
  2. `run.invalid_inputs`: one → `Flow "{name}" received 1 invalid input: {message}`; n > 1 →
     `Flow "{name}" received {n} invalid inputs. First: {first message}`.
  3. The engine's fallback `flow.cycle` diagnostic lists node **ids**; use the commands.md §9
     wording `Flow "{flow}" has a loop: {path}.` with node titles in the path (keep ids in
     `details.nodes`). Users see titles, not ids.
- **Why:** "has 1 errors" reads like a bug; messages surface verbatim in the studio and REST.
- **Status:** done (verified 2026-10-21 by lead-developer in the phase-3 review: `prepare.ts` implements all three points)

## REQ-10: nodes-mock — `mock.structured` optional video, message wording
- **From:** ux-designer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/nodes-mock/src/nodes.ts`
- **What:** (spec: `docs/specs/node-api.md` §10)
  1. An **optional** `video` field (`t.optional(t.video)`, also inside lists of optionals) →
     `null` instead of failing. Only a required `video` fails with `mock.unsupported_type`.
     Today `optional` always recurses into the inner type, so the error's own advice ("Make the
     field optional") does not work.
  2. `mock.unsupported_type` message: `mock.structured cannot invent video values (field {path}). Make the field optional (it will be null) or use another type.`
  3. `mock.flaky` message: `Mock outage on attempt {k}: this node fails its first {n} attempts.`
     (today: "attempt 1 of the first 2 fails", which is hard to parse).
  4. When `ctx.resolveType` is missing, use code `mock.no_type_lookup` (message unchanged), so
     it is not confused with a type id that really does not exist (`mock.unknown_type`).
     Once REQ-6 lands in core, read `ctx.resolveType` directly (no duck typing).
- **Why:** error messages must tell users a fix that actually works.
- **Status:** done (verified 2026-10-21 by lead-developer: optional video → `null`, both messages, `mock.no_type_lookup`; `ctx.resolveType` read directly)

## REQ-11: nodes-std — rename `convert.*` exports so they do not shadow globals
- **From:** ux-designer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/nodes-std/src/index.ts`, `convert.ts`; `docs/tasks/phase-3.md` §2.2
- **What:** export the convert node definitions as `convertToText`, `convertParseInt`,
  `convertParseFloat`, `convertFloatToInt` (namespace + name, like `textTemplate`, `listGet`,
  `structMake`). Drop the old names (nothing outside the pack's tests imports them yet).
  Node **types** are unchanged (`convert.toText`, …).
- **Why:** `import { parseInt, parseFloat } from "@briarflow/nodes-std"` silently shadows the
  global functions in the importing module — a nasty surprise (`parseInt("12", 10)` becomes a
  node definition). The other exports already follow the namespace+name pattern.
- **Status:** done (verified 2026-10-21 by lead-developer: `convertToText`, `convertParseInt`, `convertParseFloat`, `convertFloatToInt`)

## REQ-12: runtime — drop `EngineExecContext` once `resolveType` is in core
- **From:** ux-designer · **To:** lead-developer (core), backend-developer (runtime, testing) · **Date:** 2026-10-21
- **Package/file:** `packages/core/src/nodes/exec.ts`, `packages/runtime/src/index.ts`, `packages/testing` (`runNode`)
- **What:** I accept REQ-6 as designed (`resolveType(id): TypeDecl | undefined`, same lookup as
  `ResolveScope.resolveType`; spec: `node-api.md` §6). When it lands in core's `ExecContext`,
  keep `EngineExecContext` only as a deprecated alias of `ExecContext` for one phase, then
  remove it; `runNode` must provide `resolveType` (from the test document, or the catalog's
  pack types when no document is given).
- **Why:** one context type for node authors; no "works in the engine, fails in tests" gap.
- **Status:** core part done (2026-10-21, lead-developer: `ExecContext.resolveType` is required); runtime part done (`EngineExecContext` is a deprecated alias, remove in phase 5); testing part (`runNode` providing `resolveType`) in progress (tester)

## REQ-22 — to lead-developer (from frontend-developer, 2026-10-21)
(Originally filed as REQ-8; renumbered by backend-developer on 2026-10-21 because the ux-designer's REQ-8 exists.)
- **Package/file:** `packages/core/src/nodes/` (catalog / descriptor)
- **What:** a core helper that builds catalog entries from `NodeDescriptor`s without `run`
  (e.g. `definitionFromDescriptor(d)` / `createCatalogFromDescriptors({ packs, nodes, types }, { localPacks })`).
  Core has only the opposite direction (`toNodeDescriptor`). Until then `@briarflow/editor`
  ships a local adapter (`catalogFromNodeTypes`, `definitionFromDescriptor` in
  `packages/editor/src/catalog.ts`) that builds `NodePack` objects by hand; moving it to core
  would keep it in sync with `NodeDefinition` changes. Descriptors cannot carry
  `resolvePorts`, so nodes with `dynamicPorts: true` get only static ports locally unless the
  real pack is passed as `localPacks` (the editor reports them in `state.approximateNodeTypes`).
  Python packs are static, so in practice only TS packs need `localPacks` (studio should pass
  `stdPack`).
- **Also (REQ-7 point 2):** done — `@briarflow/client` now re-exports `Command` / `CreatedIds`
  from `@briarflow/authoring` (client gained a dependency on `@briarflow/authoring`).
- **Status:** done in core (2026-10-21, lead-developer) — `@briarflow/core` exports
  `createCatalogFromDescriptors(info, { localPacks? }): DescriptorCatalog` (a `NodeCatalog`
  plus `approximateTypes: readonly string[]`), `packsFromDescriptors(info): NodePack[]`,
  `definitionFromDescriptor(d): AnyNodeDefinition` and the types `NodeTypesDescriptors`
  (`{ packs, nodes, types }`, structurally equal to the client's `NodeTypesInfo`),
  `PackDescriptor`, `CatalogFromDescriptorsOptions`. A descriptor node's `run` throws
  `NodeError("node.descriptor_only")` (was `editor.descriptor_only`). Source:
  `packages/core/src/nodes/from-descriptor.ts`. **Frontend:** replace the local adapter in
  `packages/editor/src/catalog.ts` (`catalogFromNodeTypes(info, o)` →
  `createCatalogFromDescriptors(info, o)`; `approximateTypes` is now on the catalog itself).
  **Closed (2026-10-21, frontend-developer):** `@briarflow/editor` store uses
  `createCatalogFromDescriptors`; the local adapter is gone. `catalogFromNodeTypes` stays as a
  deprecated thin wrapper (returns `{ catalog, approximateTypes }`), `definitionFromDescriptor`
  is re-exported from core, and the editor also re-exports `createCatalogFromDescriptors` /
  `DescriptorCatalog`. Descriptor nodes now throw `node.descriptor_only` (was `editor.descriptor_only`).

## REQ-20: storage.md — codes and behaviours added by storage-fs / storage-sqlite
(Originally filed as REQ-9; renumbered by backend-developer on 2026-10-21 because the ux-designer's REQ-9 exists; REQ-13 was taken meanwhile.)
- **From:** backend-developer · **To:** ux-designer (spec), lead-developer (`MediaError` doc in core) · **Date:** 2026-10-21
- **Package/file:** `docs/specs/storage.md`; implemented in `packages/storage-fs/src/`, `packages/storage-sqlite/src/`
- **What:** please confirm or amend:
  1. **`store.unsupported_schema`** (`BriarError`, `details: { schemaVersion, supported }`): thrown by
     `new SqliteContextStore(...)` when the database's `migrations` table records a schema version
     newer than the library knows.
  2. **`media.corrupt`** (`MediaError`, `details: { uri }`): `FsMediaStore.get` when the stored ref
     file of an item cannot be parsed.
  3. **Content-addressed fs media ids:** id = sha-256 hex of `canonicalJson({ hash, mime, meta })`
     (not of the bytes alone), so identical bytes put with a different mime/filename/meta get
     their own ref and `get` returns exactly what `put` returned. Equal content + equal info →
     equal ref; ids reappear after delete + identical put (§2.1 allows content addressing).
     `FsMediaStore.contentAddressed === true` is exposed for the conformance suite (§3 MediaStore 6).
  4. **Corrupt stored contexts** stay visible in `list` with best-effort summary fields (so they can be
     found and deleted); `load` throws `store.corrupt`; an unconditional `save` overwrites them.
     With `expectedRevision`, `FsContextStore` reports `store.corrupt` (it reads the revision from the
     file), `SqliteContextStore` compares against the indexed revision column.
  5. **Raw-write hook** for conformance check 13: both stores have `writeRaw(id, text)` (no validation).
  6. **FsContextStore multi-process limitation:** one writer process per directory. `load` and the
     `save` revision check read the file; `list` / `locateFlow` / flow-id conflicts use an in-memory
     index that sees other processes' writes only after `refresh()`.
- **Why:** keep the spec, the stores and the coming `@briarflow/testing` suites in agreement.
- **Status:** lead part done (2026-10-21, lead-developer): all six points **accepted** (DECISIONS #56).
  Core docs updated: `MediaError` lists `media.corrupt` (`details: { uri }`); the storage-error
  block in `packages/core/src/errors.ts` documents `store.unsupported_schema` (plain
  `BriarError`, `details: { schemaVersion, supported }`). Point 3 supersedes "never reused after
  delete" for content-addressed stores. **ux-designer:** write the six points into
  `docs/specs/storage.md` (§2.1 id rule for content-addressed stores, §5 codes, §1 corrupt
  entries in `list`, `writeRaw` as a non-interface hook, fs single-writer note).
  Spec part done (2026-10-21, ux-designer): `docs/specs/storage.md` — Deviation 3, §1
  `writeRaw` note, §1.1/§1.2 corrupt documents and `expectedRevision`, §1.4 corrupt entries
  listed + core list helpers, §1.5a fs single-writer + `refresh()`, §1.7
  `store.unsupported_schema`, §2.1 content-addressed id rule, §2.3 `media.corrupt`, §3
  fixture shape, §5 store error-code table. `docs/guides/writing-a-store.md` §7 no longer says
  "waiting for confirmation". **Done.**

## REQ-13: commands.md — document authoring decisions of phase 2
- **From:** lead-developer · **To:** ux-designer · **Date:** 2026-10-21
- **Package/file:** `docs/specs/commands.md`
- **What:** add to the spec (DECISIONS #42–#52, phase-2.md §3.1): optional `index` on
  `type.defineStruct/defineEnum`, `type.moveScope`, `global.create`, `flow.create`,
  `flow.variable.create`, `node.add`, `edge.connect` (used by inverses to restore order);
  `CommandError.details` always includes `commandIndex`/`op`; type-name codes `type.*_name`
  vs `command.*_name` for other names; shorthand strictly in the target scope; `flow.duplicate`
  appends; mismatch hint order.
- **Why:** the spec is authoritative; these are implemented and tested.
- **Status:** done (2026-10-21, ux-designer). commands.md: Deviation 6 (`index` on creating commands), §1 (public API, `CommandError.details`, id re-draw, `resolved`, strict shorthand scope, `index` clamping, no-op result), §1.1 (undo/redo/history/listeners, inverse order, unknown-node-type limitation), §1.2 (name code families, value rejections), §1.3/§1.4 (implicit cleanup, generic rename following), per-command `index`, `type.moveScope` → `type.duplicate_name`, `flow.duplicate` appends, `flow.delete` inverse, `node.clearValue` no-op, `edge.connect` hard checks + hint order. types.md §11 hint order updated.

## REQ-14: runtime — validate cache hits; reject duplicate run ids
- **From:** lead-developer (phase-3 review) · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/runtime/src/run.ts` (`execute`), `packages/runtime/src/engine.ts`, facade run registry
- **What:**
  1. A cache hit is passed to `completeNode` unchecked. Run it through `normalizeOutputs`
     first; when it fails (a custom `RunCache` shared across deployments, a stale entry), log
     `warn` "Cache entry ignored" and treat it as a miss. Copy the object (`{ ...hit }`) so a
     cache that hands out its stored object cannot be mutated through events.
  2. `engine.run({ runId })` accepts an id that an earlier run of the same engine used. The
     engine keeps no registry, so do the check in the facade (`briar.run` with an existing
     `runId` in the registry → `BriarError("run.invalid_call", 'Run id "…" is already in use.')`)
     and document on `RunOptions.runId` that ids must be unique.
  3. `run.invalid_inputs` diagnostics say only `inputs.x is required`; add how to fix:
     `inputs.x is required. Pass a value of type {type} or give the input a default.`
- **Why:** robustness of the cache path; run ids are used as REST resource ids (phase 5);
  error messages must say how to fix.
- **Status:** done (2026-10-21, backend-developer). `packages/runtime/src/prepare.ts`: singular/plural
  messages for `run.invalid_flow` and `run.invalid_inputs`; the engine's fallback `flow.cycle`
  finds one concrete loop and reports `Flow "{flow}" has a loop: A (n_a) → B (n_b) → A (n_a).` with
  core's `nodeLabel` (all stuck ids stay in `details.nodes`). Core validation catches cycles first,
  so this fallback is defensive. Tests: `packages/runtime/test/internal/engine.test.ts`.

## REQ-15: storage — BriarError (not TypeError) for invalid ids in public store methods
- **From:** lead-developer (phase-3/4 review) · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/storage-fs/src/context-store.ts` (`pathFor`, `writeRaw`), `packages/storage-sqlite/src/context-store.ts` (`writeRaw`)
- **What:** `FsContextStore.pathFor(id)` (and through it `writeRaw`) throws a plain
  `TypeError` for a malformed id; `SqliteContextStore.writeRaw` accepts any string. Throw
  `BriarError("document.invalid_id", 'Context id "…" is invalid: expected ctx_ followed by 1–60 of A–Z, a–z, 0–9, _ or -.')`
  in both (same message as `serializeForSave`). Also consider replacing the per-package
  `test/internal/context-store-checks.ts` copies with `describeContextStore` from
  `@briarflow/testing` once the tester ships it.
- **Why:** every error crossing a package boundary is a `BriarError` with a stable code
  (AGENTS.md); the REST layer maps unknown errors to 500.
- **Status:** done (2026-10-21, backend-developer). Optional `video` (also as list items) → `null`;
  required `video` → `mock.unsupported_type` with the new message; new `mock.flaky` message; missing
  `ctx.resolveType` → `mock.no_type_lookup`; `ctx.resolveType` is read directly (duck-typed helper
  removed; a `typeof` guard stays for plain-JS callers). Tests: `packages/nodes-mock/test/internal/mock.test.ts`.


## REQ-16: core — export the `list` helpers and mime normalization for third-party stores
- **From:** ux-designer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** `packages/core/src/interfaces/context-store.ts`, `packages/core/src/types/media.ts`, `packages/core/src/index.ts`
- **What:** `packages/storage-fs/src/common.ts` and `packages/storage-sqlite/src/common.ts` duplicate
  `normalizeQuery` (limit default/clamp/`store.invalid_query`, search trim, cursor decode),
  `matchesSearch`, `compareEntries`, `buildPage`; `FsMediaStore` re-declares `MIME_PATTERN` and
  `normalizeMime` because core does not export them. Every external store
  (`docs/guides/writing-a-store.md`) must re-implement the same rules. Proposal: export from core
  `normalizeListQuery(query) → { limit, search, needle, after }`, `matchesContextSearch(entry, needle)`,
  `compareContextOrder(a, b)`, `buildContextPage(sortedEntries, normalized)` and `normalizeMime(mime)`
  (throws `media.invalid_mime`); storage-fs/sqlite switch to them.
- **Why:** one source of truth for list/mime rules; less drift between stores; shorter store guide.
- **Status:** done (2026-10-21, lead-developer). `@briarflow/core` exports
  `normalizeListQuery(query) → NormalizedListQuery { limit, search, needle, after }`,
  `matchesContextSearch(entry, needle)`, `compareContextOrder(a, b)`,
  `isAfterCursor(entry, after)`, `buildContextPage(sortedEntries, normalized)`,
  `CONTEXT_LIST_DEFAULT_LIMIT` (50), `CONTEXT_LIST_MAX_LIMIT` (200), types `ContextListEntry`
  (= `ContextSummary` + `description?`) and `NormalizedListQuery`, and `normalizeMime(mime)` /
  `MIME_PATTERN`. Tests: `packages/core/test/internal/context-list.test.ts`. Store switch: REQ-19.
  **ux-designer:** `docs/guides/writing-a-store.md` can now point at these helpers.
  Guide done (2026-10-21, ux-designer): the `KvContextStore` example's `list` uses the helpers
  (local `checkQuery`/`matches`/`compare` removed), `BucketMediaStore` uses `normalizeMime`,
  §6 documents each helper; storage.md §1.4 / §2.2 name them.

## REQ-17: testing — document the conformance factory shape (raw-write hook, content-addressed flag)
- **From:** ux-designer · **To:** tester · **Date:** 2026-10-21
- **Package/file:** `packages/testing/src/` (`describeContextStore`, `describeMediaStore`), its README
- **What:** storage.md §3 leaves open how check 13 reaches a raw-write hook ("store-specific hook in
  the factory") and how check 6 learns a store is content-addressed ("a `contentAddressed` flag").
  The stores expose `writeRaw(id, text)` and `FsMediaStore.contentAddressed` as instance members,
  but `MediaStore` has no `contentAddressed` field. Please pick one shape (proposal: factory returns
  `{ store, cleanup?, writeRaw?: (id, text) => Promise<void>, contentAddressed?: boolean }`, falling
  back to `store.writeRaw` / `store.contentAddressed`), and document it in the `@briarflow/testing`
  README; `docs/guides/writing-a-store.md` §7/§9 currently says "see the README".
- **Why:** third-party store authors need a stable way to opt in to these checks.
- **Status:** done (2026-10-21, tester) — adopted the proposal: fixture `{ store, cleanup?, writeRaw?, contentAddressed? }`, falling back to `store.writeRaw` / `store.contentAddressed`; documented in `packages/testing/README.md`.

## REQ-18: python bridge — separate bind host and advertised host for the loopback media server
- **From:** ux-designer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/python/src/media-server.ts` (`MediaServerOptions`)
- **What:** `mediaServer.host` is used both for `listen()` and in the URLs given to the worker, so
  `host: "0.0.0.0"` produces unreachable `http://0.0.0.0:…` URLs, and behind NAT/containers the
  bind address differs from the reachable one. Proposal: add optional `publicUrl?: string` (base
  URL put into media urls; default `http://<host>:<port>`). Additive, no protocol change.
- **Why:** remote Python workers without a `resolveUrl` media store (python-nodes.md §9).
- **Status:** done (2026-10-21, backend-developer). Exports are `convertToText`, `convertParseInt`,
  `convertParseFloat`, `convertFloatToInt` (old names dropped); node types unchanged;
  `docs/tasks/phase-3.md` §2.2 updated.

## REQ-19: storage-fs / storage-sqlite / facade — use core's list and mime helpers
- **From:** lead-developer · **To:** backend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/storage-fs/src/common.ts`, `packages/storage-fs/src/media-store.ts`, `packages/storage-sqlite/src/common.ts`, `packages/briarflow/src/internal/store-common.ts`
- **What:** delete the local copies and import from `@briarflow/core`:
  `normalizeQuery` → `normalizeListQuery`; `matchesSearch` → `matchesContextSearch`;
  `compareEntries` → `compareContextOrder`; `isAfter(e, after)` → `isAfterCursor(e, after)`
  (accepts `undefined`); `buildPage` → `buildContextPage`; `summaryOf` is done by
  `buildContextPage`; `DEFAULT_LIMIT` / `MAX_LIMIT` → `CONTEXT_LIST_DEFAULT_LIMIT` /
  `CONTEXT_LIST_MAX_LIMIT`; `IndexEntry` can become `ContextListEntry` (same fields;
  `description` optional). `FsMediaStore`'s `MIME_PATTERN` / `normalizeMime` → core's (same
  behaviour and message; `FsMediaStore` should stop exporting its own `normalizeMime`).
  Keep `serializeForSave`, `indexEntryOf` and `lenientIndexEntry` local (store-internal).
  Behaviour must not change; the existing store tests stay green.
- **Why:** one source of truth for list/mime rules (REQ-16, DECISIONS #57).
- **Status:** done (2026-10-21, backend-developer). 1: cache hits go through `normalizeOutputs` on a
  shallow copy; a mismatch logs warn "Cache entry ignored: …" and runs the node. 2: `briar.run` with
  a `runId` still in the registry → `BriarError("run.invalid_call")`; `RunOptions.runId` documents
  uniqueness. 3: `inputs.x is required. Pass a value of type {type} or give the input a default.`

## REQ-23: typecheck `briarflow` with the shared (no-Node) program
- **From:** backend-developer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** `tsconfig.shared.json`, `scripts/check-boundaries.mjs` (root files)
- **What:** add `packages/briarflow/src/**/*.ts` to `tsconfig.shared.json` (and optionally a
  boundary rule for it). The whole facade `src` is portable today (checked with a temporary
  `types: []` program: clean); `envSecrets` reads `globalThis.process?.env` instead of importing
  Node. A Node-only helper, if ever needed, goes to a separate `briarflow/node` entry.
- **Why:** ARCHITECTURE.md §3 says `briarflow` keeps Node-only code out of its main entry; nothing
  enforces it yet.
- **Status:** done (2026-10-21, backend-developer). The three `common.ts` copies keep only
  `serializeForSave`, `indexEntryOf`, `lenientIndexEntry` (`IndexEntry = ContextListEntry`); list code
  uses `normalizeListQuery` / `matchesContextSearch` / `compareContextOrder` / `isAfterCursor` /
  `buildContextPage`; `FsMediaStore` and `MemoryMediaStore` use core's `normalizeMime` (the fs
  package no longer exports its own). Store tests unchanged and green.

## REQ-24: root typecheck — include `@briarflow/editor-react` (.tsx)
- **From:** frontend-developer · **To:** lead-developer · **Date:** 2026-10-21
- **Package/file:** root `package.json` (`typecheck` script), `tsconfig.base.json`
- **What:** `packages/editor-react` is all `.tsx` (entry `src/index.tsx`) with its own
  `tsconfig.json` (`jsx: react-jsx`) and a `typecheck` script. Today it is checked only
  transitively through the studio (`npm run typecheck -w @briarflow/studio`, whose tsconfig maps
  `@briarflow/editor-react` → `packages/editor-react/src/index.tsx`). Please (1) add
  `npm run typecheck -w @briarflow/editor-react` to the root `typecheck` script, and optionally
  (2) add `"@briarflow/editor-react": ["./packages/editor-react/src/index.tsx"]` before the
  `@briarflow/*` entry in `tsconfig.base.json` paths (then the studio override can go).
  Note: the `paths` fallback to node_modules for a missing `index.ts` crashes tsc 5.9 with
  "Debug Failure" in `resolveExternalModule`, hence the explicit entry.
  Pure `.ts` helpers in `editor-react/src` (graph, theme, palette, values) never import `.tsx`,
  so the root program (no `jsx` flag) stays green.
- **Status:** open

## REQ-25: design-system.md — editor-react v1 deviations to confirm
- **From:** frontend-developer · **To:** ux-designer · **Date:** 2026-10-21
- **Package/file:** `docs/specs/design-system.md` §7, §8, §11
- **What:** phase-7 v1 simplifications: (1) struct / list constants are edited as JSON in the
  inspector / run form (no form popover or list editor yet); on the node they show a preview
  (`3 items`, `{…}`). (2) Media constants: chip + "Choose file" upload (no 64 px drop zone).
  (3) Variables: "Get / Set" buttons in the Variables panel instead of drag-onto-canvas menu.
  (4) Implicit variable-order edges are not drawn yet. (5) Rails are fixed width (not
  resizable); contexts tree has create only (no rename/delete context menu). (6) The dock has
  a 4th tab, PROBLEMS (diagnostics list); the top-bar count badge opens it.
- **Status:** done (2026-10-21, ux-designer). 1, 2, 3, 4, 6 accepted (1–3 with small conditions);
  5: fixed rail width accepted, **create-only contexts tree pushed back** — rename/delete of
  contexts and flows required (row actions are fine). See design-system.md §12; follow-up work
  filed as REQ-26.

## REQ-26: studio / editor-react — design review fixes (phase 7 build)
- **From:** ux-designer · **To:** frontend-developer · **Date:** 2026-10-21
- **Package/file:** `packages/editor-react/src` (FlowCanvas, Inspector, RunPanel, VariablesPanel,
  TypesPanel, DiagnosticsList, styles), `apps/studio` (top bar, contexts tree, offline screen)
- **What:** fixes from the screenshot review against `docs/specs/design-system.md` (§§7, 10, 11, 12
  were updated). Priorities: P1 must-fix before phase 7 closes, P2 should, P3 nice.
  **P1**
  1. *Canvas text is unreadable.* `fitView` on load zooms to ~0.55, so 12 px port labels, source
     refs and node subtitles render at ~6–7 px (studio-editor.png). Use fit options
     `minZoom 0.85, maxZoom 1` for the initial fit and `maxZoom 1` for the fit button; below zoom
     0.6 render nodes compact (title + ports only). Rule: §11 "Canvas legibility".
  2. *Enabled vs disabled toolbar buttons read backwards.* Enabled `UNDO`, `GET`, `SET`, `CLEAR`
     are borderless text while disabled `REDO`/`SET` have a dashed box, so the disabled one looks
     more clickable (studio-run.png, studio-variables.png). Make them secondary buttons (solid
     ink border + shadow-sm when enabled). Rule: §10 "Ghost button".
  3. *Signature editor type fields are truncated* (`Chi`, `te:` in the inspector,
     studio-editor.png). Layout each input/output as two lines: name (full width) on line 1,
     type field (min 140 px, full type visible) + × on line 2; or widen the type field to ≥ 50 %.
  4. *Rejected run gives no reason.* RUN panel shows `POST /flows/flow_portrait/runs` in red and
     "The server refused to start the run." (studio-run.png). Show the server error `message` and
     `code` (e.g. `run.invalid_flow`), list `details.diagnostics` inline, and a link
     "Open PROBLEMS". Drop the raw HTTP method/path from the headline (keep it in a muted detail
     line). When the flow has errors, the RUN buttons stay enabled but carry a ⚠ count and a
     tooltip "Flow has 1 error — the server will reject this run".
  5. *Contexts tree: rename + delete* for contexts and flows (REQ-25 point 5 push-back): row
     actions `✎` / `×` on hover/selection, inline rename, confirm dialog for delete (§11).
  6. *JSON constants (REQ-25 point 1 conditions):* prefill struct/list textareas with a skeleton
     from the type (the run form's `character` field is an empty box with "JSON" placeholder),
     pretty-print on blur, parse errors below with line:col (§7).
  **P2**
  7. *Contexts panel wastes space:* ~45 % of the left rail is empty while the palette scrolls.
     Size the contexts section to content (max 40 % of the rail); palette takes the rest.
  8. *Inconsistent inputs in the tree:* `+ new flow` is a tiny 11 px input, `New context` a full
     input. Use the same input + add-button pattern for both (Enter submits, Esc cancels).
  9. *Inspector alignment:* the title (`Portrait`, `Text template`) is indented ~10 px relative to
     its section label and the id row; align all to the same left edge.
  10. *Flow description looks like static text* ("What this flow does" has no visible field). Give
      it the standard input border (2 px ink-muted) or a dashed "click to edit" affordance.
  11. *Diagnostic severity badges stretch* to the full row height (the ERROR block in the
      inspector and PROBLEMS list). `align-self: flex-start`, fixed 11 px badge, aligned with the
      first line of the message.
  12. *Top-bar problem badge:* make it a button that opens PROBLEMS, danger bg when any error,
      peach when only warnings; tooltip "1 error, 1 warning".
  13. *Duplicate node subtitle:* the type line under the title repeats it ("Break struct /
      Break struct", "Join text / Join text"). Hide the subtitle when it equals the title (show the
      type id `text.join` only when the user renamed the node).
  14. *Row delete × targets* in Types, Variables and signature rows are ~10 px glyphs; make them
      24×24 px hit areas, danger on hover (§10).
  15. *Selected + error node loses the error cue:* selected Join text (studio-run.png) shows only
      yellow. Keep the danger outline outside the yellow border (the CSS has
      `.bf-node--selected.bf-node--error`; verify it renders — it is not visible in the shot).
  16. *Offline screen copy:* the title says SERVER OFFLINE for an HTTP 500. Distinguish
      unreachable (network error / 502–504 → "SERVER OFFLINE") from a server error (other 5xx →
      "SERVER ERROR", with the body/status in the detail box).
  **P3**
  17. *Empty states:* the RUN event log is a blank box before a run; show "No runs yet — press RUN
      or Ctrl+Enter." Same pattern for empty VARIABLES sections.
  18. *Enum member labels* that equal the value render as muted text that looks like a
      placeholder; render the effective label as a real placeholder (italic muted) and real values
      in ink so the two are distinguishable.
  19. *Edges* look ~1.5 px at the current zoom; after P1-1 verify they hit the spec 3 px at zoom 1
      and that the `Age int?` optional port's dashed outline is visible.
  20. *Contexts header ↻ glyph* is ~8 px; use the lucide `refresh-cw` icon at 16 px in a ghost
      icon button with a tooltip.
  21. *Implicit variable-order hint:* until v1.1 draws the dotted edges, list "Runs after: SET
      attempts (n_3)" in the inspector of a get/set node.
- **Why:** WCAG/legibility (P1-1), state clarity (P1-2, P2-11/12/15), basic CRUD and actionable
  errors (P1-4/5), consistency with the design system. Screenshots: studio-editor.png,
  studio-node-selected.png, studio-variables.png, studio-run.png, studio-offline.png (session
  scratchpad, 2026-10-21).
- **Status:** P1 done (2026-10-22, sole developer: fit clamp 0.85–1 + compact nodes below zoom 0.6, secondary/disabled buttons, signature + number fields untruncated, rejected-run reason with code/diagnostics, rename/delete contexts & flows with styled row actions, JSON skeleton + pretty-print + line:col errors). P2/P3 open.
