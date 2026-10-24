# Status

| Phase | State | Notes |
|---|---|---|
| 0 Foundation | done | scaffold verified (npm test, typecheck green); 11 specs + 51 open questions with defaults |
| 1 Core | done | 766 tests green, typecheck clean, coverage >90% on types/values/schema/validation (verified by orchestrator) |
| 2 Authoring | done | 65 commands, inverse undo; 542 authoring tests green; full suite 1507 green (tester sign-off) |
| 3 Runtime + std nodes | reviewed | implemented by backend; `phase-3.md` reviewed and accepted by lead (2026-10-21, §7); follow-ups REQ-14/15; tester public suites + `runNode` export still to come before done |
| 4 Facade + storage | implemented | facade (createBriar, handles, run registry, global write-back) + storage-fs/sqlite done; conformance kits in progress (tester) |
| 5 Server + client | done | server + apps/server + client integration suite + smoke script |
| 6 Python extension | done | SDK + TS bridge + facade integration test green; REQ-18 (publicUrl) pending |
| 7 Editor + studio | implemented | editor store + editor-react + studio wired; design review in progress; needs real server for run rendering |
| 8 Providers + packaging | MVP done | nodes-anthropic; Dockerfile/compose/README (image not built here); nodes-openai skipped |

## MVP progress (single developer, since 2026-10-21)

Goal: studio → build flow → run on real server → see results (mock + Anthropic), via `docker run`.

- [x] 1. Green baseline (typecheck + tests; progress-throttle test on fake timers; studio rename/delete context wired)
- [x] 2. Server (phase 5): `packages/server` (+ `test/integration/client.test.ts`, real client on `serve({port:0})`),
  `apps/server` (`@briarflow/server-app`: `src/config.ts` env → config, `src/server.ts` SQLite + fs media under
  `BRIAR_DATA_DIR`, std + mock, optional Python, `/health`, studio static + SPA fallback; `src/providers.ts` optional
  provider packs). Root scripts `start`, `dev:server`, `dev:studio`, `smoke`. `npm run smoke` passes against `npm start`.
- [x] 3. Studio on real server: verified with headless Chrome (puppeteer-core) — create context + flow in the UI,
  connect, run, events + image preview. Fixed: click-added nodes stacked on Input/Output (`freePosition`), stale
  handle bounds (`useUpdateNodeInternals`), missing tree-row CSS. REQ-8 already done. REQ-26 P1 done (P2/P3 open).
- [x] 4. `@briarflow/nodes-anthropic` (portable, plain fetch): `anthropic.message`, `anthropic.structured` (JSON outputs
  via `output_config.format`, not forced tool use — 400 on Opus 5.5/Sonnet 5.5/Fable 5.1), refusal fallback, error
  mapping + retry-after, key redaction; 32 fake-fetch tests incl. `describeNodePack`. Loaded by apps/server when
  `ANTHROPIC_API_KEY` is set. Not live-tested (no key). OpenAI skipped.
- [x] 5. Packaging: multi-stage `Dockerfile` (tsx runtime, `/data` volume, healthcheck), `.dockerignore`,
  `docker-compose.yml` (lite), root `README.md`. Docker daemon not accessible in the dev sandbox (permission denied),
  so the image was NOT built; the Dockerfile steps were replayed in a clean copy (npm ci → studio build → prune →
  `node --import tsx apps/server/src/main.ts` with HOST=0.0.0.0) and `npm run smoke` passed against it.

### Studio UX rework (2026-10-22)
- Inline editing: `FieldRow` / `EditableName` / `TypePicker` (all primitives + structs/enums, list/optional
  switches, one-click `[ ]` list toggle) / `AddRow` "+" rows that add `<prefix>N` and open the name.
- Flow Input/Output nodes edit the signature on the canvas (rename, retype, remove, "+" under the last row).
- Dockable panels (`apps/studio/src/dock.tsx`): contexts, variables, nodes, inspector, run, problems in
  left/right (stacked, collapsible) and bottom (tabs) zones; drag a title/tab or use ⇄; layout in localStorage.
