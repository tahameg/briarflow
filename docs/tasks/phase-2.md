# Phase 2 — `@briarflow/authoring`

Owner: lead-developer (implementation), tester (suites). Backend and frontend developers have
no phase-2 tasks; they consume the API (server in phase 5, editor store in phase 7).

## 1. Goal

The full command set of `docs/specs/commands.md` (authoritative, incl. §1.1a `restore`), a
pure batch applier for servers, and `createContextEditor` with command-based undo/redo.
Pure, synchronous, deterministic (injected id generator and clock), immutable documents with
structural sharing. Shared-package rules: no `node:*`, no Node-only packages, no React.

**Exit check:** `npm run typecheck` and `npm test` green; every command has accept + reject
tests; the generic undo invariant holds for every accepted batch in the suite; soft breakage
shows up as diagnostics.

Contracts are in `packages/authoring/src/` and compile; stubs throw `NotImplementedError`
until the implementation lands. Everything public is exported from `src/index.ts`.

## 2. Module layout (`packages/authoring/src`)

| Path | Contents |
|---|---|
| `commands.ts` | `Command` union (one interface per op), `CommandOp`, `CommandOf<O>`, `COMMAND_OPS`, `isCommandOp`, `TypeInput`, `ScopeInput`, `FieldInputDecl`, `EnumMemberSpec`, `PortRef`, `CommandBase` |
| `result.ts` | `ApplyResult`, `BatchResult`, `CreatedIds`, `CommandError` (+ options) |
| `apply.ts` | `applyCommands`, `applyCommand`, `ApplyOptions` |
| `editor.ts` | `createContextEditor`, `ContextEditor`, `ContextEditorOptions`, `HistoryEntry`, `EditorChange` |
| `internal/*` | implementation (payload schemas, handlers per group, normalization, value rewriting) — not public |

## 3. Public API

```ts
// ---- commands.ts ----
type TypeInput = TypeRef | string;                 // shorthand resolved in the target scope, stored as IR
type ScopeInput = { kind: "global" } | { kind: "flow"; flowId: string };
interface CommandBase { restore?: boolean }        // commands.md §1.1a
interface FieldInputDecl { name: string; type: TypeInput; description?: string; default?: unknown }
type EnumMemberSpec = string | { value: string; label?: string };
interface PortRef { node: string; port: string }

type Command = ContextRenameCommand | … | EdgeDisconnectCommand;  // 65 ops, one interface each
type CommandOp = Command["op"];
type CommandOf<O extends CommandOp> = Extract<Command, { op: O }>;
const COMMAND_OPS: readonly CommandOp[];           // spec order
function isCommandOp(op: unknown): op is CommandOp;

// ---- result.ts ----
interface CreatedIds {                             // {} for commands that create nothing
  typeId?; globalId?; flowId?; inputNodeId?; outputNodeId?;
  typeIds?: Record<string, string>;                // flow.duplicate: old local type id → new
  variableId?; nodeId?; edgeId?; replacedEdgeId?;
}
type ApplyResult =
  | { ok: true; doc: ContextDocument; created: CreatedIds; inverse: Command[]; resolved: Command[];
      diagnostics: Diagnostic[]; changed: boolean }
  | { ok: false; error: CommandError };
type BatchResult = /* same, with */ { created: CreatedIds[] } /* (one entry per command) */;

class CommandError extends BriarError {
  readonly commandIndex: number | undefined;       // 0 for apply()
  readonly op: string | undefined;
  // details is ALWAYS an object: { ...codeSpecific, commandIndex, op }
  at(commandIndex: number, op: string | undefined): CommandError;
}

// ---- apply.ts ----
interface ApplyOptions { catalog: NodeCatalog; idGenerator?: IdGenerator; clock?: Clock }
function applyCommands(doc: ContextDocument, commands: readonly Command[], options: ApplyOptions): BatchResult;
function applyCommand(doc: ContextDocument, command: Command, options: ApplyOptions): ApplyResult;

// ---- editor.ts ----
interface ContextEditorOptions extends ApplyOptions { historyLimit?: number /* default 200 */ }
interface HistoryEntry { readonly commands: readonly Command[]; readonly inverse: readonly Command[] }
type EditorChangeKind = "apply" | "undo" | "redo" | "reset";
interface EditorChange { kind: EditorChangeKind; doc: ContextDocument; result?: Extract<BatchResult, { ok: true }> }
interface ContextEditor {
  readonly doc: ContextDocument;
  readonly diagnostics: readonly Diagnostic[];     // validateContext(doc)
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoStack: readonly HistoryEntry[];     // oldest first
  readonly redoStack: readonly HistoryEntry[];     // next redo last
  apply(command: Command): ApplyResult;
  applyBatch(commands: readonly Command[]): BatchResult;
  undo(): BatchResult | undefined;                 // undefined = nothing to undo
  redo(): BatchResult | undefined;
  reset(doc: ContextDocument): void;               // replace doc, clear history, notify "reset"
  clearHistory(): void;
  subscribe(listener: (change: EditorChange) => void): () => void;
}
function createContextEditor(doc: ContextDocument, options: ContextEditorOptions): ContextEditor;
```

