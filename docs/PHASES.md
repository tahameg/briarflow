# Briarflow Phases

Each phase has an owner, deliverables and an exit check. A phase is done only when its exit
check passes (`npm test` green, `npm run typecheck` clean) and `docs/STATUS.md` is updated.

| # | Phase | Main owners | Packages |
|---|---|---|---|
| 0 | Foundation | lead, designer | repo scaffold, specs, design system |
| 1 | Core | lead, tester | `@briarflow/core`, `@briarflow/testing` (start) |
| 2 | Authoring | lead, tester | `@briarflow/authoring` |
| 3 | Runtime + std nodes | backend, tester | `@briarflow/runtime`, `@briarflow/nodes-std`, `@briarflow/nodes-mock` |
| 4 | Facade + storage | lead, backend, tester | `briarflow`, `@briarflow/storage-fs`, `@briarflow/storage-sqlite`, conformance suites |
| 5 | Server + client | backend, frontend, tester | `@briarflow/server`, `@briarflow/client`, `apps/server` |
| 6 | Python extension | backend, tester | `@briarflow/python`, `python/briarflow` |
| 7 | Editor + studio | frontend, designer, tester | `@briarflow/editor`, `@briarflow/editor-react`, `apps/studio` |
| 8 | Providers + packaging | backend, lead | `@briarflow/nodes-openai`, `@briarflow/nodes-anthropic`, Dockerfile, compose, docs |

## Phase 0 — Foundation

- Lead: npm workspaces, `tsconfig.base.json` (strict, paths), Vitest root config,
  package skeletons for phases 1–4, `npm test` / `npm run typecheck` scripts, `.gitignore`.
- Designer: `docs/specs/commands.md`, `docs/specs/variables.md`, `docs/specs/node-api.md`,
  `docs/specs/python-protocol.md`, `docs/specs/design-system.md`, `docs/specs/rest-api.md`;
  list open questions in `docs/OPEN_QUESTIONS.md` with a proposed default for each.
- Exit: `npm install && npm test && npm run typecheck` succeed on empty packages; specs exist.

## Phase 1 — Core

- Type IR, `t` builder with static inference, shorthand parser, scope resolution,
  assignability, generic binding, value validation, JSON Schema export.
- Document model types, factories (`createContextDocument`, `createFlowDocument`), ids.
- Serialization (deterministic) + migration registry.
- `defineNode`, `definePack`, `defineStruct`/`defineEnum` for packs, `NodeCatalog`,
  `toNodeDescriptor`.
- Flow/context validation → diagnostics with stable codes.
- Extension interfaces + error classes.
- Exit: tester's core suite green; ≥ 90% line coverage on type system and validation.

## Phase 2 — Authoring

- Full command set from `docs/specs/commands.md`, `createContextEditor`, batch atomicity,
  undo/redo, injected id generator and clock.
- Exit: every command has accept + reject tests; undo/redo round-trips; soft breakage is
  reported as diagnostics.

## Phase 3 — Runtime + std nodes

- Engine, Run, events (replayable), cancellation, retries, timeouts, cache, concurrency.
- `nodes-std`: input/output, variable get/set, global get/set, struct make/break,
  list (length, get, map-later), text template, text join, conversions, constants.
- `nodes-mock`: fake LLM (deterministic text), SVG image generator, fake 3D model.
- Exit: end-to-end test: form struct → template → mock LLM → mock image → output.

## Phase 4 — Facade + storage

- `createBriar`, context index, fluent handles, run registry, `MemoryContextStore`,
  `MemoryMediaStore`, `envSecrets`.
- `storage-fs`, `storage-sqlite`; `@briarflow/testing` conformance suites.
- Guide: `docs/guides/writing-a-store.md`, `docs/guides/writing-nodes.md`.
- Exit: conformance suites pass for memory, fs, sqlite; README quick start runs as a test.

## Phase 5 — Server + client

- Hono app with all routes, SSE events, error format, `authorize` hook, `serve()`.
- Client SDK with `RemoteRun`.
- `apps/server` example.
- Exit: client ⇄ server integration tests over a real HTTP port.

## Phase 6 — Python extension

- Python SDK (decorators, type bindings, worker server, media helpers) + pytest suite.
- TS bridge (`pythonPack`, `spawnPythonWorker`) + integration test that spawns a real worker.
- Exit: a flow runs a Python node end-to-end from TS.

## Phase 7 — Editor + studio

- Headless editor store with optimistic apply and server sync.
- React Flow editor components, type/variables/run panels.
- `apps/studio` brutalist UI.
- Exit: studio builds; editor store tests green; manual smoke test documented.

## Phase 8 — Providers + packaging

- OpenAI and Anthropic node packs (text, structured output, image), secrets handling.
- Dockerfile (server + studio), compose file, root README.