- Variables panel (flow variables only; grip drags a GET node onto the canvas). Globals and Types moved to
  top-bar modals (`Modal`, `GlobalsPanel`); `TypesPanel` is now list + editor. `VariablesPanel` lost its
  `signature` prop; `SignatureEditor` gained `dir`.
- Verified in headless Chrome (add/rename/retype/list on Input node, types/globals modals, panel move by
  menu and by drag, variable drag → GET node, layout persists). design-system.md §11 not yet updated.

### Context menus (2026-10-22)
- Extensible right-click menus in editor-react: `menu.ts` (targets, items, merge/search helpers),
  `ContextMenuProvider` / `useContextMenu` / `useContextMenuContributor`. Targets are an interface
  apps extend by declaration merging (studio adds `panel`, `context`, `flow`). Items have `order`
  bands (100 add, 200 edit, 300 view, 800 navigate, 900 delete), submenus, shortcuts, and a search
  field once a menu has more than 10 entries. `EditorProvider` adds a provider if the app has none.
- Canvas (`canvasMenu.tsx`): empty canvas → every node by category (plus variable/global GET/SET),
  added at the click; node (selection-aware) → duplicate, disconnect, frame, delete; port → disconnect,
  clear value, remove signature entry; edge → go to source/target, delete. `/` opens the add menu under
  the pointer, ContextMenu key / Shift+F10 the selection's menu, Ctrl/Cmd+D duplicates (`duplicate.ts`).
- Rows: variables, globals, signature entries, struct fields, enum values, types list; studio dock
  panels and the contexts/flows tree. The studio suppresses the browser menu except in text fields.
- The Nodes panel is gone from the studio (stored layouts are normalized: `normalizeLayout`);
  `NodePalette` stays exported. Verified in headless Chrome.