Untyped JSON (REST bodies) is passed with a cast (`body.commands as Command[]`); every
payload is validated at run time.

### 3.1 Behaviour that the spec leaves open (decided here, DECISIONS #42–#55)

- **Default options:** `idGenerator = createIdGenerator()`, `clock = () => new Date()`.
- **Generated ids** use the kind prefixes (`ty`, `gv`, `flow`, `var`, `n`, `e`). If the
  generator returns an id already used in its uniqueness domain, it is called again (up to 100
  times, then `command.duplicate_id`). So `createSequentialIdGenerator()` works on documents
  that already contain `n_1`.
- **`resolved`:** one entry per input command, in order; generated ids filled in under the
  payload's id key (`id`, `inputNodeId`, `outputNodeId`, `typeIds`); shorthand types (payload
  `type` fields, `fields[].type`, `cfg.type()` config values) replaced by IR. Everything else is
  copied as given, including `restore` (absent stays absent). Re-applying `resolved` to the
  starting document with **any** id generator yields a deep-equal document.
- **`inverse`:** a flat batch; inverses of later commands come first. Every command has
  `restore: true`. Empty when `changed` is false. `flow.setViewport` contributes nothing.
- **`index` on creating commands (extension, DECISIONS #46):** `type.defineStruct`,
  `type.defineEnum`, `type.moveScope`, `global.create`, `flow.create`,
  `flow.variable.create`, `node.add` and `edge.connect` accept an optional integer `index`
  (position in the target list; default end; clamped). Inverses use it so that undo restores
  list order exactly (e.g. the inverse of disconnecting the 2nd of 4 edges is
  `edge.connect { …, index: 1, restore: true }`). Inverses always carry `index` for restored
  items.
- **`flow.duplicate`** appends the copy at the end of `flows`.
- **Shorthand resolves strictly in the target scope:** a local type name used at global level is
  `type.unknown`; `visibility.local_type_in_global` comes from IR ids of local types (or from
  `type.moveScope`).
- **`node.clearValue`** without a stored value is a no-op even for a port name the node does
  not have.
- **`edge.type_mismatch` hint:** `Use list.get to pick one item.` when the source is a list
  whose item fits the target (checked first), else `Use convert.toText…` when the target is
  text.
- **`changed: false`** results return the *input* document object (`result.doc === doc`) and
  `inverse: []`; `resolved`/`created` are still filled.
- **Undo/redo:** `undo()` applies the top entry's `inverse`; on success the entry moves to the
  redo stack. `redo()` applies the entry's `commands` with `restore: true` added to each; on
  success its `inverse` is replaced by the redo result's `inverse` and it moves back to the
  undo stack. A failed undo/redo returns `{ ok: false }` and leaves both stacks unchanged.
  `apply`/`applyBatch` with `changed: true` push an entry (dropping the oldest beyond
  `historyLimit`) and clear the redo stack, except a batch made only of `flow.setViewport`
  commands, which records nothing and keeps the redo stack. A failed or unchanged apply
  records nothing and keeps the redo stack.
- **Listeners** run synchronously after `doc` changed (`apply`/`undo`/`redo` with
  `changed: true`, and `reset`). A listener that throws does not break the editor (the error
  is swallowed — log it yourself).
- **Name error codes:** type names use the types.md codes `type.invalid_name`,
  `type.reserved_name`, `type.duplicate_name`; every other name (fields, flow inputs/outputs,
  globals, variables, flows, enum member values) uses `command.invalid_name`,
  `command.reserved_name`, `command.duplicate_name`. Field-like names: regex
  `^[A-Za-z_][A-Za-z0-9_]*$`, ≤ 64 chars, reserved `__proto__`, `constructor`, `prototype`.
  Context name: 1–120 chars trimmed non-empty (`command.invalid_payload`). Flow name: 1–80
  chars, no control chars, trimmed non-empty (`command.invalid_name`). Enum member label:
  non-empty trimmed, ≤ 120 (`command.invalid_payload`). Descriptions: ≤ 2000 chars, `null`
  clears (`command.invalid_payload` when longer).
- **`command.unknown_ref` `details`:** `{ kind, id }` where kind ∈ `flow`, `type`, `field`,
  `member`, `global`, `variable`, `node`, `edge`, `input`, `output`.
- **Value rejection messages:** `value.invalid` / `media.*` / `value.generic_unbound` errors
  use the first value diagnostic's message (paths as validation uses them:
  `nodes.<nodeId>.values.<port>`, `globals.<name>`, `variables.<name>`, `inputs.<name>`,
  `<Type>.<field>`); `details.diagnostics` holds all of them. Defaults of struct fields and
  flow inputs reject with `type.invalid_default`
  (`Default value of {where} is not valid: {detail}.`); flow-variable defaults and global
  values with `value.invalid`.
