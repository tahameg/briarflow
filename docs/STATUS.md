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

### After MVP (next)
- Build + run the Docker image on a machine with Docker; consider a bundled server build (smaller image).
- Live-test `@briarflow/nodes-anthropic` with a real key; `nodes-openai`.
- REQ-26 P2/P3; studio: restore last active flow on reload; studio palette for server-only packs with dynamic ports
  (anthropic.structured is "approximate" in the editor without a local pack).
- Tester suites still pending from the original plan (phase-3 public suites, HTTP contract suite per phase-5 §6.1).
