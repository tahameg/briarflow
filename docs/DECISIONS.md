# Decisions log

Short records of technical decisions. Newest at the bottom. Owner: lead developer.

## 2026-10-21 — Phase 0 scaffold

1. **npm workspaces**, `packages/*` and `apps/*`. Package directory name = package name
   suffix (`packages/nodes-std` ↔ `@briarflow/nodes-std`; `packages/briarflow` ↔ `briarflow`).
   Inter-package dependencies use `"*"` versions.
2. **Node ≥ 20.19** (`engines`), `.nvmrc` = 20. 20.19 is the floor required by Vite 7 / tsdown.
3. **Tool versions pinned to Node-20-compatible lines:** TypeScript `~5.9.3` (no TS 6/7 yet),
   Vitest `^4.1` (Vitest 5 needs Node 22), Vite `^7.1` declared explicitly,
   tsdown `~0.17.2`. tsdown ≥ 0.18 triggers an npm 10.8 arborist crash
   (`Cannot read properties of null (reading 'edgesOut')`) during peer resolution, and
   ≥ 0.22 needs Node 22. Revisit when the Node floor moves to 22.
4. **`exactOptionalPropertyTypes: true`.** Briarflow documents are JSON and serialization must
   be deterministic; this flag stops `{ x: undefined }` from silently standing in for a
   missing key. Cost: optional fields that may be explicitly cleared must be typed
   `x?: T | undefined`, and option spreading needs care (`...(v === undefined ? {} : { v })`).
   It only affects our own compilation, not consumers.
5. Other compiler flags: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
   `verbatimModuleSyntax` (use `import type` for types), `isolatedModules`,
   `moduleResolution: "bundler"`, target/lib ES2022. Relative imports use the `.js`
   extension (`./errors.js`), which works with bundler resolution and keeps a NodeNext
   switch cheap.
6. **Source-first resolution.** `tsconfig.base.json` `paths` map `@briarflow/*` and `briarflow`
   to `packages/*/src/index.ts`; package `exports` also point at `./src/index.ts` for now.
   `npm run build` runs `tsdown` per package into `dist/` (ESM + `.d.mts`); before the first
   publish, `exports` must switch to `dist/` (via `publishConfig` or a prepack step).
7. **Two typecheck programs.** `tsconfig.json` checks everything (src + tests + apps) with
   `@types/node`. `tsconfig.shared.json` checks only shared packages' `src` with `types: []`,
   so `process`, `Buffer`, `node:*` fail to compile there. Shared packages still get the
   `DOM` lib because web-standard primitives (`AbortSignal`, `fetch`, `ReadableStream`) are
   typed there — do not use DOM-only APIs (`document`, `window`) in shared code.
8. **Boundary check** `scripts/check-boundaries.mjs` (runs first in `npm test`, also
   `npm run lint`): fails if a shared package's `src` or `package.json` references `node:*`,
   a Node built-in, React, `@xyflow/react`, or a Node-only/UI Briarflow package. The shared
   list is duplicated in `tsconfig.shared.json`; keep them in sync. No ESLint for now.
9. **Errors.** `BriarError(code, message, { details?, cause? })` with `toJSON()` →
   `SerializedError { code, message, details? }` (same shape as the REST error body).
   `NotImplementedError(feature)` has code `not_implemented`. `isBriarError()` duck-types on
   `Error` + string `code` so it works across duplicated package copies. Codes use
   `area.snake_case` (e.g. `flow.not_found`), matching diagnostic codes.
10. `@briarflow/testing` declares `vitest` (`^4.1.0`) as a peer dependency: its conformance
    suites call `describe`/`it`.

## 2026-10-21 — Spec deviations reviewed (lead), phase-1 contracts

All twelve deviations the ux-designer listed in `docs/specs/*` were reviewed against the
architecture. All are **accepted**; one gets an amendment (11). ARCHITECTURE.md now matches.

11. **Command-based undo (commands.md D1): accepted, amended.** Inverse commands are needed to
    sync undo with the server. Problem found: inverses must restore *soft-broken* state
    (a constant that no longer validates, an edge whose types no longer match), but
    `node.setValue` / `edge.connect` / `*.setDefault` hard-reject such values. Amendment:
    every command accepts `restore: true`, which downgrades value/type/visibility hard checks to
    diagnostics; structural checks (unknown refs, ids, duplicate names, cycles) still apply.
    Authoring always emits inverses with `restore: true`. Designer to add it to commands.md
    (REQ-1).