### Woodshop nodes (2026-10-22)
- Canvas nodes follow the "Briar woodshop" design (canvas: https://claude.ai/artifact/BziNuowaHk2gUFYHLBPriD):
  briar-wood frame (walnut for flow Input/Output, maple for variable GET/SET), matte plate with screws,
  brass category medal, pilot lamp for run state, VU strip for progress, last-value "dial window",
  failure tag. Ports are brass sockets on the rim with a 3 mm LED beside each row: color = type
  family (`ledFamily`: text amber, numbers green, boolean yellow, media red, structured frosted white),
  bar for lists; off / dim (typed value) / on (wired) / pulse (data flowing). Edges are bezier cables
  (dark sheath, type-colored core, sparks while running). The context menu is a plate in a briar frame.
- View model: `PortView.led`, `.list`, `.links`; `EdgeView.family`. Tokens `--bf-led-*`, `--bf-wire-*`,
  `--bf-plate-*`, `--bf-brass*`, `--bf-bench*`, fonts `--bf-font-plate` / `--bf-font-engraved` (Barlow,
  Barlow Condensed; the studio self-hosts them).
- Studio chrome in the same language: tokens retuned (warm plate surfaces, brass `--bf-yellow`,
  1px dark `--bf-line` grooves, soft shadows, 12px radius, Barlow fonts); walnut top bar with a brass
  nameplate, plate panels/docks, brass primary buttons, recessed inputs, LED checkboxes, engraved tabs,
  briar-framed modals and menus. `docs/specs/design-system.md` rewritten as v2 "Briar Woodshop".

### Top-bar switchers + studio start target (2026-10-22)
- The Contexts panel is gone. The top bar has context and flow switchers (`apps/studio/src/Switcher.tsx`):
  a dropdown + `+` (inline name field), and right-click for new / rename / duplicate / reload / delete.
  With no contexts, only `+ Add context` shows. Stored dock layouts drop the old panel (`normalizeLayout`).
- `apps/server`: `BRIAR_STUDIO_CONTEXT` / `BRIAR_STUDIO_FLOW` (id or name) are ensured at startup
  (`src/studio.ts`, created when missing) and served at `GET /api/studio`. The studio opens that
  target first, else the last used context, else the first one.

### Drop a wire on empty canvas (2026-10-22)
- Releasing a dragged connection on empty canvas opens a menu with only the nodes that fit:
  inputs that accept the dragged output (or outputs that can feed the dragged input), by
  category, generic `$T` ports under "Any type", variables/globals included. Picking one adds it
  at the drop point already wired (one undo step). `connect.ts` (`matchConnectTargets`) resolves
  candidate ports like the canvas does, so dynamic and variable nodes match too; menu target
  `connect`.
- The dropped wire stays on screen (dashed cable to a brass dot at the drop point) until a pick or
  a click outside closes the menu (`ContextMenuApi.open(…, { onClose })`).

### Frontend nodes + Print + Console (2026-10-22)
- Node definitions can be `frontend: true` (core `defineNode`, descriptors carry `frontend`): their
  effect happens in the viewer. The engine runs them as no-ops; when one completes in a run, the
  editor store rebuilds its inputs (wired → source output from this run, else typed value, else
  default) and calls its handler (`frontendNodes` option, `DEFAULT_FRONTEND_NODES`).
- `debug.print` (std pack, namespace `debug`): `text` + `browserConsole` (default false), no
  outputs. Writes to the store console (`state.console`, `clearConsole()`, capped at 500) and,
  with `browserConsole`, to `console.log`. editor-react `ConsolePanel`; studio "Console" dock tab.
- Look: frontend nodes have an ebonized frame with a cyan "STUDIO" display badge; the console is a
  cyan VFD screen (`--bf-vfd`); the add menu marks them "· studio".

### Execution lines (2026-10-23)
- Spec: `docs/specs/execution.md`. An execution line, separate from data wires, decides what runs:
  - Input sends `then`; Output takes `in`; other nodes take `in` and send `then`.
  - `pure: true` nodes have no line and run when a running node reads them.
  - `canFail: true` nodes also send `failed` and get an `error` output (new `error` primitive);
    Break error reads its code, message and node.
  - Nodes off the line never run and raise no errors.
  - A handled failure (failed line connected) continues there and the run can succeed.
- Core: `execEdges`, `execPortsOf`, `analyzeExec`, `autoExecEdges`, new `exec.*` diagnostics.
- Authoring: `exec.connect` / `exec.disconnect` / `flow.exec.enable` / `flow.exec.set`. New flows start
  with Input → Output.
- Runtime: walks the line, pulls pure nodes, `run.output_not_reached`. Flows without lines still run
  data-driven.
- Facade: `flow.line()`, `onFailure()`, `wireExecution()`.
- Packs: std helpers are pure; mock / Anthropic / Python nodes `canFail`.
- Editor:
  - Older flows are wired on load (`flow.exec.enable`, no undo step).
  - Execution sockets sit on the header; the red "on fail" band holds the failed line and the
    error output.
  - Lines are heavy cream cables, brass where the run went, red from a fail line.
  - Nodes off the line are dimmed.
  - Dropping a line on empty canvas offers the nodes that sit on a line.
  - Media LEDs moved to magenta; red now means error.
- Flow control nodes (branch, switch, loops, concurrency) are the next kind; not built.

### Console, conversions, vault, settings, OpenAI (2026-10-24)
- Studio run UX: run inputs live in the editor store (`state.runInputs`, `setRunInput`,
  `useCache`), kept in `localStorage` per context (`runInputsStorage`); a run started from the
  top bar or Ctrl/Cmd+Enter shows the Console instead of the Run tab.
- One console: `ConsoleLine.kind` = print / info / warning / error / output. The store logs run
  start and end, retries, failed nodes (code, node title, node type, message), rejected runs
  with each problem, and outputs. `<ConsolePanel>` is a plain table with kind filters; the Run
  panel lost its event log.
- Conversions (node-api.md §1.1): `defineNode({ conversion: true })`, `findConversions(catalog,
  from, to)`; generics limited by `t.var("T", { oneOf })` (types.md §5.2.1). Std conversions:
  As text (`convert.toText`), As JSON (no parsing), As int / As float (text or json), As boolean
  (any value, never fails), As JSON array, Float to int. Removed: `convert.parseInt`,
  `convert.parseFloat`, `json.asJson`, `json.make*`. Get field / Set field parse JSON text when
  they step into it (`json.invalid_json`). The canvas inserts the best conversion when a wire
  joins two types that do not fit (`planConnection`).
- Secret vault (secrets.md): `secret` primitive (value = secret name), `SecretVault`
  (memory, SQLite AES-256-GCM with `vault.key` / `BRIAR_VAULT_KEY`), `ctx.secrets.read` limited
  to secrets a node was given, REST `/secrets`, client `secrets`, editor `<VaultProvider>`,
  `<SecretPicker>` (dropdown + "+"), `<SecretsPanel>`.
- Settings (settings.md): `definePack({ settings })`, `ctx.settings.get`, `SettingsStore`
  (memory, SQLite), REST `/settings`, client `settings`, editor `<SettingsPanel>` (app sections
  plus one section per pack). Studio: Settings in the top bar (Secrets, OpenAI, Studio).
- `@briarflow/nodes-openai`: `openai.text` (Responses API) and `openai.image` (Images API,
  bytes to the media store); keys only from Settings → OpenAI (default / text / images; nodes
  have no key input). Loaded by apps/server always. Fake-fetch tests only; not live-tested.
- Context menus, modals, confirm dialogs, the panel move menu and the splash card are plain dark panels; wood is for nodes and the walnut top bar only.
- Studio: ⚙ Settings sits at the right end of the top bar, also without a context.
- Verified in headless Chrome against a separate test server: run → console rows, inputs kept
  across runs and a reload, Settings → OpenAI → "+" creates and picks a secret (listing has no
  value), int → text wire inserts As text, failed nodes show as error rows.
- Python SDK: no `secret` / `json` support yet.

### Node variants (2026-10-24)
- Core (node-api.md §1.2): `defineNode({ variants: { title, default, options: { name:
  variant({ inputs, outputs, config, run }) } } })`; one full definition per variant, linked by
  `def.variants`; `variantDefinition`, `nodeDefinition(catalog, node)`; descriptors carry
  `variants` and are rebuilt exactly by `definitionFromDescriptor`. `NodeInstance.variant`;
  diagnostic and command error `node.unknown_variant`.
- Authoring: `node.add { variant? }` (always stored), new `node.setVariant { variant, config? }`
  (keeps config the new variant shares, removes wires/constants of vanished ports, one undo
  step). Facade: `flow.nodes.add(type, { variant })`, `node.setVariant()`.
- Runtime: runs the variant's `run`; cache key includes the variant. Testing: `runNode(def,
  inputs, { variant })`; `describeNodePack` checks every variant; kit pack has `kit.shaped`.
- Editor: variant dropdown under the node header and in the inspector; the drop-wire menu
  offers each fitting variant.
- `openai.text`: one variant per model (gpt-5 / -mini / -nano take Reasoning effort;
  gpt-4.1 / -mini, gpt-4o / -mini take Temperature; "Other model" takes any id).
  `openai.image` (updated 2026-10-24 to the current Images API): GPT Image 2.5 Flare (default)
  and Sunburst, GPT Image 2 (size presets or a custom WIDTHxHEIGHT checked before the call,
  quality up to xhigh/max on 2.5), GPT Image 1.5 and 1 mini (deprecated, shut down
  2026-12-01; fixed sizes). All take format, compression, background, moderation.
  DALL·E 2/3 and gpt-image-1 are gone from the API and from the node; saved nodes on them
  show `node.unknown_variant` until another model is picked. Saved OpenAI nodes from before
  variants keep their old `model` config, which the new variants reject (`config.invalid`).
- No other std/mock/anthropic node changes shape with a choice, so they stay single-shaped.
- Planned: nested variants (OPEN_QUESTIONS Q-NODE-10).

### Members, media previews and the image pack (2026-10-24)
- Core: members of a type (types.md §12): struct fields (read/write), media metadata (id, mime,
  extension, name, size, url, width, height, duration, fps), error fields, length of text and lists
  (read-only). `typeMembers`, `memberAt`, `memberPaths`, `readMember`, `writeMember`,
  `MEMBER_NODE_TYPES`.
- Std: `briar.member.get` / `briar.member.set` (pure; titles "Get .path" / "Set .path").
- Editor: a wire dropped on empty canvas lists "Get member" / "Set member" with every member of
  the output's type (nested as dotted paths); member nodes are not in the palette.
- Editor: nodes with image / video outputs show a preview window with the last run's media
  (a 2-column grid for several outputs, hidden when zoomed out); double-click opens a large
  viewer (details, thumbnails, open in new tab).
- New pack `@briarflow/nodes-image` (`image`), loaded by the server: Make image (RGBA / RGB
  channels / one color), Split channels (RGBA / RGB), Resize, Crop, Rotate / flip, Grayscale,
  Invert colors, Convert. PNG + JPEG through pure JS codecs.

### Media registry, last runs and View image (2026-10-25)
- Media values are `{ mediaId }`: ids of entries in a media registry (media.md). An entry holds
  the mime, size, dimensions, file name and where the bytes are: raw bytes in the registry
  (`data`), a blob (`stored`, uploads), or a web URL (`link`). `SqliteMediaRegistry` keeps it in
  the server's database; `MediaStore` is now only the blob store (`BlobRef`). `readMedia` is
  gone: nodes use `ctx.media.read / entry / put / link`.
- The loader (`createMedia`) keeps recent bytes in memory (256 MB) in front of the database;
  another process loads them from the database. The image pack keeps decoded pixels by media
  id. Image entries get width / height from the file header (uploads too).
- What nodes make is transient (owned by its run). Each flow keeps its last run
  (`SqliteLastRunStore`); a new run replaces it, and when it ends the media of older runs of the
  flow is deleted. At start, unfinished runs become `interrupted` and orphaned media goes.
- Carry-over: media-making nodes with the same reuse key (cache key) as in the last run take
  its outputs instead of running (`cached`); Force run (`force: true`, editor checkbox
  "Force run") runs everything again. A run's result resolves after its record is saved.
- REST: `POST /media` returns the entry; `POST /media/links`; `GET /media/:id/entry`;
  `GET /media/:id` redirects links; `GET /flows/:id/last-run`; `force` on run requests.
- Engine checks media inputs before a node runs (missing → `media.not_found`, wrong kind →
  `media.kind_mismatch`, constraints → `node.invalid_input`).
- Editor: restores the active flow's last run after loading, so previews survive reloads;
  media chips, the viewer and the console read entries (`client.media.entry`).
- Std: `debug.image` (View image), a frontend node on the execution line: shows the image on
  the node and in the console (mime · size · bytes); reading it makes the image nodes before it
  run.
- Python bridge: wire protocol unchanged; the bridge maps `{ mediaId }` to and from the worker's
  `{ uri, mime, …, url }`.

### After MVP (next)
- Build + run the Docker image on a machine with Docker; consider a bundled server build (smaller image).
- Live-test `@briarflow/nodes-anthropic` and `@briarflow/nodes-openai` with real keys.
- REQ-26 P2/P3; studio: restore last active flow on reload; studio palette for server-only packs with dynamic ports
  (anthropic.structured is "approximate" in the editor without a local pack).
- Tester suites still pending from the original plan (phase-3 public suites, HTTP contract suite per phase-5 §6.1).
