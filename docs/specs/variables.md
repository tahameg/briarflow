# Spec: Variables and globals

Status: draft v1 (phase 0). Owner: ux-designer. Implemented in `@briarflow/core`
(validation), `@briarflow/runtime` (semantics), `@briarflow/nodes-std` (nodes), `briarflow`
(applying global writes).

## Deviations from ARCHITECTURE.md

1. **`ExecContext.globals` / `ExecContext.variables` are read-only and return run-start
   values.** ARCH §4.9 gives them `get` and `set`. v1 removes `set`: every write goes through a
   `briar.global.set` / `briar.variable.set` node so that validation can see it and order it.
   `get` returns the value at run start (globals snapshot / variable default), never a
   mid-run value, so results do not depend on scheduling. A node that calls these getters is
   not cached for that execution (see runtime.md §6).

---

## 1. Summary (one paragraph for users)

> A **get** node gives you the latest value that a **set** node placed *before* it in the
> graph wrote — or the starting value if no set comes before it. "Before" means: connected
> upstream by wires, or simply not downstream. Two set nodes of the same variable must be
> connected one after the other. Public variables come back in the run result; global writes
> are saved after the run succeeds.

## 2. Kinds

| | Global variable | Flow variable |
|---|---|---|
| Defined on | context (`globals`) | flow (`variables`) |
| Access | `readonly` (must have a value) / `readwrite` | `public` / `private` |
| Allowed types | primitives, global, pack | public: primitives, global, pack; private: anything visible incl. local |
| Starting value in a run | snapshot of the stored value when the run starts | `default` (or none) |
| Visible after the run | `RunResult.globalWrites`; persisted by the facade after success | public only: `RunResult.variables` |
| Read node | `briar.global.get` | `briar.variable.get` |
| Write node | `briar.global.set` (readwrite only) | `briar.variable.set` |

## 3. Nodes

| Node | config | Inputs | Outputs |
|---|---|---|---|
| `briar.variable.get` | `{ variableId }` | — | `value: <variable type>` |
| `briar.variable.set` | `{ variableId }` | `value: <variable type>` | `value: <variable type>` (pass-through of what was written) |
| `briar.global.get` | `{ globalId }` | — | `value: <global type>` |
| `briar.global.set` | `{ globalId }` | `value: <global type>` | `value: <global type>` |

All four have `cache: false`. A set node's input may be a constant (`node.setValue`), e.g. to
reset a variable. The pass-through output lets you use the written value downstream without a
get node.

## 4. Ordering rule

Definitions for one variable `X` (flow variable or global) in one flow:

- `W` = set nodes of `X`, `G` = get nodes of `X`.
- `a ⇝ b` means there is a path of **data edges** from `a` to `b`.

**Rule 1 — writers are totally ordered.** For every two writers `w1, w2 ∈ W`, either
`w1 ⇝ w2` or `w2 ⇝ w1`. Otherwise validation error `variable.unordered_writes`. Writers are
numbered `w1 … wk` in that order.

**Rule 2 — implicit ordering edges.** For every `g ∈ G` and `w ∈ W` with **not** `g ⇝ w`, the
engine adds an implicit ordering edge `w → g` (g waits for w). If `g ⇝ w`, then w depends on
g's output, so g runs first and reads the earlier value.

**Rule 3 — what a get reads.** `g` reads the value written by the last writer `wi` that has an
ordering edge to it (the highest `i` with not `g ⇝ wi`). Because writers are totally ordered,
this set of writers is always a prefix `w1 … wi`. If there is none, `g` reads the starting
value.

**Rule 4 — acyclicity.** Data edges plus implicit edges must form a DAG. Otherwise
validation error `flow.cycle` with a path that marks implicit edges (`… ⇢ (writes var count) ⇢ …`).
Implicit edges are computed from data paths only, so the result never depends on the order
rules are applied.

**Rule 5 — final value.** The final value of `X` is the value written by `wk`, or the starting
value if `W` is empty or the run did not reach a writer.

### Why this rule

- Pure dataflow is kept: no hidden "execution order" beyond what is drawn plus one simple,
  visible rule. The editor draws implicit edges as thin dashed lines on hover/selection of a
  variable node.
- It is deterministic: identical graph + inputs ⇒ identical reads, at any concurrency.
- The common cases need no extra wiring:
  - "set once, read in many places" → all gets wait for the set.
  - "counter": `get count → add 1 → set count` → the get is upstream of the set, reads the old
    value; the final value is the incremented one.
- Alternatives rejected: *reads always see the run-start value* (makes private variables
  useless — a get could only ever return the default); *explicit trigger ports* (needs a
  non-data "trigger" type and more wiring in every flow).

### Examples