12. **Extra small commands (commands.md D2): accepted.** Needed for a complete UI.
13. **Reject/cascade on delete of used entities (commands.md D3): accepted.** No dangling ids.
14. **Shorthand strings in command payloads (commands.md D4): accepted.** Resolved in the target
    scope, stored as IR.
15. **`ExecContext.globals/variables` read-only, run-start values (variables.md D1,
    node-api.md D4): accepted.** Writes only through set nodes keeps ordering visible and
    results scheduling-independent. `ExecContext` also gains `attempt`, `fetch`, declared-only
    `secrets`; `NodeRunArgs` gains typed `config`.
16. **Optional/defaulted struct fields omittable in values (types.md D1): accepted.**
    `normalizeValue` returns `{ ok, value } | { ok: false, diagnostics }` (not a bare value)
    so the runtime validates and normalizes in one pass.
17. **Short pack type names (types.md D2): accepted.** Documents always store qualified ids, so
    a newly loaded pack can only make *new* shorthand ambiguous, never change stored meaning.
18. **Node `config` + `cfg` builder, pack namespaces, `text.template` from config
    (node-api.md D1–D3): accepted.** Implementation note for nodes-std: placeholder names can
    exceed the generic var-name rules (`^[A-Z][A-Za-z0-9]*$`, ≤ 16), so `text.template` must map
    placeholders to synthetic var names (`T1`, `T2`, …).
19. **Runtime event `seq`, `node.retrying`, extra `RunResult` / `SerializedError` fields,
    `events({ after })` (runtime.md D1–D4): accepted.** The run types live in core
    (`packages/core/src/run/types.ts`) so runtime and client implement one interface.
    `BriarError.toJSON()` includes `cause` only when the cause is a Briarflow error;
    `serializeError(unknown)` maps anything else to `{ code: "internal" }`.
20. **Store-enforced flow-id uniqueness, `MediaStore.put` `meta` (storage.md D1–D2): accepted.**
21. **REST `waitMs`, raw-body uploads, SSE `?after=` (rest-api.md D1–D3): accepted.**
22. **Python protocol additions (python-protocol.md D1–D5): accepted.**

Phase-1 contract decisions (lead):

23. **`briar.input` / `briar.output` are built into core**, not catalog entries. Their ports come
    from the flow signature, `resolveFlowPorts` handles them, the runtime executes them itself,
    and `nodes-std` does not define them. Reason: every flow has them, so core validation and
    the editor must work without nodes-std loaded. (node-api.md §9 lists them in the std table;
    REQ-1 asks the designer to note this.)
24. **Static value typing.** `t.list` values are `readonly V[]` (values are immutable). Types TS
    cannot know (`t.ref("Name")`, `t.var`, `t.parse`, `t.fromRef`) are `UnknownValue`
    (`string | number | boolean | object | null`) rather than `unknown`: with `unknown` as the
    port-value constraint, TypeScript widens enum literals returned from `run`
    (`{ role: "user" }` became `string`). `defineNode` infers `run`'s return as a `const` type
    parameter checked against the outputs, which makes missing, ill-typed **and undeclared**
    outputs compile errors. Nodes with no static inputs (dynamic ports) get
    `Readonly<Record<string, UnknownValue>>` inputs.
25. **Bare names in `TypeSpec`s.** `t.ref("Role")` and `defineStruct("ChatMessage", …)` run before
    the pack name is known, so their named refs hold the bare name until `definePack`
    qualifies them. A bare name in a document is `type.unknown_id`.
26. **`Diagnostic` gains `details?` and path keys `variableId`, `globalId`, `valuePath`.**
27. **Helpers placed in core:** `readMedia` (storage.md said runtime; core lets the Python bridge
    and stores reuse it without depending on the runtime), `encodeCursor` / `decodeCursor`,
    `sha256Hex` (web `crypto.subtle`), `canonicalJson`, `jsonEquals`, id generators
    (`createIdGenerator`, `createSequentialIdGenerator`). `UnauthorizedError` and
    `briarError(c, err)` belong to `@briarflow/server` (phase 5). `runNode` belongs to
    `@briarflow/testing` (phase 3/4).
28. **Serialization format:** object keys sorted at every level, 2-space indent, trailing
    newline. Deterministic and diff-friendly; no hand-maintained key order.
29. **Type-level tests** live in `packages/*/test/internal/*.test-d.ts`: compiled by
    `npm run typecheck` (tsconfig includes `packages/*/test/**`), not run by Vitest.

## 2026-10-21 — Phase-1 implementation (lead)

30. **`type.syntax` positions are 0-based character offsets** into the shorthand text
    (`details.position` carries the same number). `parseType` gained an optional `where` option
    used in `type.unknown` messages (default: the quoted shorthand).
