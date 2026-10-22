# Bugs

Failing tests and defects found by the tester (or anyone). Append new entries at the bottom;
mark them fixed instead of deleting them.

Format:

```md
## BUG-<n>: <short title>
- **Reported by:** <agent> · **Date:** YYYY-MM-DD · **Suspected owner:** <agent>
- **Failing test:** `packages/<pkg>/test/<file>.test.ts` › "<test name>"
- **Expected:** …
- **Actual:** … (paste the relevant failure output)
- **Repro:** `npm test -- packages/<pkg>/test/<file>.test.ts`
- **Status:** open | in progress | fixed (<date>, <who>) | won't fix (<reason>)
```

---

## BUG-1: Field-level type diagnostics put the *referenced* type id in `path.typeId`
- **Reported by:** tester · **Date:** 2026-10-21 · **Suspected owner:** lead-developer (`packages/core/src/validation/validate.ts`)
- **Failing tests:** `packages/core/test/validation.test.ts` › "diagnostic codes: positive fixtures" ›
  "type.unknown_id: struct field with an unknown type id" and
  "visibility.local_type_in_global: global struct using a local type"
- **Expected:** a diagnostic about field `x` of global struct `ty_bad` points at that field:
  `path: { typeId: "ty_bad", field: "x" }` (same convention `type.invalid_default` already uses:
  `{ typeId: "ty_char", field: "age" }`, and `DiagnosticPath` docs: `typeId` + `field` locate a field).
- **Actual:** `path: { typeId: "ty_ghost", field: "x" }` for `type.unknown_id` and
  `path: { typeId: "ty_local", field: "l" }` for `visibility.local_type_in_global` — `typeId` is the
  referenced (missing / local) type, so `{typeId, field}` names a field that does not exist and the editor
  cannot highlight the offending struct field. Messages are fine (`Field "Bad.x" refers to type id ty_ghost…`).
  The referenced id could go to `details` instead (e.g. `details: { refTypeId }`).
- **Repro:** `npm test -- packages/core/test/validation.test.ts -t "unknown type id|global struct using"`
- **Status:** fixed (2026-10-21, lead-developer — verified by tester: both tests green on re-run)

## BUG-2: `type.rename` test uses an invalid name to test case-insensitive duplicates
- **Reported by:** lead-developer · **Date:** 2026-10-21 · **Suspected owner:** tester
- **Failing test:** `packages/authoring/test/commands-types.test.ts` › "type.rename / type.setDescription" › "rejects invalid, reserved, duplicate names and unknown ids"
- **Expected (by the test):** `type.rename` to `"artSTYLE"` → `type.duplicate_name`.
- **Actual:** `type.invalid_name` — `"artSTYLE"` starts with a lowercase letter, so it fails the
  type-name regex before uniqueness is checked. Use e.g. `"ARTSTYLE"` or `"Artstyle"`.
- **Status:** fixed (2026-10-21, tester — test now uses "ARTSTYLE"; lead was right, "artSTYLE" fails the type-name regex first)

## BUG-3: `edge.disconnect` inverse expectation lacks `index`
- **Reported by:** lead-developer · **Date:** 2026-10-21 · **Suspected owner:** tester
- **Failing test:** `packages/authoring/test/commands-edges.test.ts` › "edge.disconnect" › "by edgeId"
- **Expected (by the test):** inverse `{ op: "edge.connect", flowId, id: "e_2", from, to, restore: true }`.
- **Actual:** the inverse also has `index: 1`, so undo puts `e_2` back at its original position
  (phase-2.md §3.1 "`index` on creating commands", DECISIONS #46). Without it the restored edge
  is appended and the undo invariant (document deep-equal) fails. Please add `index: 1`.
- **Status:** fixed (2026-10-21, tester — assertion relaxed to `toMatchObject`; DECISIONS #46 allows the optional `index` on inverse creating commands)

## BUG-4: undo corpus "mixed multi-command batch" connects from a node id the new flow does not have
- **Reported by:** lead-developer · **Date:** 2026-10-21 · **Suspected owner:** tester
- **Failing tests:** `packages/authoring/test/undo.test.ts` › "undo / redo invariants (applyCommands|ContextEditor)" › "mixed multi-command batch"
- **Expected (by the test):** `edge.connect` from `n_in.a` in the new flow `flow_m`.
- **Actual:** `command.unknown_ref` — `flow.create` without `inputNodeId` generates the input
  node id (`n_1` with the sequential generator); `n_in` is the input node of other flows. Pass
  `inputNodeId: "n_in"` (node ids are flow-scoped, so that is allowed) or connect from the
  created id.
- **Status:** fixed (2026-10-21, tester — mixed corpus batch now passes `inputNodeId: "n_in"`, `outputNodeId: "n_out"`)
