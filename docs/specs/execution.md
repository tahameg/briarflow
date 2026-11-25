# Spec: Execution lines

Status: v1 (2026-10-23). Owner: lead. Implements the user's model: an execution line, separate
from data wires, decides which nodes run and in what order.

## 1. Kinds of nodes

| Kind | Execution ports | Runs |
|---|---|---|
| **Input** (`briar.input`) | out `then` | first, always |
| **Output** (`briar.output`) | in `in` | when the line reaches it; its inputs become the run outputs |
| **Execution node** (default) | in `in`, out `then` (+ `failed` with `canFail`) | when the line reaches it |
| **Pure node** (`pure: true`) | none | when a node that is running reads one of its outputs |
| **Flow control node** (§7: Branch, Switch, For each, For range) | in `in`; its own outputs (`true`/`false`, cases, `body`/`completed`) | when the line reaches it; it picks the output the line follows, or runs its body per iteration |

- `defineNode({ pure: true })` is for nodes that only compute outputs from inputs:
  conversions, operators, templates, list helpers, struct make/break, Break error, constants,
  variable and global GET.
- Everything else sits on the line. That includes variable and global SET, Print, AI calls and
  Python nodes.
- `defineNode({ canFail: true })` adds the `failed` execution output and an **`error` output**
  of the built-in struct `Error`.
  - It is set by node authors whose node can fail on purpose: AI calls, network, files, Python.
  - The editor shows the `error` output on the header row, in red, next to `failed`.
  - A node that already declares an output named `error` cannot also set `canFail`.
- Execution ports are derived from the definition (`execPortsOf`), never stored.

## 2. The `Error` type

`Error` is a built-in struct (types.md §1.2) whose value is
`{ code: string; message: string; node: string?; nodeId: string?; details: Json? }`.

- The engine sets it on the failing node's `error` output, only when execution takes the
  `failed` line. On success the output is absent.
- You read its fields with **Break error** (`briar.error.break`, pure): code, message, node,
  nodeId, or with Get member (`error.code`, types.md §12).

## 3. Document

- `FlowDocument.execEdges?: ExecEdge[]`. Each line is `{ id: "x_…", from: { node, port }, to: { node, port: "in" } }`.
- An execution output has at most one line. An execution input can take many.
- No loops in the lines themselves: loops are flow control nodes (§7).
- `flow.create` starts every new flow with one line, Input `then` → Output `in`.
- **Flows without `execEdges`**, i.e. made before execution lines, keep running data-driven:
  every node runs, in dependency order.
  - The studio wires them when it loads them (`flow.exec.enable`), and the edit is saved.
  - `flow.exec.enable` builds the line Input → every execution node in data order (variable
    write → read order respected) → Output, using `autoExecEdges`.
  - The facade offers `flow.wireExecution()` for the same.

Commands:

| Command | Effect |
|---|---|
| `exec.connect { flowId, from, to, id?, index? }` | Adds a line. A line already leaving that output is replaced (it is restored on undo). Rejects unknown execution ports, self lines and loops. |
| `exec.disconnect { flowId, edgeId }` | Removes a line. |
| `flow.exec.enable { flowId }` | Auto-wires a flow without lines; does nothing otherwise. |
| `flow.exec.set { flowId, edges \| null }` | Replaces all lines; `null` returns to "no lines". Used by undo. |

`node.remove` removes the node's lines too. `flow.delete` restores them on undo.

## 4. Validation (flows with lines)

1. **Live nodes** are the nodes reachable from Input along lines, plus the pure nodes they read
   from (transitively). Diagnostics on nodes that are not live are dropped: such a node never
   runs and "can hang around". Problems on wires (`edge.*`) stay.
2. The checks:

   | Code | Severity | Meaning |
   |---|---|---|
   | `exec.unknown_node` | error | a line points to a missing node |
   | `exec.unknown_port` | error | a line uses an execution port the node does not have |
   | `exec.duplicate_output` | error | two lines leave one execution output |
   | `exec.cycle` | error | the lines form a loop |
   | `exec.value_unavailable` | error | a live node reads (directly or through pure nodes) the output of a line node that does not always run before it (does not dominate it: after a Branch, neither side does), or that is not on the line at all |
   | `exec.loop_value_outside` | error | a node outside a loop's body reads the loop's outputs (they only have values inside the body) |
   | `exec.loop_escape` | error | a loop's body is not closed: a body node is also reached from outside the body or after `completed`, or the body reaches Output |
   | `exec.output_unreachable` | warning | the flow has outputs but the line never reaches Output |

3. The variable-ordering rules of data-driven flows (variables.md §4) do not apply: the line
   orders writes and reads.

## 5. Running (flows with lines)