31. **Lowercase non-primitive words** in shorthand (`string`) are `type.syntax`, not
    `type.unknown`: named types must start uppercase, so such a word can never resolve.
32. **Value type-mismatch messages always end with `(got <json>)`** (types.md §7 example),
    including int/float/boolean/text/list/struct mismatches; constraint messages use the exact
    §6 suffixes. Text kind mismatch: `must be text`; list: `must be a list`; struct:
    `must be an object with the fields of <Name>`. `value.generic_unbound` from `validateValue`
    (which knows no node/port) reads `Cannot set a constant on "<path>" before its type is known…`.
33. **Generic binding is order-independent by sorting connections** (inputs first, then port name,
    then canonical type) before folding join/meet; conflicts name the first conflicting port in
    that order. `resolveFlowPorts` recomputes bindings as a fixpoint over all generic nodes
    (edges whose other end still has an unbound var contribute nothing); a conflicting var is left
    unbound and reported as `node.generic_conflict`, other vars of the node still bind.
34. **Dynamic nodes with invalid config or a failing `resolvePorts` get no ports.** Their edges
    are not additionally reported as `edge.unknown_port` (the node-level diagnostic explains it);
    the same holds for nodes of unknown type.
35. **Validation details:** constants are validated only on unconnected ports (connected ones are
    ignored at run time); `input.unconnected` is not raised for ports whose type still has an
    unbound var (`node.generic_unbound` covers them, once per var, on the first input port using
    it); `output.unconnected` is satisfied by an edge or a constant; type diagnostics point at the
    declaring entity (`typeId`/`field`, `flowId`+`field`, `variableId`, `globalId`) with the
    referenced id in `details.id`. For `briar.variable.*`/`briar.global.*` nodes,
    `computeVariableOrder`'s `variable.unknown`/`variable.write_to_readonly` replace the
    config-level `config.unknown_ref`/`variable.write_to_readonly` (no duplicates). Pure data
    cycles are reported by `validateFlow`; `computeVariableOrder` reports `flow.cycle` only for
    cycles that need implicit edges. Extra codes used: `flow.duplicate_id`, `flow.duplicate_name`,
    `edge.unknown_node`, `edge.duplicate_input`, `global.readonly_requires_value` (validation).
36. **Derived node titles use every segment after the namespace**: `openai.chatCompletion` →
    "Chat completion", `briar.variable.get` → "Variable get", `text.template` → "Template"
    (std nodes set explicit titles). Built-in nodes are labelled "Input"/"Output".
37. **JSON Schema:** `$defs` keys are sorted; on a name collision the widest scope keeps the plain
    name (pack > global > local) and narrower ones get `Name__id`. Strict mode drops `default`,
    `pattern` (also the media mime pattern) and uses a `{uri, mime}`-only `MediaRef`. Enum labels
    go to `x-briar-labels`, so Ajv needs `strict: false` (or that keyword registered).
38. **`jsonEquals` is defined via `canonicalJson`** (storage.md §5: both throw `json.invalid`).
39. **`deserializeContext`:** missing `formatVersion` → `format.invalid`; present but not a positive
    integer or newer than supported → `format.unsupported_version`. Unknown extra keys are kept.
    Migration registry `MIGRATIONS` (internal) is empty while v1 is the only format.
40. **`readMedia`:** non-2xx other than 404 → `media.fetch_failed` (`details: { status, uri }`,
    REQ-4); `content-length` above `maxBytes` fails before reading; streams stop as soon as the
    limit is passed.
41. **`ajv` / `ajv-formats` are root devDependencies** for schema tests only; core does not
    depend on them.

## 2026-10-21 — Phase-2 authoring (lead)

42. **Public API:** `applyCommands` / `applyCommand` (pure, for servers) plus
    `createContextEditor` (history, listeners). `CommandError extends BriarError` with
    `commandIndex`/`op`; its `details` is always an object containing `commandIndex` and `op`
    plus code-specific data (REST returns it as is). `undo()`/`redo()` return `undefined` when
    the stack is empty; a failed undo/redo leaves the stacks unchanged.
43. **`resolved`** fills generated ids and replaces shorthand types (payload `type`,
    `fields[].type`, `cfg.type()` config values) with IR; `restore` is kept as given.
    `flow.duplicate` also fills `name` and `typeIds`.
44. **Generated ids** are re-drawn (up to 100 times) when the generator returns an id already
    used in its domain, so sequential generators work on existing documents.
45. **Name codes:** type names use `type.invalid_name` / `type.reserved_name` /
    `type.duplicate_name` (types.md templates); all other names use `command.*_name`. Enum member
    duplicates → `type.duplicate_member`, invalid member values → `command.invalid_name`.
