# Open questions

Decisions the designer could not settle alone. Each has a **Default:** that the team builds
against until the user decides. Others may comment under an entry (`> lead: …`). When a
question is decided, mark it `DECIDED (date, who): …` and update the spec.

## Types (`docs/specs/types.md`)

**Q-TYPE-1. Case-insensitive name uniqueness.** Should `Character` and `character` be allowed
side by side?
Default: no — uniqueness is case-insensitive in every scope; lookup stays case-sensitive.

**Q-TYPE-2. Unqualified pack type names.** Allow `ChatMessage` for `openai.ChatMessage`?
Default: yes, when exactly one loaded pack exports that short name and no local/global type
has it; documents always store the qualified id.
DECIDED (2026-10-21, lead, DECISIONS #17): yes, as the default says. types.md Deviation 2.

**Q-TYPE-3. Omitting optional / defaulted struct fields in values.**
Default: allowed on input, normalized to `null` / default (deviation from ARCH §4.3).
DECIDED (2026-10-21, lead, DECISIONS #16): accepted; `normalizeValue` returns
`{ ok: true, value } | { ok: false, diagnostics }` (types.md §7, applied via REQ-1 from lead).

**Q-TYPE-4. `http://` media URIs.** Default: accepted by core; `@briarflow/server` rejects
non-`briar-media://`, non-`https://` uris in run inputs unless `allowHttpMedia: true`.

**Q-TYPE-5. Recursive types** (trees, threads of messages). Default: not in v1
(`type.recursive`); revisit with a `ref` wrapper type later.

**Q-TYPE-6. Map/record type** (`map<text, T>`). Default: not in v1; use a list of structs.

## Commands (`docs/specs/commands.md`)

**Q-CMD-1. Command-based undo** (inverse commands) instead of document snapshots.
Default: inverse commands (deviation from ARCH §5), needed for server sync.
> lead: accepted, with `restore: true` on inverse commands so soft-broken state can be
> restored (DECISIONS #11).
DECIDED (2026-10-21, lead, DECISIONS #11): inverse commands with `restore: true`;
specified in commands.md §1.1 / §1.1a (REQ-1 from lead).

**Q-CMD-2. Deleting a type that is in use.** Reject, or delete with cascade (turn usages into
dangling refs)? Default: reject with `type.in_use` and a usage list; the studio offers a
"show usages" action.

**Q-CMD-3. Global / flow variable delete with get/set nodes.** Default: reject unless
`cascade: true`, which removes those nodes and their edges.

**Q-CMD-4. Constants on connected ports.** Default: kept and ignored while connected.

**Q-CMD-5. `flow.duplicate` id remapping.** Default: node/edge/variable ids are kept (they are
flow-scoped); local type ids are remapped via `typeIds` map or the generator.

**Q-CMD-6. Moving a type directly between two flows.** Default: not supported; move to
global, then to the other flow.

**Q-CMD-7. Copy / paste of nodes across flows.** Default: later (editor clipboard, phase 7+),
implemented as `node.add` + `edge.connect` batches with new ids.

## Variables (`docs/specs/variables.md`)

**Q-VAR-1. Lost updates for globals under concurrent runs** (two runs increment a counter).
Default: last completed run wins; documented. Later option: per-global `merge: "replace" | "append" | "sum"`.

**Q-VAR-2. Implicit ordering vs explicit trigger ports.** Default: implicit ordering edges
computed from data paths (writers before readers unless the reader feeds the writer).

**Q-VAR-3. `ctx.globals.set` / `ctx.variables.set` from arbitrary nodes.** Default: removed;
only set nodes write (deviation from ARCH §4.9).
DECIDED (2026-10-21, lead, DECISIONS #15): removed, as the default says.

**Q-VAR-4. Expose partial variable values on failed runs.** Default: no; only on success.

**Q-VAR-5. Should global writes apply after a failed run?** Default: no (ARCH: only after
success).

## Node API (`docs/specs/node-api.md`)

**Q-NODE-1. Dynamic ports for packs whose code is not in the browser** (server-only TS packs,
Python packs). Default: Python nodes have static ports only; TS dynamic nodes from
server-only packs work, but the editor cannot resolve their ports optimistically — it waits
for the server's command response (no instant feedback for those nodes).

**Q-NODE-2. Pack namespaces.** Default: `namespaces` field on `definePack`; std pack `briar`
claims `text`, `list`, `convert`; namespace `briar` is reserved.
DECIDED (2026-10-21, lead, DECISIONS #18): accepted. Related (DECISIONS #23):
`briar.input` / `briar.output` are core built-ins, not nodes-std catalog entries
(node-api.md §9).

**Q-NODE-3. `text.template` port types.** Default: one generic `$T` port per placeholder, any
type, rendered with the toText rules. Alternative: text-only ports (stricter).
DECIDED (2026-10-21, lead, DECISIONS #18): config template with generic ports, as the
default says; each port uses a synthetic type var `T1`, `T2`, … (node-api.md §9).

**Q-NODE-4. Default node timeout.** Default: 5 minutes per attempt.

**Q-NODE-5. Default retries.** Default: none (`maxAttempts: 1`); provider packs opt in.

**Q-NODE-6. Node icons.** Default: lucide icon names as strings; unknown names fall back to
the category glyph.

**Q-NODE-7. Sub-flows (calling a flow from a node).** Default: not in v1.

**Q-NODE-8. Streaming outputs (token streams from LLMs).** Default: not in v1; progress
messages only. Later: `node.partial` events.

**Q-NODE-9. Single-node test helper.** The guide uses `runNode(def, inputs, options)` from
`@briarflow/testing`. Default: add it in phase 3/4 (in-memory media, fake secrets, fixed clock).
> lead: agreed; noted in ARCHITECTURE §4.8 and DECISIONS #27.

**Q-NODE-10. Nested variants** (node-api.md §1.2; planned after 2026-10-24). v1 has one
selector per node. Some nodes have two independent choices whose combination decides the
shape (OpenAI image: model × generate/edit; a provider node: provider × model). Proposed:

- A variant may itself declare `variants` (same `VariantsInput`), up to a small depth (2).
  The pick becomes a path: `NodeInstance.variant: "gpt-image-1/edit"` (`/` is not allowed in
  variant names today, so stored v1 values stay valid and a flat name is a path of one).
- Shape and `run` live on the leaves; inner levels carry only `title`, `description` and the
  next selector. Each level is a dropdown; picking an inner one moves its child to that
  level's default.
- `node.setVariant` takes the path; carry-over and wire removal work on the leaf definitions,
  as now. Descriptors nest `variants` inside options. `variantDefinition(def, "a/b")`.
- Alternatives considered: several independent selectors on one node (combinations explode,
  some are invalid), or computed shapes from two config fields through `resolvePorts` (loses
  static typing, descriptors and the drop-wire matching).

Until then, flatten: one option per combination (`gpt-image-1 · edit`).

## Runtime (`docs/specs/runtime.md`)

**Q-RUN-1. Do unused nodes run?** (nodes whose outputs reach no output/set node.)
Default: yes, every node runs.

**Q-RUN-2. Fail fast?** Default: no — independent branches finish, then the run fails.
Later: run option `failFast: true`.

**Q-RUN-3. Default concurrency.** Default: 8 nodes engine-wide, 16 concurrent runs.

**Q-RUN-4. Cache persistence and size.** Default: in-memory LRU with 500 entries; no TTL.

**Q-RUN-5. Run registry retention.** Default: last 200 finished runs or 1 hour; no
persistent `RunStore` in v1.

**Q-RUN-6. Cancel grace period.** Default: 5 s.

## Storage (`docs/specs/storage.md`)

**Q-STORE-1. Who enforces global flow-id uniqueness?** Default: `ContextStore.save`
(`FlowIdConflictError`).
DECIDED (2026-10-21, lead, DECISIONS #20): the store, as the default says.

**Q-STORE-2. Search scope.** Default: case-insensitive substring over context name,
description and flow names; no full-text ranking.

**Q-STORE-3. Media garbage collection.** Default: none in v1; media lives until deleted
explicitly.

**Q-STORE-4. Pagination consistency under concurrent writes.** Default: best effort
(documented); exact only without concurrent writes.

## REST (`docs/specs/rest-api.md`)

**Q-REST-1. Filtering `GET /contexts` per user.** `authorize` is yes/no per request.
Default: v1 has no per-item filtering; add an optional `filterContexts(summary, req)` hook
later.

**Q-REST-2. 404 before authorization** leaks existence of ids. Default: accepted (ids are
random).

**Q-REST-3. `GET /runs` listing.** Default: not in v1; clients keep their run ids.

**Q-REST-4. Upload format.** Default: raw body with `Content-Type`; multipart later if needed.
DECIDED (2026-10-21, lead, DECISIONS #21): raw body.

**Q-REST-5. Media access control.** Default: `media.read` with only `mediaId`; media is not
linked to contexts.

**Q-REST-6. Max wait for `?wait=true`.** Default: 60 s, configurable up to 300 s.

## Python (`docs/specs/python-protocol.md`)

**Q-PY-1. Media to workers.** Default: `url` per input MediaRef from `resolveUrl`, else a
loopback media server in the bridge. Remote workers need `resolveUrl`.
DECIDED (2026-10-21, lead, DECISIONS #22): accepted as the default says.

**Q-PY-2. Worker auth.** Default: random bearer token generated by `spawnPythonWorker`;
`pythonPack({ url })` takes an optional `token`.
DECIDED (2026-10-21, lead, DECISIONS #22): accepted; the token applies to every endpoint,
health included (python-protocol.md §1, REQ-1 from backend-developer).

**Q-PY-3. Default node type name in Python.** Default: `<pack>.<camelCase(function_name)>`.
DECIDED (2026-10-21, lead, DECISIONS #22): accepted. Also settled (REQ-1 from
backend-developer): an explicit `type` without a dot is prefixed with the pack name; a dotted
`type` must start with `<pack>.` (python-protocol.md §2.1).

**Q-PY-4. Python concurrency.** Default: `ThreadingHTTPServer`; each node may set
`concurrency` (manifest) and the bridge enforces it; GIL-bound work is the author's concern.
Settled detail (REQ-1 from backend-developer): `concurrency` is `null` (unlimited) unless the
node sets it.

**Q-PY-5. A node raises `Cancelled` while the bridge is still connected.** Options: close the
stream with no terminal line (bridge reports `python.protocol_error`), or send an error line.
DECIDED (2026-10-21, orchestrator): the worker sends `{"type":"error","code":"node.cancelled",…}`;
the bridge maps it to a cancelled node (`NodeError("node.cancelled")`, not retried).
python-protocol.md §1.3; the Python SDK must be updated (requests.md REQ-3).

## Design (`docs/specs/design-system.md`)

**Q-DS-1. Light theme.** Default: dark only in v1; tokens are structured so a light theme is
a second `:root[data-theme="light"]` block later.

**Q-DS-2. Fonts from Google Fonts** (privacy / offline). Default: the studio self-hosts the
two fonts (`@fontsource/jetbrains-mono`, `@fontsource/space-grotesk`); the `@import` in the
spec is for prototypes only.

**Q-DS-3. Edge routing.** Default: orthogonal step edges with square corners; bezier as a user
setting later.

**Q-DS-4. Port shape for `list` and `optional`.** Default: hollow square for list, dashed
outline for optional, diamond for enum.