1. Execution starts at Input and follows `then` one node at a time.
2. **Inputs:** before a node runs, the engine computes the pure nodes it reads (and those they
   read). A pure node runs at most once per run.
3. **Success:** the node's outputs are kept and execution follows `then`.
4. **Failure:** retries apply first.
   - **`failed` line connected:** the failure is handled. `node.failed` is emitted, the node's
     `error` output is set, execution follows `failed`, and the run can still succeed.
   - **Otherwise:** the run fails (`run.node_failed`). Reached nodes that have not started are
     skipped. Nodes never reached emit nothing.
   - **A pure node fails:** the line node waiting for it fails instead (`node.invalid_input`),
     and may take its own `failed` line.
5. **The line ends:** the run finishes.
   - If Output ran, its inputs are the run outputs.
   - If the flow declares outputs and Output was not reached, the run fails with
     `run.output_not_reached`.
6. **Variables:** a GET (pure) reads the latest value written so far along the line, else the
   start value.
7. Execution is sequential. Concurrent branches will be flow control nodes.

## 6. Editor

- **Execution sockets** sit on the header row: `in` on the left; `then` on the right; `failed`
  below `then`, next to the red `error` output.
- **Lines** are drawn thicker and brighter than data wires and follow the run.
- Dropping an execution wire on empty canvas lists execution nodes and adds the pick, already
  connected.
- Flow control nodes show one row per execution output of their own (`true`, `false`, a
  Switch's cases, `body`, `completed`), each with its socket on the right.
- Loading a flow without lines wires it (`flow.exec.enable`).

## 7. Flow control

Two kinds, declared on the node definition (node-api.md §1.3):

| Kind | Nodes | What happens |
|---|---|---|
| **route** | Branch (`briar.branch`), Switch (`briar.switch`) | the node runs, then `route(...)` names the execution output the line follows |
| **loop** | For each (`briar.forEach`), For range (`briar.forRange`) | the node computes its iterations; the `body` line runs once per iteration with the node's outputs set to that iteration's values; then the line follows `completed` |

- **Branch:** input `condition` (any type), outputs `true` / `false` by the one truthiness rule
  (types.md §7.1).
- **Switch:** config `type` (an enum, `string` or `int`; default `string`) and `cases` (one per
  line, for strings and ints); input `value`. Its outputs are the cases (an enum's members) and
  `default`, followed when no case equals the value.
- **For each:** input `list: list<$T>`; outputs `item: $T`, `index`, `isFirst`, `isLast`.
  Lists only.
- **For range:** inputs `first`, `last` (both included; `last < first` → no iterations);
  outputs `index`, `isFirst`, `isLast`. At most 100 000 iterations (`loop.too_many_iterations`).
- **A body** is what the `body` line reaches. It ends where its line ends (a node whose next
  output has no line); then the next iteration starts. Bodies may hold Branches, Switches and
  other loops. Each iteration runs the body's line nodes again, and the pure nodes they read
  or that read the loop or the body (a variable GET sees this iteration's writes). Variables
  carry values from one iteration to the next.
- **An output without a line** ends the line there: outside a loop the run finishes
  (`run.output_not_reached` if the flow has outputs); inside a body the iteration ends.
- **Failures:** a failure in the body without a `failed` line stops the loop: the loop node
  fails with `loop.body_failed` and the run fails. Cancelling ends running loops cancelled.
- **Events:** a body's nodes emit `node.started` / `node.completed` once per iteration; the loop
  node reports `node.progress` per iteration (`Iteration 2 of 5`) and completes once, after the
  last.
- Flow control nodes are never cached.

## 8. Split ports

A struct port (input or output; on any node, the flow's Input and Output and a variable's GET
included) can be shown as one port per member. Right-click the port → **Split**; right-click a
member → **Collapse** (commands `node.splitPort` / `node.collapsePort`, undoable).

- **Stored** on the node: `NodeInstance.split = { inputs?: string[], outputs?: string[] }`,
  paths of split ports (`"portrait"`, nested `"portrait.image"`). Member ports are named by
  their path (`"portrait.image"`); edges and constants use those names.
- **Members:** a split input shows the struct's instance fields (with their defaults); a split
  output shows its instance and static fields. A member that is a struct can be split again.
- **Edges and constants:** splitting removes the port's edges and constant; collapsing removes
  the members' edges and constants (and the splits inside it). Undo restores them.
- **Running:** the node still takes and gives the whole struct. Before it runs, the members of a
  split input are put back together (deepest first; an unwired member without a value is null).
  After it runs, a split output's struct gives each member on its member port.
- A path that is not a struct port (the type changed) stays as it is with a warning
  (`node.split_invalid`); collapse it.