46. **Optional `index` on creating commands** (`type.defineStruct/defineEnum`, `type.moveScope`,
    `global.create`, `flow.create`, `flow.variable.create`, `node.add`, `edge.connect`), so
    inverses restore list order exactly. Spec extension; commands.md should list it (REQ to
    ux-designer).
47. **Inverse of `flow.delete`** is a full rebuild sequence (`flow.create`, local types defined
    empty then `type.field.add`, signature, variables, built-in node move/title/constants,
    `node.add`, `edge.connect`, `flow.setViewport`). Nodes of unknown types cannot be restored
    (`node.unknown_type` stays structural) — acceptable for v1.
48. **Implicit cleanup** runs after every command on the flows it touches: edges/constants of
    ports that existed before the command and vanished are removed and restored by the inverse
    (appended after the command's own inverse, since the ports must exist first). Nodes that
    have no ports because of unknown type / invalid config / failing `resolvePorts` /
    `variable.write_to_readonly` keep their edges. `typeBindings` are recomputed on nodes with
    generic ports.
49. **Renames follow ports generically:** for every node whose resolved ports lost `old` and
    gained `new` on the same side, edges and constant keys are rewritten (covers
    `briar.input`/`briar.output` and `struct.make/break`, and any custom node deriving ports
    from the same data). Field and enum-member renames also rewrite stored values typed as that
    struct/enum (node constants, field/input/variable defaults, global values).
50. **Shorthand types resolve strictly in the target scope** (local name at global level →
    `type.unknown`); visibility errors come from IR ids.
51. **Hard type checks on `edge.connect`** use resolved ports directly (not `validateFlow`):
    a new `node.generic_conflict` on either end → `edge.generic_conflict` (same message), then
    assignability with the same message/hint as validation. Hint order (core and authoring): list
    item fits → `Use list.get…`, else text target → `Use convert.toText…`.
52. **`flow.duplicate`** appends the copy at the end; `node.clearValue` without a stored value
    is a no-op even for an unknown port; context name problems are `command.invalid_payload`.
53. **Core additions for authoring:** public `typeConstraintDiagnostics`, `collectNamedIds`,
    `mapNamedIds`, `containsVar`, `typeRefShapeProblem`, `nodeLabel`. `ExecContext` gains the
    required `resolveType(id)` (REQ-6).
54. **Editor:** a batch made only of `flow.setViewport` commands is not recorded and keeps the
    redo stack; listeners are called synchronously and their exceptions are swallowed; `redo`
    re-applies the recorded `resolved` commands with `restore: true`.
55. **Root `typecheck`** also runs the studio's `.tsx` typecheck (REQ-7).

## 2026-10-21 — Phase-3 review and storage deviations (lead)

56. **Storage deviations accepted (storage REQ-9):** fs media ids are content-addressed:
    sha-256 hex of `canonicalJson({ hash, mime, meta })`, so equal bytes with different info get
    different refs and an id can reappear after delete + identical put (supersedes "never reused
    after delete" for content-addressed stores; `contentAddressed: true` tells the conformance
    suite). New codes `store.unsupported_schema` (plain `BriarError`) and `media.corrupt`
    (`MediaError`). Corrupt contexts stay listed (best-effort summary) so they can be deleted;
    `load` throws `store.corrupt`; unconditional `save` overwrites. Stores expose
    `writeRaw(id, text)` as a test/repair hook (not part of `ContextStore`). `FsContextStore`
    supports one writer process per directory; `refresh()` re-reads the index.
57. **Store helpers live in core (REQ-16):** `normalizeListQuery`, `matchesContextSearch`,
    `compareContextOrder`, `isAfterCursor`, `buildContextPage`, `CONTEXT_LIST_DEFAULT_LIMIT` /
    `CONTEXT_LIST_MAX_LIMIT`, types `ContextListEntry` / `NormalizedListQuery`
    (`interfaces/context-list.ts`), plus `normalizeMime` and `MIME_PATTERN` (`types/media.ts`).
    storage-fs, storage-sqlite and the facade's memory stores switch to them (REQ-19);
    `serializeForSave` / lenient index entries stay store-internal.
58. **Descriptor catalogs live in core:** `createCatalogFromDescriptors`, `packsFromDescriptors`,
    `definitionFromDescriptor` (REQ-8 from frontend). A descriptor node's `run` throws
    `NodeError("node.descriptor_only")`.
59. **Phase 3 reviewed:** `docs/tasks/phase-3.md` is the accepted contract (lead review notes in
    its §7).