```
A) input.topic ─▶ set(summary)          get(summary) ─▶ output.summary
   get has no data path to set ⇒ implicit set ⇢ get. get reads what set wrote.

B) get(count) ─▶ add1 ─▶ set(count)      get(count) is upstream of set ⇒ reads the default.
   RunResult.variables.count = default + 1 (if public).

C) input.a ─▶ set(x)     input.b ─▶ set(x)
   two writers with no path between them ⇒ error variable.unordered_writes.
   Fix: chain them (set#1.value ─▶ something ─▶ set#2) or use one writer.

D) get(x) ─▶ set(y)      get(y) ─▶ set(x)
   implicit set(y) ⇢ get(y), set(x) ⇢ get(x) ⇒ get(x) ─▶ set(y) ⇢ get(y) ─▶ set(x) ⇢ get(x)
   ⇒ flow.cycle.
```

## 5. Validation codes

| Code | Severity | Message template |
|---|---|---|
| `variable.unordered_writes` | error | `Variable "{name}" is written by {a} and {b}, but neither comes after the other. Connect them in sequence or use one Set node.` |
| `variable.read_before_write` | error | `{node} reads "{name}" before anything writes it, and "{name}" has no default. Give it a default or move a Set node before it.` |
| `variable.write_to_readonly` | error | `{node} writes readonly global "{name}". Make the global readwrite or remove the node.` |
| `variable.unknown` | error | `{node} refers to a variable that no longer exists. Pick another variable or remove the node.` |
| `variable.unused` | warning | `Variable "{name}" is never read or written.` (private only) |
| `variable.invalid_default` | error | `Default of variable "{name}": {value message}` |
| `global.invalid_value` | error | `Value of global "{name}": {value message}` |
| `flow.cycle` | error | see commands.md; path includes implicit edges |

`variable.read_before_write` is raised when a get node has no writer ordered before it and the
variable has no default — unless its type is optional (starting value `null`) or a list
(starting value `[]`). Globals always have a starting value or are `undefined`: a readwrite
global with no value read before any write → same code.

## 6. Runtime semantics

1. **Snapshot.** At run start the engine copies the stored values of all globals of the
   context (from the document passed to `engine.run`) and initializes each flow variable
   to its default (or `null` for optional, `[]` for list, else "unset").
2. **Get node** completes with the value per Rule 3. Get and Set nodes are executed by the
   engine itself (runtime.md §3.1): no concurrency slot, never cached, no retries/timeout.
3. **Set node** validates the value against the variable type (constraints included; failure
   → node fails with `node.invalid_input`), records it as the variable's current value, and
   outputs it.
4. **Skipped writers.** If a writer is skipped (upstream failure), gets ordered after it are
   skipped too (`reason: "upstream_failed"`). The run is failed anyway.
5. **`ctx.globals.get(name)` / `ctx.variables.get(name)`** inside any node return the
   run-start values (snapshot / default). Unknown name → throws `NodeError("variable.unknown")`.
   Private variables are readable this way only from nodes in the same flow (always true in
   v1; there are no sub-flows).

## 7. Public variables in `RunResult`

- `RunResult.variables` = `{ [publicVariableName]: finalValue }` for **every** public
  variable of the flow (also those never written: they report their starting value; an
  "unset" variable is omitted).
- Present when `status === "succeeded"`. On `failed` / `cancelled` it is omitted (partial
  state is not exposed as a result; it can be seen in node events).
- Keys are variable **names** at run time.

## 8. Global writes

- `RunResult.globalWrites` = `{ [globalName]: finalValue }` for every readwrite global with at
  least one writer that executed. Present only on `succeeded`.
- **The engine never touches stores.** The `briarflow` facade applies writes after a
  successful run:
  1. load the context, 2. for each write, find the global **by id** (captured at run start;
  names are only for the result), 3. apply `global.setValue` commands as one batch, 4. save
  with `expectedRevision`.
- On `RevisionConflictError` the facade reloads and retries, up to 5 attempts. The batch is
  recomputed each time.
- If at apply time a global was deleted, became readonly, or its new type rejects the value,
  that write is **dropped**, the others are applied, and the facade logs a warning
  `global.write_dropped` with `{ runId, globalId, reason }`. The run result is not changed
  (it already completed). `briar.runs.get(id)` exposes `globalWriteStatus:
  "applied" | "partial" | "failed"`.
- Applying writes happens before `run.result` resolves in the facade, so `await run.result`
  means "writes are persisted". (The engine-level `Run` from `@briarflow/runtime` resolves
  without persisting.)

## 9. Concurrency between runs

- Each run works on its own snapshot. Runs never see each other's writes mid-run.
- Writes are applied in order of run **completion**: last completed run wins
  (no merge, no compare-and-set on values). This is documented, simple, and good enough for
  configuration-like globals. Counters incremented by concurrent runs can lose updates —
  documented limitation (see OPEN_QUESTIONS Q-VAR-1).
- A context edit made during a run does not affect that run (it holds its own document).