- **Shorthand errors** (`type.syntax`, `type.unknown`, `type.ambiguous`,
  `type.var_not_allowed`, `type.invalid_constraint`) reject with the parser's code/message.
  An IR type naming an unknown id → `type.unknown_id`. IR shape problems →
  `command.invalid_payload`.
- **Index clamping:** `index` in `*.add` is clamped to `[0, n]`, in `*.reorder` to
  `[0, n-1]`; it must be an integer (`command.invalid_payload` otherwise).
- **`node.move`** positions are rounded to 2 decimals (`Math.round(x * 100) / 100`).
- **`node.setTitle`** with `null`/`""` removes the `title` key.
- **`edge.connect` cycle message** uses node labels (`Title (id)` / definition title + id) and
  the path `A → B → A`.
- **`type.moveScope`** keeps the type's id and position is appended at the end of the target
  list.
- **Implicit cleanup** after every command: edges attached to ports that no longer exist and
  constants of ports that no longer exist are removed (both restored by the inverse); nodes
  with **no** resolved ports because of an unknown type / invalid config / failing
  `resolvePorts` keep their edges and constants (DECISIONS #34). `NodeInstance.typeBindings`
  is recomputed for every node with generic ports (key removed when empty).

## 4. Tasks

### Lead developer
1. Contracts (done) and this file.
2. Implement `internal/`: payload schema per op, handlers per group, normalization (ports,
   cleanup, bindings), value rewriting for renames, inverse generation, batch runner, editor.
3. Internal tests in `packages/authoring/test/internal/`.
4. Run the tester's suite, fix implementation bugs; log decisions.

### Tester
Write `packages/authoring/test/*.test.ts` against the public API only:
`commands-context.test.ts`, `commands-types.test.ts`, `commands-globals.test.ts`,
`commands-flows.test.ts`, `commands-signature.test.ts`, `commands-variables.test.ts`,
`commands-nodes.test.ts`, `commands-edges.test.ts`, `batch.test.ts`, `undo.test.ts`,
`restore.test.ts`, `editor.test.ts`. Fixtures in `packages/authoring/test/fixtures/`.

## 5. Acceptance criteria

### 5.1 Common (commands.md §1)
- Unknown op → `command.unknown_op` (message names the op). Non-object command / missing
  `op` → `command.invalid_payload`.
- Unknown payload field, wrong JSON type, missing required field, non-boolean `restore` →
  `command.invalid_payload`, message `Command {op}: {field} {problem}.`
- Batch atomicity: a rejection at index k returns `error.commandIndex === k`,
  `error.details.commandIndex === k`, `error.details.op`; the input document is unchanged and
  (editor) `editor.doc` is unchanged, no history recorded.
- Later commands in a batch see earlier ones (create a flow then add nodes to it).
- No-op batch (`node.move` to the same position; `edge.connect` of an existing edge;
  rename to the same name; `node.clearValue` without value; `type.moveScope` to the same
  scope) → `changed: false`, same revision, `doc` is the input object, no undo entry.
- Changed batch → `revision + 1` exactly once per batch, `updatedAt = clock().toISOString()`.
- `diagnostics` equals `validateContext(result.doc, catalog)`.
- Supplied ids: wrong prefix/pattern → `command.invalid_id`; already used in the domain →
  `command.duplicate_id`. Domains: flow ids, type ids (global + all flows' local), global ids
  within the context; node, edge, variable ids within their flow (the same node id in two
  flows is fine).
- Generated ids come from the injected generator; `resolved` contains them.
- Shorthand in payloads stored as IR; `resolved` holds IR.
- Documents are never mutated (deep-freeze inputs in tests).
- **Undo invariant** (run generically over every accepted batch in the suite):
  `applyCommands(applyCommands(D, B).doc, inverse).doc` deep-equals `D` except `revision` and
  `updatedAt`; all inverse commands have `restore: true`.
- **Redo invariant:** applying `resolved` to `D` again gives a deep-equal document (except
  revision/updatedAt).

### 5.2 Context
- `context.rename` (trimmed non-empty, ≤ 120), `context.setDescription` (`null` clears).

### 5.3 Types (§3)
- defineStruct/defineEnum in global and flow scopes; created `typeId`; generated `ty_…`.
- Name rules: invalid / reserved (`Text`, `List`, …) / duplicate case-insensitive in the same
  scope (`type.*_name`); a local type may shadow a global one (warning `type.shadows_global`
  in diagnostics, not a rejection).
- Field rules: invalid/reserved/duplicate field names; unknown field types (`type.unknown`);
  global struct using a local type → `visibility.local_type_in_global`; self/indirect
  recursion → `type.recursive`; bad default → `type.invalid_default`; bad constraint in
  shorthand → `type.invalid_constraint`.
- Enum: members as strings or objects; duplicates case-insensitive → `type.duplicate_member`;
  zero members accepted with warning `type.enum_empty`.
- `type.delete` rejected while used (fields, signatures, variables, globals, node configs,
  `briar.constant` type configs) with `type.in_use`, `details.usages`; pack type ids →
  `type.read_only`. Inverse re-defines the type with the same id at the same position.
- `type.moveScope` per §3 (global→flow F rejected when used outside F; flow→global rejected
  when it uses local types, `details.localDependencies`; flow→flow rejected
  (`command.invalid_payload`, message says to move via global); name conflict in target;
  same scope no-op).
- Field ops: add (index, struct.make/break gain ports), remove (ports/edges/constants
  removed; restored by undo), rename (ports, edges, constants keys, and keys inside stored
  values of the struct: node constants, field/input defaults, variable defaults, global
  values), setType (hard: visibility, recursion; soft: edges/values → diagnostics), reorder
  (clamped), setDescription, setDefault (hard `type.invalid_default`), clearDefault.
  Unknown field → `command.unknown_ref`; enum target → `type.not_struct`.
- Enum ops: addMember, removeMember (stored values become soft `node.invalid_value` etc.),
  renameMember (rewrites stored values typed as this enum), setMemberLabel; struct target →
  `type.not_enum`.

### 5.4 Globals (§4)
- create (name rules, visibility, readonly without value → `global.readonly_requires_value`,
  invalid value → `value.invalid`), rename, setType (soft value → `global.invalid_value`;
  get/set node ports follow), setAccess (readonly without value rejected; existing set nodes →
  soft `variable.write_to_readonly` diagnostic), setValue, clearValue (rejected on readonly),
  setDescription, delete (in use → `global.in_use`, `details.nodes`; `cascade: true` removes
  those nodes and their edges; undo restores everything).

### 5.5 Flows (§5)
- `flow.create`: input node at `{0,0}`, output node at `{640,0}`; created ids; name rules
  (unique case-insensitive, 1–80, no control chars).
- rename, setDescription, delete (inverse restores the full flow at its index).
- duplicate: default name `"{name} copy"`, then `"{name} copy 2"`, …; node/edge/variable ids
  kept; local types re-id'd (from `typeIds` or generator) and all references rewritten
  (field types, signature, variables, node configs, typeBindings); created `{ flowId, typeIds }`.
- setViewport: `zoom` in (0, 8]; changes revision; never in `inverse`; editor records no undo
  step for a viewport-only batch.

### 5.6 Signature (§5)
- input/output add (name rules among inputs / among outputs; `visibility.local_type_in_public_signature`;
  input default validated → `type.invalid_default`), remove (edges and constants of the
  port removed), rename (edges rewritten; Output-node constant keys rewritten), setType (hard
  visibility, soft edges → `edge.type_mismatch` diagnostic), reorder, setDescription,
  input setDefault / clearDefault. Ports of `briar.input` / `briar.output` follow.

### 5.7 Flow variables (§6)
- create (public + local type → `visibility.local_type_in_public_variable`; default
  `value.invalid`), rename, setType (soft default → `variable.invalid_default`), setAccess
  (→ public with local type rejected), setDefault, clearDefault, setDescription, delete
  (`variable.in_use` with `details.nodes`; cascade).

### 5.8 Nodes (§7)
- add: `briar.input`/`briar.output` → `node.builtin_singleton`; unknown type →
  `node.unknown_type` (message lists loaded packs); config validated (`config.invalid`,
  `config.unknown_ref`, `variable.write_to_readonly` for `briar.global.set` on readonly);
  `values` keys must be input ports (`node.unknown_port`); values validated (`value.invalid`,
  `value.generic_unbound` on an unbound generic port). Config `cfg.type()` accepts shorthand.
- remove (edges removed; builtins → `node.builtin_protected`; inverse = node.add + edge.connect
  with same ids), move (finite numbers, rounding), setTitle (≤ 80; null/"" clears), setValue
  (input port only; allowed on connected ports; hard validation), clearValue (no-op if none),
  setConfig (same validation as add; builtins → `node.builtin_protected`; vanished ports'
  edges/constants removed; restored by undo).

### 5.9 Edges (§8)
- connect: unknown node → `command.unknown_ref`; `edge.unknown_port`; `edge.wrong_direction`;
  `edge.self_loop`; `edge.cycle`; `edge.type_mismatch`; `edge.generic_conflict`; existing same
  edge → unchanged, `created.edgeId` = existing id; replacing an edge into an occupied input →
  `created.replacedEdgeId`, undo restores the old edge. Generic bindings stored in
  `typeBindings` after connect and removed after the last constraining edge is disconnected.
- disconnect by `edgeId` or by `to`; unknown → `command.unknown_ref`.

### 5.10 `restore: true` (§1.1a)
- Each check in the "reject → accepted" rows is accepted with `restore: true` and produces
  the listed diagnostic; each structural check in the last row still rejects with
  `restore: true`.
- The spec example (constant `-1` on `int{min:0}` field, delete, undo) round-trips.

### 5.11 Soft breakage (§1.3) and the §10 examples
- The §10 batch builds with no diagnostics (with a catalog containing `briar.struct.break`
  and `text.template` with std semantics). `type.field.setType style → int` keeps `e_3`
  without diagnostics; `flow.output.setType prompt → image` gives `edge.type_mismatch` on
  `e_4`. The rejection example returns the exact message.

## 6. Order of work
1. Contracts + this file (done) → tester starts.
2. Lead: common runner, context/flows/nodes/edges → types/globals/variables/signature →
   editor → restore → internal tests.
3. Lead runs the tester suite and fixes; tester files test bugs in `docs/tasks/bugs.md`.

## 7. Notes for the tester
- Use `createSequentialIdGenerator()` and a fixed clock
  (`() => new Date("2026-01-01T00:00:00Z")`).
- Catalog: build a fixture pack in `test/fixtures/` with `defineNode`/`definePack` mirroring
  the std semantics you need (`briar.struct.make/break` with `resolvePorts` from
  `cfg.typeId({ kind: "struct" })`, `briar.variable.get/set`, `briar.global.get/set`
  (`cfg.global({ writable: true })` on set), `briar.constant` (`cfg.type()` config, input/output
  `value` of that type), `text.template` (dynamic generic inputs from `{placeholders}`),
  a generic node like `list.get`, plus a few static nodes). See
  `packages/core/test/internal/fixtures.ts` for a working example. Optionally add one
  integration test with `stdPack` from `@briarflow/nodes-std` (owned by backend, may change).
- Start from `createContextDocument({ name, id, idGenerator, clock })` and build state with
  commands; deep-freeze documents (`structuredClone` + recursive `Object.freeze`) before
  applying to prove immutability.
- Write the undo/redo invariants as a helper (`expectUndoRoundTrip(doc, batch)`) and call it in
  every accept test.
- Compare documents with `toEqual` after dropping `revision`/`updatedAt`.
- Messages: assert exact text only where commands.md/types.md give a full template; otherwise
  assert `code` and that the message contains the offending name.
