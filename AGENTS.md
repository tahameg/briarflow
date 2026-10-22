# AGENTS.md

Instructions for any AI agent (or human) working in this repository.

## What this project is

Briarflow: a strongly typed, graph-based framework for prompt construction and AI-result
pipelines. Library first; a REST service and a visual editor sit on top.

Read before working:
1. `docs/ARCHITECTURE.md` (source of truth for design)
2. `docs/PHASES.md` (what is built when)
3. `docs/STATUS.md` (what is done, what is in progress)
4. `docs/specs/*` relevant to your task

## Team

| Role | Agent | Owns |
|---|---|---|
| Orchestrator | main session | Dispatches phases and tasks, keeps `docs/STATUS.md` current, resolves conflicts between agents |
| Project / UX designer | `ux-designer` | Fills design gaps: specs in `docs/specs/`, `docs/OPEN_QUESTIONS.md`, design system, API ergonomics reviews |
| Lead developer | `lead-developer` | Architecture, root config, `core`, `authoring`, `server` + `apps/server` (reassigned from backend on 2026-10-21); writes interface contracts and phase task breakdowns (`docs/tasks/phase-N.md`); reviews and integrates other developers' work |
| Backend developer | `backend-developer` | `runtime`, `nodes-*`, `storage-*`, `briarflow` facade (reassigned from lead on 2026-10-21 to unblock phase 4/5; lead reviews), `python` (TS + Python SDK) |
| Frontend developer | `frontend-developer` | `client`, `editor`, `editor-react`, `apps/studio` |
| Tester | `tester` | Tests against interfaces from the lead, `@briarflow/testing` conformance suites, runs full suite, files bugs in `docs/tasks/bugs.md` |

### Workflow per phase

1. **Lead** writes `docs/tasks/phase-N.md`: the public interfaces (TypeScript signatures with
   JSDoc), task list per developer, and acceptance criteria. Interfaces are committed as real
   `.ts` files (types only, implementations may throw `not implemented`) so the tester can
   compile tests against them.
2. **Tester** writes tests from the interfaces and acceptance criteria, in parallel with
   implementation.
3. **Developers** implement in their own packages only.
4. **Tester** runs the full suite and reports failures to `docs/tasks/bugs.md`
   (failing test, expected, actual, suspected owner).
5. **Lead** reviews, integrates, and marks the phase done in `docs/STATUS.md`.

### Ownership rules (avoid edit conflicts)

- Edit only packages you own. Need a change elsewhere? Write it in `docs/tasks/requests.md`
  (who, what, why) and finish what you can.
- Root files (`package.json`, `tsconfig.base.json`, `vitest.config.ts`) belong to the lead.
- Tests in `packages/*/test/` belong to the tester; developers may add unit tests for
  internal helpers in `packages/*/test/internal/`.
- Specs in `docs/specs/` belong to the designer; others comment in `docs/OPEN_QUESTIONS.md`.

## Conventions

- TypeScript strict, ESM only, named exports only, no default exports.
- Each package: `src/index.ts` is the public surface; everything else is internal.
- Public APIs get JSDoc with a short example.
- Shared packages (`core`, `authoring`, `runtime`, `nodes-std`, `nodes-mock`, `client`,
  `editor`) must not import `node:*`, Node-only packages, or React.
- Async: `Promise`, `AbortSignal`, `AsyncIterable`. No `EventEmitter`, no RxJS.
- Errors: subclasses of `BriarError` with a stable `code` string and a human message that
  says what is wrong, where, and how to fix it.
- Documents are immutable: never mutate a `ContextDocument` in place.
- Time and ids are injectable (`clock`, `idGenerator`) so tests are deterministic.
- Keep comments sparse and meaningful; prefer clear names.
- Python: stdlib only for the SDK runtime, type hints everywhere, Python ≥ 3.10, pytest.

## Commands

```bash
npm install
npm test              # all Vitest suites
npm run typecheck     # tsc --noEmit across the repo
npm test -- packages/core     # one package
cd python && python -m pytest
```

A task is not done until `npm test` and `npm run typecheck` pass. If you could not make them
pass, say so explicitly in your report, with the failing output.
