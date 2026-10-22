# Spec: Authoring commands

Status: v1, phase-2 behaviour folded in (DECISIONS #42–#55). Owner: ux-designer.
Implemented in `@briarflow/authoring` (phase 2). Read with `types.md` (identifiers, type
codes) and `variables.md`.

## Deviations from ARCHITECTURE.md

1. **Undo is command-based, not snapshot-based.** ARCH §5 says "Undo/redo: stack of previous
   documents". Every successful `apply` also returns `inverse: Command[]`; `undo()` applies
   the inverse batch, `redo()` re-applies the resolved original batch. Reason: the editor
   (`@briarflow/editor`) must send undo to the server as ordinary commands; a snapshot cannot
   be synced. Structural sharing is still used for the document itself.
2. **Extra commands** (small, needed for a complete UI): `type.field.setDescription`,
   `type.field.setDefault`, `type.field.clearDefault`, `type.enum.setMemberLabel`,
   `global.setDescription`, `global.clearValue`, `flow.input.setDescription`,
   `flow.input.setDefault`, `flow.input.clearDefault`, `flow.output.setDescription`,
   `flow.variable.setDescription`, `flow.variable.clearDefault`.
3. **Delete of referenced things.** `type.delete` is rejected while the type is used.
   `global.delete` / `flow.variable.delete` are rejected while get/set nodes use them, unless
   `cascade: true` (then those nodes and their edges are removed). Reason: never leave
   dangling ids; ARCH only allows implicit deletion of edges.
4. **Types in payloads** may be given as IR (`TypeRef`) or as a shorthand string; shorthand is
   resolved in the scope of the command's target and stored as IR.
5. **Constant values on connected ports are kept** (ignored while connected), so
   disconnecting restores them. ARCH §4.6 describes values "for unconnected input ports";
   this only clarifies that connecting does not erase them.
6. **Optional `index` on creating commands** (DECISIONS #46). `type.defineStruct`,
   `type.defineEnum`, `type.moveScope`, `global.create`, `flow.create`,
   `flow.variable.create`, `node.add` and `edge.connect` accept an optional integer `index`
   (position in the target list; default end; clamped to `[0, n]`). Inverses use it so undo
   restores list order exactly. Reason: document lists are ordered and the undo invariant
   (§1.1) requires deep equality.

---

## 1. Common rules

```ts
type Command = { op: string } & Record<string, unknown>;

type ApplyResult =
  | { ok: true; doc: ContextDocument; created: CreatedIds; inverse: Command[]; resolved: Command[]; diagnostics: Diagnostic[]; changed: boolean }
  | { ok: false; error: CommandError };

interface CommandError {           // class CommandError extends BriarError
  code: string;                    // e.g. "command.unknown_ref"
  message: string;
  commandIndex: number;            // index in the batch (0 for a single command)
  op: string;                      // op of the failing command ("" if it had none)
  details: { commandIndex: number; op: string } & Record<string, unknown>;
}

// applyBatch result (public name: applyCommands): created is per command
type BatchResult =
  | { ok: true; doc; created: CreatedIds[]; inverse: Command[]; resolved: Command[]; diagnostics; changed: boolean }
  | { ok: false; error: CommandError };
```

- **Public API** (DECISIONS #42). `applyCommands(doc, commands, options)` → `BatchResult` and
  `applyCommand(doc, command, options)` → `ApplyResult` are pure (for servers);
  `createContextEditor(doc, options)` adds history and listeners (§1.1). "applyBatch" in this
  spec means `applyCommands`.
- **Error details** (DECISIONS #42). `CommandError.details` is always an object holding
  `commandIndex` and `op` plus the code-specific data listed with each code (e.g.
  `usages`, `diagnostics`). REST returns it unchanged. `command.unknown_ref` details are
  `{ kind, id }` with kind ∈ `flow`, `type`, `field`, `member`, `global`, `variable`, `node`,
  `edge`, `input`, `output`.
- **Atomicity.** `applyBatch` applies commands in order on a working copy; the first
  rejection discards everything and returns that error with `commandIndex`.
- **No-op batches.** If the final document is deep-equal to the starting one, the result is
  `ok: true, changed: false`, `revision` is not incremented and no undo step is recorded.
  `result.doc` is then the *input* document object and `inverse` is `[]`; `created` and
  `resolved` are still filled.
- **Revision.** Each changed batch: `revision + 1`, `updatedAt = clock()`.
- **Diagnostics** in the result are the full `validateContext` output after the batch
  (not only new ones). The editor diffs them if needed.
- **Ids.** Every creating command takes an optional id (`id`, or named ones like
  `inputNodeId`). Supplied ids must match the id regex for their kind (`types.md` §1) and be
  unused in their uniqueness domain, else `command.invalid_id` / `command.duplicate_id`.
  Missing ids come from the injected `idGenerator(prefix)` (prefixes `ty`, `gv`, `flow`,
  `var`, `n`, `e`); if it returns an id already used in its domain it is called again, up to
  100 times, then `command.duplicate_id` (DECISIONS #44), so sequential generators work on
  existing documents. **Uniqueness domains:** context
  ids globally (store); flow ids globally (checked by the store on save, by authoring within
  the document); type ids (local and global), global ids within the context; node, edge and
  variable ids within their flow.
- **Resolved commands** (DECISIONS #43). `result.resolved` has one entry per input command,
  in order, with generated ids filled in under the payload's id key (`id`, `inputNodeId`,
  `outputNodeId`; for `flow.duplicate` also `name` and `typeIds`) and shorthand types
  (payload `type`, `fields[].type`, type-valued config fields such as `briar.constant`'s
  `type`) replaced by IR. Everything else is copied as given, including `restore` (absent
  stays absent). Re-applying `resolved` to the starting document with any id generator
  yields a deep-equal document, so redo and server sync produce identical ids.
- **Shorthand types resolve strictly in the target scope** (DECISIONS #50). At global level
  (global types, globals) only global and pack types are visible, so a flow-local type name
  there is `type.unknown`, not a visibility error. `visibility.local_type_in_global` comes
  from IR that names a local type id (or from `type.moveScope`). Shorthand errors
  (`type.syntax`, `type.unknown`, `type.ambiguous`, `type.var_not_allowed`,
  `type.invalid_constraint`) reject with the parser's code and message; IR naming an unknown
  id → `type.unknown_id`; malformed IR → `command.invalid_payload`.
- **`index`** (in `*.add`, `*.reorder` and the creating commands of Deviation 6) must be an
  integer (`command.invalid_payload` otherwise). It is clamped to `[0, n]` for inserts and to
  `[0, n-1]` for `*.reorder`.
- **Unknown fields** in a payload → `command.invalid_payload`. Wrong JSON types → same.
  `restore` (§1.1a) is a common field accepted by every op; it must be a boolean.
- **Unknown op** → `command.unknown_op`.
- `flow.setViewport` changes the document and revision but is **not** recorded for undo.

### 1.1 Undo / redo

- `undo()` applies the inverse of the last recorded batch as a new batch (revision goes up,
  it does not go back); on success the entry moves to the redo stack. `redo()` re-applies the
  entry's `resolved` commands with `restore: true` added to each; on success the entry's
  inverse is replaced by the redo result's inverse and it moves back to the undo stack.
  `undo()`/`redo()` return `undefined` when their stack is empty; a failed undo/redo returns
  `{ ok: false, error }` and leaves both stacks unchanged (DECISIONS #42, #54).
- A changed user batch pushes an entry (oldest dropped beyond `historyLimit`) and clears the
  redo stack. A failed or unchanged batch records nothing and keeps the redo stack. A batch
  made **only** of `flow.setViewport` commands is not recorded and keeps the redo stack.
- `inverse` is one flat batch; inverses of later commands come first. Inverse commands of
  restored list items always carry `index` (Deviation 6), e.g. the inverse of disconnecting
  the 2nd of 4 edges is `edge.connect { …, index: 1, restore: true }`.
- Editor listeners run synchronously after `doc` changed (apply / undo / redo with
  `changed: true`, and `reset`). A listener that throws does not break the editor; the
  exception is swallowed (log it yourself).
- Invariant (tested generically): for every accepted batch `B` on doc `D`,
  `apply(apply(D, B).inverse)` equals `D` except `revision` and `updatedAt`.
- Inverses restore cascaded effects with the original ids: e.g. inverse of `node.remove` is
  `[node.add{…same id, config, values, title, position}, edge.connect{…same edge ids}…]`.
- Every command in an `inverse` batch carries `restore: true` (§1.1a), so undo can put back
  soft-broken state (a constant that no longer validates, an edge whose types no longer
  match). `resolved` keeps the caller's `restore` flag as given (absent = `false`).
- Undo stack depth: 200 batches (option `historyLimit`).
- **Known limitation (v1, DECISIONS #47).** Nodes whose node type is not in the catalog
  (`node.unknown_type`, e.g. their pack is not loaded) cannot be re-created by `node.add`,
  because `node.unknown_type` is a structural rejection even with `restore: true`. Undoing a
  `node.remove` or `flow.delete` that removed such a node therefore fails (stacks unchanged).
  Load the pack first.

### 1.1a `restore: true` (DECISIONS #11)

Any command may carry `"restore": true`. It means "put back state that existed before"; the
command then accepts values and connections that would normally be rejected, and the
problems show up as the usual **soft-breakage diagnostics** (§1.3) instead.

| Check | Normal | With `restore: true` |
|---|---|---|
| Value checks: `value.invalid`, `value.generic_unbound`, `media.*`, `type.invalid_default` (constants, defaults, global values) | reject | accepted → diagnostic `node.invalid_value` / `type.invalid_default` / `global.invalid_value` / `variable.invalid_default` |
| Type checks: `edge.type_mismatch`, `edge.generic_conflict` | reject | accepted → diagnostic `edge.type_mismatch` / `node.generic_conflict` |
| Visibility: `visibility.local_type_in_global`, `visibility.local_type_in_public_signature`, `visibility.local_type_in_public_variable` | reject | accepted → diagnostic with the same code |
| Access: `variable.write_to_readonly` (a `briar.global.set` on a readonly global) | reject | accepted → diagnostic `variable.write_to_readonly` |
| Structural: payload shape (`command.invalid_payload`), unknown op/refs (`command.unknown_op`, `command.unknown_ref`, `node.unknown_type`, `config.unknown_ref`), ids (`command.invalid_id`, `command.duplicate_id`), names (`command.invalid_name`, `command.duplicate_name`, `command.reserved_name`, `type.*_name`), `type.recursive`, `type.invalid_constraint`, `type.duplicate_member`, `type.in_use`, `global.in_use`, `variable.in_use`, `global.readonly_requires_value`, `config.invalid`, `node.unknown_port`, `edge.unknown_port`, `edge.wrong_direction`, `edge.self_loop`, `edge.cycle`, `node.builtin_*` | reject | **still reject** |

Rules:
- `restore` changes only *which* checks reject; the effect of the command is identical.
- It is not a privilege: any caller (editor, REST, scripts) may send it. A document may
  already hold soft-broken state, so allowing a client to restore such state adds nothing new.
- The editor never sets it on user actions; only inverse batches (undo) and the redo of an
  undo carry it.
- Inverse of a command sent with `restore: true` also carries `restore: true` (every inverse
  does).

Example — the user narrows `Character.age` to `int{min:0}` after a constant `-1` was set
(soft breakage), then deletes the constant and presses undo. The inverse is
`{ "op": "node.setValue", "flowId": "flow_p", "nodeId": "n_make", "port": "age", "value": -1, "restore": true }`:
accepted, and the diagnostic `node.invalid_value` comes back. Without `restore` the same
command rejects with `value.invalid`.

### 1.2 Generic error codes

| Code | Message template |
|---|---|
| `command.unknown_op` | `Unknown command "{op}". See docs/specs/commands.md for the list.` |
| `command.invalid_payload` | `Command {op}: {field} {problem}.` |
| `command.unknown_ref` | `Command {op}: {kind} "{id}" does not exist{where}.` |
| `command.invalid_id` | `Command {op}: "{id}" is not a valid {kind} id. Expected {pattern}.` |
| `command.duplicate_id` | `Command {op}: id "{id}" is already used by a {kind}.` |
| `command.invalid_name` | `"{name}" is not a valid {kind} name. {rule}` |
| `command.duplicate_name` | `A {kind} named "{existing}" already exists in {scope}. Names must be unique (ignoring case).` |
| `command.reserved_name` | `"{name}" is reserved. Choose another {kind} name.` |
| `value.invalid` | from `types.md` §7 |

Plus the type codes in `types.md` §11 (`type.*`, `visibility.*`, `edge.*`).

**Name codes** (DECISIONS #45). Two families, chosen by *what* is named:

| Named thing | Codes |
|---|---|
| Types (structs, enums) | `type.invalid_name`, `type.reserved_name`, `type.duplicate_name` (types.md §11 templates) |
| Everything else: struct fields, flow inputs/outputs, globals, flow variables, flows, enum member values | `command.invalid_name`, `command.reserved_name`, `command.duplicate_name` |

Exceptions: duplicate enum members → `type.duplicate_member`; an invalid member value →
`command.invalid_name`. Field-like names (fields, inputs, outputs, globals, variables) match
`^[A-Za-z_][A-Za-z0-9_]*$`, ≤ 64 chars; reserved: `__proto__`, `constructor`, `prototype`.
Flow names: 1–80 chars, no control chars, trimmed non-empty (`command.invalid_name`).
Context name problems (1–120 chars, trimmed non-empty), enum member labels (non-empty
trimmed, ≤ 120) and descriptions (≤ 2000, `null` clears) are `command.invalid_payload`.

**Value rejections.** `value.invalid` / `media.*` / `value.generic_unbound` rejections use
the first value diagnostic's message (paths as validation uses them:
`nodes.<nodeId>.values.<port>`, `globals.<name>`, `variables.<name>`, `inputs.<name>`,
`<Type>.<field>`); `details.diagnostics` holds all of them. Defaults of struct fields and flow
inputs reject with `type.invalid_default`; flow-variable defaults and global values with
`value.invalid`.

### 1.3 Soft breakage

These never reject: changing a type (field/input/output/variable/global) so that existing
edges, constants, defaults or values no longer fit. The things stay and validation reports:

| Code | Severity | When |
|---|---|---|
| `edge.type_mismatch` | error | an existing edge's ends are no longer assignable |
| `node.invalid_value` | error | a stored constant no longer validates |
| `type.invalid_default` | error | a field / input default no longer validates |
| `global.invalid_value` | error | a global value no longer validates |
| `variable.invalid_default` | error | a flow variable default no longer validates |
| `node.generic_conflict` | error | generic re-resolution failed |

Implicit deletions (always reported in `inverse`, never as diagnostics): edges attached to a
removed node or a port that no longer exists, and constants stored for a port that no longer
exists.

**Implicit cleanup** (DECISIONS #48) runs after every command on the flows it touches: edges
and constants of ports that existed before the command and are gone after it are removed.
Their restoring commands are appended *after* the command's own inverse (the ports must
exist again first). Nodes that have no ports because of an unknown type, invalid config, a
failing `resolvePorts` or `variable.write_to_readonly` keep their edges and constants (§9).
`NodeInstance.typeBindings` is recomputed for every node with generic ports (key removed when
empty).

### 1.4 Ports of config-dependent nodes

Some nodes' ports are derived (`resolvePorts`, see node-api.md). After **every** batch,
authoring re-resolves ports of affected nodes:

| Node type | Ports derived from | Port names |
|---|---|---|
| `briar.input` | `flow.inputs` | outputs = input field names |
| `briar.output` | `flow.outputs` | inputs = output field names |
| `briar.variable.get` / `.set` | flow variable type | `value` |
| `briar.global.get` / `.set` | global type | `value` |
| `briar.struct.make` | struct fields | inputs = field names, output `value` |
| `briar.struct.break` | struct fields | input `value`, outputs = field names |

Renames are followed generically (DECISIONS #49): after a rename, for every node whose
resolved ports lost `old` and gained `new` on the same side, authoring rewrites
`Edge.from.port` / `Edge.to.port` and `NodeInstance.values` keys. This covers
`briar.input`/`briar.output`, `struct.make`/`struct.break` and any custom node that derives
ports from the same data. Field and enum-member renames also rewrite stored values typed as
that struct/enum (node constants, field/input/variable defaults, global values). Removing
the field removes the port (and its edges/constants).

---

## 2. Context

| op | Payload | created | Rejections |
|---|---|---|---|
| `context.rename` | `{ name: string }` (1–120 chars, trimmed non-empty) | — | `command.invalid_payload` |
| `context.setDescription` | `{ description: string \| null }` (≤ 2000) | — | — |

## 3. Types

`scope` = `{ "kind": "global" } | { "kind": "flow", "flowId": "flow_…" }`.

### `type.defineStruct`
```json
{ "op": "type.defineStruct", "scope": { "kind": "global" }, "name": "Character", "id": "ty_char",
  "description": "A story character", "index": 0,
  "fields": [ { "name": "name", "type": "text" }, { "name": "age", "type": "int", "default": 30 } ] }
```
- created: `{ typeId }`. `fields` optional (default `[]`). `index` optional: position in the
  scope's type list (default end).
- Rejects: invalid/duplicate/reserved name; invalid field names or duplicates; unknown field
  types; `visibility.local_type_in_global` (global struct with local field types);
  `type.recursive`; `type.invalid_default`; `type.invalid_constraint`.
- Inverse: `type.delete { typeId }`.

### `type.defineEnum`
```json
{ "op": "type.defineEnum", "scope": { "kind": "flow", "flowId": "flow_p" }, "name": "ArtStyle",
  "members": ["anime", { "value": "pixel", "label": "Pixel art" }] }
```
- created: `{ typeId }`. Optional `index` as for `defineStruct`. Members as strings or `{ value, label? }`; duplicates (case-insensitive) →
  `type.duplicate_member`. Zero members allowed (warning `type.enum_empty`).

### `type.rename` `{ typeId, name }`
Rejects: invalid/duplicate/reserved name in its scope. Effects: none on references (ids).

### `type.setDescription` `{ typeId, description: string | null }`

### `type.delete` `{ typeId }`
Rejects `type.in_use` when anything references the id: fields of other types, flow
signatures, variables, globals, node configs (`struct.make/break`, `briar.constant`),
`typeBindings`. `details.usages: { kind, flowId?, id, name }[]`. Message:
`Type "{name}" is used in {n} places ({first three}). Remove those uses first.` Pack types
cannot be deleted (`type.read_only`).

### `type.moveScope` `{ typeId, to: scope, index? }`
- The type keeps its id; it is inserted at `index` in the target list (default end).
- global → flow F: rejects `type.in_use` if used outside F (other flows, global types,
  globals, F's public signature or public variables — the latter with
  `visibility.local_type_in_public_signature`).
- flow → global: rejects `visibility.local_type_in_global` if its fields use local types
  (`details.localDependencies` lists them; move those first).
- flow F → flow G: allowed only via global (two commands).
- Name conflict in target scope → `type.duplicate_name` (type names use the `type.*_name`
  codes, §1.2). Same scope → no-op.

### Fields
| op | Payload | Notes / rejections |
|---|---|---|
| `type.field.add` | `{ typeId, name, type, description?, default?, index? }` | `index` default = end; invalid name, duplicate, visibility, recursion, invalid default. Existing values of this struct become invalid unless the field is optional or has a default → soft (`node.invalid_value`, …). Ports of `struct.make/break` gain the port. |
| `type.field.remove` | `{ typeId, field }` | Removes port on make/break nodes in all flows (edges/constants removed). Stored values keep the extra key → soft `node.invalid_value` (unknown field). |
| `type.field.rename` | `{ typeId, field, name }` | Rewrites ports/edges/constants keys on make/break nodes **and** renames the key inside every stored value of this struct (constants, defaults, global values). |
| `type.field.setType` | `{ typeId, field, type }` | Hard: visibility, recursion. Soft: everything else. |
| `type.field.reorder` | `{ typeId, field, index }` | `index` clamped to `[0, n-1]`. |
| `type.field.setDescription` | `{ typeId, field, description \| null }` | |
| `type.field.setDefault` | `{ typeId, field, value }` | hard `type.invalid_default` |
| `type.field.clearDefault` | `{ typeId, field }` | |

All reject `command.unknown_ref` for unknown `typeId`/`field` and `type.not_struct` for enums.

### Enum members
| op | Payload | Notes |
|---|---|---|
| `type.enum.addMember` | `{ typeId, value, label?, index? }` | duplicate → `type.duplicate_member` |
| `type.enum.removeMember` | `{ typeId, value }` | stored values using it → soft `node.invalid_value` etc. |
| `type.enum.renameMember` | `{ typeId, value, newValue }` | rewrites every stored value equal to the old member where the type path is this enum (constants, defaults, global values) |
| `type.enum.setMemberLabel` | `{ typeId, value, label \| null }` | |

All reject `type.not_enum` for structs.

## 4. Globals

| op | Payload | created | Rejections |
|---|---|---|---|
| `global.create` | `{ name, type, access: "readonly"\|"readwrite", value?, description?, id?, index? }` | `{ globalId }` | invalid/duplicate name; `visibility.local_type_in_global`; `global.readonly_requires_value`; `value.invalid` |
| `global.rename` | `{ globalId, name }` | | name rules |
| `global.setType` | `{ globalId, type }` | | visibility (hard); value → soft `global.invalid_value`; get/set node ports follow |
| `global.setAccess` | `{ globalId, access }` | | → readonly without value: `global.readonly_requires_value`. Existing set nodes → soft `variable.write_to_readonly` |
| `global.setValue` | `{ globalId, value }` | | `value.invalid` |
| `global.clearValue` | `{ globalId }` | | readonly → `global.readonly_requires_value` |
| `global.setDescription` | `{ globalId, description \| null }` | | |
| `global.delete` | `{ globalId, cascade?: boolean }` | | used by get/set nodes and `cascade` not true → `global.in_use` (`details.nodes: {flowId,nodeId}[]`) |

`global.readonly_requires_value`: `Readonly global "{name}" needs a value. Set a value or make it readwrite.`

## 5. Flows

### `flow.create`
```json
{ "op": "flow.create", "name": "Portrait", "id": "flow_p", "inputNodeId": "n_in", "outputNodeId": "n_out", "description": "…" }
```
- created: `{ flowId, inputNodeId, outputNodeId }`. Optional `index`: position in `flows`
  (default end).
- Creates an empty flow plus nodes `briar.input` at `{x:0,y:0}` and `briar.output` at
  `{x:640,y:0}` with no ports (empty signature).
- Rejects: name rules (flow names unique in context, case-insensitive, 1–80 chars, any
  characters except control chars, trimmed non-empty).

| op | Payload | Notes |
|---|---|---|
| `flow.rename` | `{ flowId, name }` | |
| `flow.setDescription` | `{ flowId, description \| null }` | |
| `flow.duplicate` | `{ flowId, name?, id?, typeIds?: Record<oldTypeId,newTypeId> }` | created `{ flowId, typeIds }`. The copy is appended at the end of `flows` (no `index`). Copies everything. Node, edge, variable ids are kept (they are flow-scoped); local type ids are remapped (from `typeIds` or the generator) and all references inside the copy rewritten. Default name: `"{name} copy"`, then `"{name} copy 2"`… |
| `flow.delete` | `{ flowId }` | Always allowed (flows are not referenced by other flows in v1). Inverse (DECISIONS #47): a full rebuild — `flow.create` (with `index`), local types defined empty then `type.field.add`, signature, variables, built-in node move/title/constants, `node.add`, `edge.connect`, `flow.setViewport`. Nodes of unknown types cannot be restored (§1.1). |
| `flow.setViewport` | `{ flowId, viewport: { x, y, zoom } }` | `zoom` in (0, 8]. Not undoable. |

### Signature
Inputs and outputs are `FieldDecl`s addressed by name.

| op | Payload | Notes |
|---|---|---|
| `flow.input.add` | `{ flowId, name, type, description?, default?, index? }` | Hard: name rules (unique among inputs), `visibility.local_type_in_public_signature`, `type.invalid_default`. Adds an output port on `briar.input`. |
| `flow.input.remove` | `{ flowId, name }` | Removes port and its edges. |
| `flow.input.rename` | `{ flowId, name, newName }` | Port follows; edges rewritten. |
| `flow.input.setType` | `{ flowId, name, type }` | Hard visibility; soft edges/defaults. |
| `flow.input.reorder` | `{ flowId, name, index }` | |
| `flow.input.setDescription` | `{ flowId, name, description \| null }` | |
| `flow.input.setDefault` / `clearDefault` | `{ flowId, name, value }` / `{ flowId, name }` | An input with a default is optional for callers. |
| `flow.output.add/remove/rename/setType/reorder/setDescription` | same shapes, on `outputs` | Ports appear on `briar.output` as inputs. Outputs have no defaults. |

## 6. Flow variables

| op | Payload | created | Notes |
|---|---|---|---|
| `flow.variable.create` | `{ flowId, name, type, access: "public"\|"private", default?, description?, id?, index? }` | `{ variableId }` | public + local type → `visibility.local_type_in_public_variable`; `value.invalid` on default |
| `flow.variable.rename` | `{ flowId, variableId, name }` | | nodes reference ids, nothing else changes |
| `flow.variable.setType` | `{ flowId, variableId, type }` | | hard visibility; soft default/edges |
| `flow.variable.setAccess` | `{ flowId, variableId, access }` | | → public with local type: hard reject |
| `flow.variable.setDefault` | `{ flowId, variableId, value }` | | `value.invalid` |
| `flow.variable.clearDefault` | `{ flowId, variableId }` | | |
| `flow.variable.setDescription` | `{ flowId, variableId, description \| null }` | | |
| `flow.variable.delete` | `{ flowId, variableId, cascade?: boolean }` | | used and not cascade → `variable.in_use` |

## 7. Nodes

### `node.add`
```json
{ "op": "node.add", "flowId": "flow_p", "id": "n_tpl", "type": "text.template",
  "position": { "x": 300, "y": 120 }, "title": "Prompt",
  "config": { "template": "Draw {name} in {style} style" },
  "values": { "name": "Aria" } }
```
- created: `{ nodeId }`. Optional `index`: position in the flow's `nodes` list (default end).
- Steps: reject the core built-ins `briar.input` / `briar.output` (`node.builtin_singleton`;
  they are not catalog entries, DECISIONS #23) → resolve `type` in the catalog → validate `config` against the definition's config
  fields → resolve ports → validate each `values` entry against its port (hard).
- Rejections:

| Code | When | Message |
|---|---|---|
| `node.unknown_type` | type not in catalog | `Unknown node type "{type}". Is its pack loaded? Known packs: {packs}.` |
| `node.builtin_singleton` | type is `briar.input` / `briar.output` | `Every flow has exactly one {type} node; it is created with the flow.` |
| `config.invalid` | config fails the definition's config fields (missing required, wrong kind, unknown key) | `{node type}: config.{key} {problem}.` |
| `config.unknown_ref` | config references a missing variable / global / type, or a type of the wrong kind (enum for struct.make) | `{node type}: {kind} "{id}" does not exist in this flow.` |
| `variable.write_to_readonly` | `briar.global.set` on a readonly global | `Global "{name}" is readonly. Make it readwrite to write it from a flow.` |
| `node.unknown_port` | `values` key is not an input port | `{node} has no input "{port}". Inputs: {list}.` |
| `value.invalid` / `value.generic_unbound` | constant fails | |

Config-dependent std nodes:

| type | config | example |
|---|---|---|
| `briar.variable.get` / `briar.variable.set` | `{ variableId }` | `{ "config": { "variableId": "var_count" } }` |
| `briar.global.get` / `briar.global.set` | `{ globalId }` | `{ "config": { "globalId": "gv_brand" } }` |
| `briar.struct.make` / `briar.struct.break` | `{ typeId }` (struct only) | `{ "config": { "typeId": "ty_char" } }` |
| `briar.constant` | `{ type }` (TypeRef or shorthand) | `{ "config": { "type": "list<text>" }, "values": { "value": ["a","b"] } }` |
| `text.template` | `{ template }` | see node-api.md |
| `list.make` | `{ count }` | |

### Other node commands

| op | Payload | Notes / rejections |
|---|---|---|
| `node.remove` | `{ flowId, nodeId }` | Removes attached edges. `briar.input`/`briar.output` → `node.builtin_protected` (`The flow's {Input\|Output} node cannot be removed. Edit the signature instead.`) |
| `node.move` | `{ flowId, nodeId, position: {x,y} }` | finite numbers; rounded to 2 decimals. One undo step each; the editor sends one move per drag end (multi-select drag = one batch). |
| `node.setTitle` | `{ flowId, nodeId, title: string \| null }` | ≤ 80 chars; `null` or `""` clears. |
| `node.setValue` | `{ flowId, nodeId, port, value }` | Port must be an input (`node.unknown_port`). Allowed on connected ports (kept, ignored while connected). Hard validation incl. constraints. |
| `node.clearValue` | `{ flowId, nodeId, port }` | No stored value → no-op (`changed: false`), even when `port` is not a port of the node. Unknown node → `command.unknown_ref`. |
| `node.setConfig` | `{ flowId, nodeId, config }` | Replaces the whole config; same validation as add; builtins → `node.builtin_protected`. Ports re-resolved: edges/constants of vanished ports removed; type changes on kept ports are soft. |

## 8. Edges

### `edge.connect`
```json
{ "op": "edge.connect", "flowId": "flow_p", "id": "e_1",
  "from": { "node": "n_in", "port": "character" }, "to": { "node": "n_make", "port": "value" } }
```
- created: `{ edgeId, replacedEdgeId? }`. Optional `index`: position in the flow's `edges`
  list (default end).
- If an edge with the same `from` and `to` exists → no change, `created.edgeId` = existing id.
- If `to` already has an incoming edge from elsewhere, that edge is replaced
  (`replacedEdgeId`; inverse restores it).
- Rejections:

| Code | Message |
|---|---|
| `command.unknown_ref` | unknown node |
| `edge.unknown_port` | `{node} has no {output\|input} "{port}". {Outputs\|Inputs}: {list}.` |
| `edge.wrong_direction` | `Edges go from an output to an input; "{port}" of {node} is an {input\|output}.` |
| `edge.self_loop` | `A node cannot be connected to itself.` |
| `edge.cycle` | `Connecting {from} to {to} would create a loop ({path}). Flows must not contain loops.` |
| `edge.type_mismatch` | see types.md |
| `edge.generic_conflict` | see types.md |

**Hard type checks** (DECISIONS #51) use the resolved ports directly, not `validateFlow`, in
this order: if the new edge would cause a `node.generic_conflict` on either end →
`edge.generic_conflict` (same message); else if the ends are not assignable →
`edge.type_mismatch` with the same message and hint as validation. **Hint order** (core and
authoring alike): source is a list whose item fits the target → `Use list.get to pick one
item.` (checked first); else target is `text` → `Use convert.toText to turn it into text.`;
else no hint. The cycle message uses node labels (`Title (id)`, or definition title + id) and
the path `A → B → A`.

Cycle check uses data edges only; cycles created by variable ordering are reported as the
diagnostic `flow.cycle` (see variables.md), not rejected.

### `edge.disconnect`
`{ flowId, edgeId }` or `{ flowId, to: { node, port } }` (removes the edge into that input).
Unknown → `command.unknown_ref`. Generic bindings of both ends are recomputed.

## 9. Validation diagnostics (non-type) produced after commands

| Code | Severity | Message |
|---|---|---|
| `input.unconnected` | error | `{node} needs a value for "{port}". Connect an edge or type a constant.` |
| `output.unconnected` | error | `Flow output "{name}" is not connected. Connect it or remove it from the signature.` |
| `node.unknown_type` | error | `{node} uses unknown node type "{type}". Load its pack or remove the node.` |
| `node.invalid_value` | error | `Constant {node}.{port}: {value message}` |
| `config.unknown_ref` | error | as in node.add (e.g. after a hand-edited document) |
| `flow.cycle` | error | `Flow "{flow}" has a loop: {path}.` |
| `flow.builtin_missing` | error | `Flow "{flow}" must have exactly one Input and one Output node.` |
| `flow.duplicate_name` | error | `A flow named "{existing}" already exists in context "{context}". Names must be unique (ignoring case).` (`path: { flowId }` of the later flow) |
| `global.readonly_requires_value` | error | as in §4 (a hand-edited readonly global without a value; `path: { globalId }`) |
| `node.ports_unresolved` | error | `{node} cannot work out its ports: {message}` — `{message}` from the `PortError` (its `code` in `details.code`) or the thrown error (node-api.md §5) |
| `flow.duplicate_id` | error | `Flow "{flow}" has two {nodes\|edges\|variables} with id "{id}". Ids must be unique within a flow.` (`path: { flowId, nodeId? \| edgeId? \| variableId? }`) |
| `edge.unknown_node` | error | `Edge {edgeId} points to node "{nodeId}", which does not exist in flow "{flow}". Remove the edge.` (`path: { flowId, edgeId }`) |
| `edge.unknown_port` | error | `Edge {edgeId}: {node} has no {output\|input} "{port}".` (`path: { flowId, edgeId, nodeId, port }`) |
| `edge.duplicate_input` | error | `{node} input "{port}" has {n} incoming edges ({edgeIds}). An input takes one edge; remove the extras.` (`path: { flowId, nodeId, port }`, `details: { edgeIds }`) |
| `variable.*` | | see variables.md |

The structural codes above (`flow.duplicate_id`, `flow.duplicate_name`, `edge.unknown_node`,
`edge.unknown_port`, `edge.duplicate_input`) cannot be produced by commands — commands reject
or replace instead — but `validateFlow` reports them for documents edited by hand or loaded
from a store. Nodes and edges involved in them are excluded from type and generic checks, so
one broken edge yields one diagnostic, not a cascade.

Further rules (DECISIONS #34, #35):

- **Nodes without ports.** A node of unknown type (`node.unknown_type`), a dynamic-port node
  with invalid config (`config.invalid` / `config.unknown_ref`), or one whose `resolvePorts` fails
  (`node.ports_unresolved`) has **no ports**. Its edges are kept and are **not** additionally
  reported as `edge.unknown_port`; the node-level diagnostic explains them.
- **Constants are validated only on unconnected ports.** A constant stored for a port that
  also has an incoming edge is ignored at run time, so it never yields `node.invalid_value`.
- `input.unconnected` is not raised when the port has a constant, a definition default, or an
  optional type (it then receives `null`), nor when its type still contains an unbound generic
  var (`node.generic_unbound` reports that, once per var — types.md §5.3).
- `output.unconnected` is satisfied by an incoming edge **or** a constant on the Output node's
  port.
- On `briar.variable.*` / `briar.global.*` nodes, the variable-order pass's
  `variable.unknown` / `variable.write_to_readonly` replace the config-level
  `config.unknown_ref` / `variable.write_to_readonly` for the same problem (one diagnostic,
  not two).
- `flow.cycle`: pure data cycles are reported by `validateFlow`; `computeVariableOrder`
  reports `flow.cycle` only for cycles that need its implicit variable edges (variables.md).

## 10. Examples

Build a small flow in one batch:
```json
[
  { "op": "type.defineEnum", "scope": {"kind":"global"}, "id": "ty_style", "name": "ArtStyle", "members": ["anime","pixel"] },
  { "op": "type.defineStruct", "scope": {"kind":"global"}, "id": "ty_char", "name": "Character",
    "fields": [ {"name":"name","type":"text"}, {"name":"style","type":"ArtStyle"} ] },
  { "op": "flow.create", "id": "flow_p", "name": "Portrait", "inputNodeId": "n_in", "outputNodeId": "n_out" },
  { "op": "flow.input.add", "flowId": "flow_p", "name": "character", "type": "Character" },
  { "op": "flow.output.add", "flowId": "flow_p", "name": "prompt", "type": "text" },
  { "op": "node.add", "flowId": "flow_p", "id": "n_brk", "type": "briar.struct.break", "position": {"x":200,"y":0}, "config": {"typeId":"ty_char"} },
  { "op": "node.add", "flowId": "flow_p", "id": "n_tpl", "type": "text.template", "position": {"x":420,"y":0}, "config": {"template":"Draw {name} in {style} style"} },
  { "op": "edge.connect", "flowId": "flow_p", "id": "e_1", "from": {"node":"n_in","port":"character"}, "to": {"node":"n_brk","port":"value"} },
  { "op": "edge.connect", "flowId": "flow_p", "id": "e_2", "from": {"node":"n_brk","port":"name"}, "to": {"node":"n_tpl","port":"name"} },
  { "op": "edge.connect", "flowId": "flow_p", "id": "e_3", "from": {"node":"n_brk","port":"style"}, "to": {"node":"n_tpl","port":"style"} },
  { "op": "edge.connect", "flowId": "flow_p", "id": "e_4", "from": {"node":"n_tpl","port":"text"}, "to": {"node":"n_out","port":"prompt"} }
]
```
Result: `created[2] = { flowId: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out" }`,
no diagnostics.

Soft breakage: `{ "op": "type.field.setType", "typeId": "ty_char", "field": "style", "type": "int" }`
→ ok; `n_brk.style` port becomes `int`; edge `e_3` stays (the template port is generic, so it
re-binds to `int`) — no diagnostic. Changing `flow.output.setType prompt → image` instead gives
`edge.type_mismatch` on `e_4`.

Rejection: `{ "op": "flow.input.add", "flowId":"flow_p", "name":"Character", "type":"text" }` →
`{ code: "command.duplicate_name", commandIndex: 0, message: "A flow input named \"character\" already exists in flow \"Portrait\". Names must be unique (ignoring case)." }`.
