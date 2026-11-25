# Spec: Type system

Status: v2 (2026-11-25). Owner: ux-designer. Implemented in `@briarflow/core`.

This spec makes ARCHITECTURE §4.1–4.5 precise: the types, shorthand grammar, identifiers,
scopes, assignability, generics, constraints, values, JSON Schema mapping, diagnostics.

**The model in one paragraph.** There are five primitives: `int`, `float`, `bool`, `string`,
`binary`. Everything else is a **struct** or an **enum** built from them. Text, media, JSON,
secrets and errors are **built-in structs** (`Text`, `Image`, `Json`…), in every scope. A
struct's fields are either **instance fields** (each value has its own) or **static fields**
(the type fixes the value). A struct may **extend** another: it inherits every field and may
only give static fields other values or add new static fields. Limits of text and media are
static fields, so a type with limits is a struct that extends a built-in:
`ShortText extends Text { maxLength = 80 }`. Unlimited text is a plain `string`.

## Deviations from ARCHITECTURE.md

1. **Optional struct fields may be omitted in values.** A value may omit a field whose type is
   `optional` (normalized to `null`) or that has a `default` (normalized to the default).
   `normalizeValue()` produces the canonical form with every instance field present.
2. **Unqualified pack type names.** Pack types are always addressable by their qualified id
   (`openai.ChatMessage`); the short name also resolves if exactly one loaded pack exports it
   and no local, global or built-in type has that name.
3. **Built-in types** (§1.2) are a scope level of their own, between global and pack types.

---

## 1. Types and identifiers

### 1.1 Primitives

| Primitive | JSON value | Notes |
|---|---|---|
| `int` | safe integer | constraints `min`, `max` |
| `float` | finite number | constraints `min`, `max` |
| `bool` | `true` / `false` | |
| `string` | string | no limits; for text with limits use `Text` (§1.2) |
| `binary` | `{ mediaId }` | bytes, held as the id of a media registry entry (§8). The bytes never travel in JSON |

There is no `char` or `byte`: `string` and `binary` cover them. A type is a primitive, a named
type (struct or enum), `list<T>` or `T?` (ARCH §4.1 IR).

### 1.2 Built-in structs

Always in scope, under ids `briar.<Name>`; their short names resolve without a pack
(`Image` = `briar.Image`). Static fields are in *italics*; their built-in value follows `=`.

| Type | Instance fields | Static fields |
|---|---|---|
| `Text` | `value: string` | *`minLength: int = 0`*, *`maxLength: int? = none`*, *`pattern: string? = none`* (ECMAScript regex, `u` flag, whole string), *`multiline: bool = false`* (editor hint) |
| `Image` | `data: binary`, `mime: string`, `name: string?`, `size: int?` (bytes), `width: int?`, `height: int?` | *`formats: list<string> = []`* (empty = any of its kind), *`maxBytes: int?`*, *`minWidth`*, *`maxWidth`*, *`minHeight`*, *`maxHeight: int?`* |
| `Video` | as Image, plus `duration: float?` (seconds), `fps: float?` | *`formats`*, *`maxBytes`*, *`maxDuration: float?`* |
| `Audio` | `data`, `mime`, `name`, `size`, `duration: float?` | *`formats`*, *`maxBytes`*, *`maxDuration`* |
| `Model3D`, `File` | `data`, `mime`, `name`, `size` | *`formats`*, *`maxBytes`* |
| `Json` | `text: string` (a JSON document) | — |
| `Secret` | `name: string` (a vault secret's name, secrets.md) | *`kind: SecretKind? = none`* (which secrets a picker offers) |
| `ApiKey` extends `Secret` | — | *`kind = apiKey`* |
| `Error` | `code: string`, `message: string`, `node: string?`, `nodeId: string?`, `details: Json?` | — |

`SecretKind` is a built-in enum: `apiKey`, `text`, `number`, `json`.

Media kinds and their mime types: `Image` → `image/*`, `Video` → `video/*`, `Audio` →
`audio/*`, `Model3D` → `model/*` or `application/octet-stream`, `File` → any. Formats map to
mime types (case-insensitive compare; a format not in the table is a literal mime type):

| format | mime | format | mime |
|---|---|---|---|
| png | image/png | mp4 | video/mp4 |
| jpeg | image/jpeg | webm | video/webm |
| webp | image/webp | mp3 | audio/mpeg |
| gif | image/gif | wav | audio/wav |
| svg | image/svg+xml | ogg | audio/ogg |
| glb | model/gltf-binary | gltf | model/gltf+json |
| obj | model/obj | stl | model/stl |
| pdf | application/pdf | json | application/json |
| txt | text/plain | | |

### 1.3 Structs, enums, `extends` and static fields

```ts
interface StructDecl { kind: "struct"; id; name; description?; extends?: string; fields: FieldDecl[] }
interface FieldDecl  { name; type: TypeRef; description?; default?; static?: true }
```

- **Static field** (`static: true`): its value is `default` and belongs to the type. Values never
  hold it (`value.invalid`: `… is a static field of X: its value comes from the type and is not
  part of a value`). It is read like any member (§12) and is never writable. A static field
  without a value must have an optional type (`type.static_without_value`).
- **`extends`** names another struct (its id). The extending struct inherits every field; its
  own `fields` may only be static fields: new ones, or inherited ones with another value (same
  type). Rules, checked by validation and commands:

  | Problem | Code |
  |---|---|
  | the base does not exist | `type.extends_unknown` |
  | the base is an enum | `type.extends_not_struct` |
  | the chain loops | `type.extends_cycle` |
  | an extending struct declares an instance field | `type.extends_instance_field` |
  | an inherited static field gets another type | `type.extends_override` |
  | Text or media limits that cannot hold (min > max, negative, a regex that does not compile) | `type.invalid_constraint` |

- **Layout** (`structLayout`): the instance fields come from the root of the chain, the static
  fields are collected along it (the nearest value wins).
- A struct that extends another is accepted wherever the base is (§4).
- Global types usually hold the shared ones: `ShortText extends Text { maxLength = 80 }`,
  `LongText extends Text { maxLength = 2000, multiline = true }`,
  `Thumbnail extends Image { formats = [png, webp], maxWidth = 512 }`.

### 1.4 Identifiers

| Thing | Regex | Max length | Example |
|---|---|---|---|
| Type name (struct/enum, local or global) | `^[A-Z][A-Za-z0-9_]*$` | 64 | `Character`, `ArtStyle`, `Shot_2` |
| Field name, flow input/output name, variable name, global name, port name | `^[A-Za-z_][A-Za-z0-9_]*$` | 64 | `name`, `maxTokens`, `max_tokens` |
| Enum member value | `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` | 64 | `anime`, `16x9`, `gpt-4.1` |
| Enum member label | any non-empty string, trimmed | 120 | `Pixel art` |
| Pack name | `^[a-z][a-z0-9_]*$` | 32 | `openai`, `my_tools` |
| Pack type id | `<pack>.<TypeName>` | — | `openai.ChatMessage` |
| Built-in type id | `briar.<TypeName>` | — | `briar.Image` |
| Generic variable name (`t.var`) | `^[A-Z][A-Za-z0-9]*$` | 16 | `T`, `Item` |
| Context / flow / type / global / variable / node / edge id | `^(ctx\|flow\|ty\|gv\|var\|n\|e)_[A-Za-z0-9_-]{1,60}$` | 64 | `flow_8fK2`, `n_tpl1` |

Rules:

- **Reserved type names**: the built-in names (`Text`, `Image`, `Video`, `Audio`, `Model3D`,
  `File`, `Json`, `SecretKind`, `Secret`, `ApiKey`, `Error`), the primitives with a capital
  (`Int`, `Float`, `Bool`, `String`, `Binary`), the old names `Boolean`, `Model3d`, and `List`,
  `Optional`. Port/field/variable names cannot be `__proto__`, `constructor`, `prototype`.
- **Uniqueness is case-insensitive within a scope; lookup is case-sensitive.** No `Character`
  and `character` types in one scope, no fields `Name` and `name` in one struct.
- Uniqueness scopes: global types within the context; local types within the flow (may shadow
  a global, §3); fields within their struct (static ones included); enum values within their
  enum; flow inputs within inputs, outputs within outputs; flow variables within the flow;
  globals within the context; flow names within the context (case-insensitive).
- Ids are immutable. Renaming never changes an id.

## 2. Shorthand grammar

Shorthand strings are accepted everywhere a type is written by a human: `t.ref`, command
payloads (`"type": "list<Character?>"`), fluent handles. They parse to the IR.

```ebnf
type        = ws , base , { ws , "?" } , ws ;          (* "?" at most once *)
base        = list | primitive | named | var ;
list        = "list" , ws , "<" , type , ">" , [ ws , listBounds ] ;
listBounds  = "[" , ws , [ int ] , ws , ".." , ws , [ int ] , ws , "]" ;   (* list<string>[1..4] *)
primitive   = "int" | "float" | "bool" | "string" | "binary" ;
named       = [ packName , "." ] , typeName ;          (* Image, Character, openai.ChatMessage *)
var         = "$" , varName ;                           (* "$T"; only in node definitions *)
packName    = lower , { lower | digit | "_" } ;
typeName    = upper , { letter | digit | "_" } ;
varName     = upper , { letter | digit } ;
int         = digit , { digit } ;
ws          = { " " } ;
```

Rules:

- `T??` is invalid (`type.syntax`).
- `?` binds to the whole preceding base: `list<Image>?` = optional list; `list<Image?>` = list
  of optional images.
- `listBounds` sets `minItems`/`maxItems`. `min > max` → `type.invalid_constraint`.
- `int` / `float` constraints cannot be written in shorthand; use the `t` builder or the IR.
- `var` (`$T`) is accepted only with `parseType(s, { allowVars: true })`; elsewhere
  `type.var_not_allowed`.
- A lowercase word that is not a primitive is `type.syntax`. For a format-1 name the reason
  says what replaced it: `"text" is not a type any more: use string (or the struct Text for
  text with limits)`, `boolean` → `bool`, `image` → `Image`, `json` → `Json`, `secret` →
  `Secret`, `error` → `Error`. Otherwise: `"str" is not a type (primitives are int, float,
  bool, string, binary; named types start with an uppercase letter)`.
- **Positions** in `type.syntax` are 0-based character offsets (UTF-16 code units) into the
  text as given; `details` is `{ text, reason, position }`.
- `parseType(s, { where? })`: `where` names the place in `type.unknown` messages.

| Shorthand | IR |
|---|---|
| `string` | `{kind:"primitive",name:"string"}` |
| `Image` | `{kind:"named",id:"briar.Image"}` |
| `Character?` | `{kind:"optional",of:{kind:"named",id:"ty_c1"}}` |
| `list<Image>[..4]` | `{kind:"list",of:{kind:"named",id:"briar.Image"},maxItems:4}` |
| `openai.ChatMessage` | `{kind:"named",id:"openai.ChatMessage"}` |
| `list<$T>` | `{kind:"list",of:{kind:"var",name:"T"}}` |

`formatType(ref, scope)` prints the shortest shorthand that resolves back to the same IR in
that scope (built-ins by their short name; `#ty_c1` when the id is unknown). Number
constraints are not printed.

## 3. Scopes and name resolution

| Place | Visible types |
|---|---|
| Inside flow F (ports, private variables, node constants, local type fields) | F's local types, global types, built-in types, pack types |
| Global level (global types' fields, globals) | global types, built-in types, pack types |
| Flow signature, public variables of F | as inside F, then the visibility check (ARCH §2) rejects local types |

Resolution of a name `N` (no dot), in order:

1. local type of the current flow named `N`;
2. global type named `N`;
3. built-in type named `N` (the reserved names keep local and global types from taking them);
4. pack type whose short name is `N`, if exactly one loaded pack exports it; more than one →
   `type.ambiguous`;
5. otherwise `type.unknown`.

A qualified name `p.N` resolves only to the pack type `p.N`; `briar.N` to the built-in.
Resolving an id goes local → global → built-in → pack.

**Shadowing.** A local type may have the same name as a global type; the local one wins inside
its flow (`type.shadows_global`, warning). Documents store ids, so shadowing never changes the
meaning of existing references.

## 4. Assignability

`isAssignable(from, to, resolve?)`: can a value of type `from` flow into a port of type `to`?

| from \ to | same primitive | `float` | named `X` | `list<B>` | `B?` |
|---|---|---|---|---|---|
| primitive `p` | ✓ | ✓ if `p` is `int` | ✗ | ✗ | ✓ if `p → B` |
| named `Y` | ✗ | ✗ | ✓ if `Y` is `X` or extends it | ✗ | ✓ if `Y → B` |
| `list<A>` | ✗ | ✗ | ✗ | ✓ if `A → B` | ✓ if `list<A> → B` |
| `A?` | ✗ | ✗ | ✗ | ✗ | ✓ if `A → B` |

- `int → float` is the only implicit widening. Nothing converts implicitly; conversion nodes do
  it (node-api.md §9), and the editor inserts one when a wire joins two types it converts
  between (`int` → `string` puts As string in between).
- **`extends` is the only subtyping**: `ShortText → Text` ✓, `Text → ShortText` ✗ (a Text may be
  longer than 80). The base's limits are not a reason to refuse: the value is checked against
  the target port's limits when a node gets it (§6).
- Media structs never convert into each other (`Image → File` ✗); `binary` and a media struct
  are different types (`Image.data` is the `binary`, member access §12).
- `Json` leaves through Get field and As string / As int / As float / As bool / As JSON array.
  A missing field, bad JSON text or a wrong kind is a run-time error.
- `list<int> → list<float>` ✓ (values are immutable JSON).
- Number constraints never affect assignability; they are checked on values (§6).
- `var` is resolved first (§5).

## 5. Generics (`var` ports)

A node definition may use `t.var("T")` inside port types (`T`, `list<T>`, `T?`). A node instance
stores the resolved bindings in `NodeInstance.typeBindings` (`{ "T": TypeRef }`).

### 5.1 Bindings are derived, not sticky

`typeBindings` is **recomputed from the node's current edges** after every command that touches
them. It is stored only so that readers do not have to recompute. Binding happens on the first
connect that constrains `T`; removing the last edge that constrains `T` unbinds it; the result
does not depend on the order edges were connected.

### 5.2 Algorithm

For each var `T` of node `n`:

1. **Pattern match** each connected port. For an input port with pattern `P` fed by an output
   of type `S`, `match(P, S)` yields candidates; for an output port with pattern `P` feeding an
   input of type `D`, `match(P, D)` yields *upper bounds*.
   ```
   match(var T, X)            → T ↦ X
   match(list<P>, list<X>)    → match(P, X)          (list bounds ignored)
   match(P?, X?)              → match(P, X)
   match(P?, X)               → match(P, X)
   match(concrete C, X)       → no candidate; plain assignability check
   anything else              → mismatch
   ```
   An edge whose other end still has an unbound var contributes nothing until it is bound.
2. **Lower bound** `L` = join of all input candidates: `join(X, X) = X`,
   `join(int, float) = float`, `join(X, X?) = X?`, `join(list<A>, list<B>) = list<join(A,B)>`;
   a struct and a struct it extends join to the base; otherwise conflict.
3. **Binding** = `L` if there are input candidates; otherwise the meet of the upper bounds
   (`meet(int, float) = int`, `meet(X?, X) = X`, a struct and its base meet to the extending
   one), otherwise conflict.
4. **Check**: the binding must be assignable to every upper bound.
5. Number constraints are dropped from bindings.

Connections are sorted before folding (inputs before outputs, then port name, then the
canonical JSON of the other end's type), so the result and the conflict message (the first
conflicting port) do not depend on connect order. `resolveFlowPorts` repeats until nothing
changes. A conflict in `edge.connect` rejects the command (`edge.generic_conflict`); after other
commands it becomes `node.generic_conflict` and the var is left unbound.

### 5.2.1 Limited generics (`oneOf`)

`t.var("T", { oneOf: [t.string(), t.json()] })` limits what `T` binds to: the binding must be
assignable to one of the listed types, else `node.generic_conflict` / `edge.generic_conflict`
(`{node}: {port} accepts string or Json, not int.`). A limited var that no connection binds
takes its **first** type.

### 5.3 Unbound vars

- A port whose type still contains an unbound var shows as `$T`.
- `node.setValue` on such a port → `value.generic_unbound`.
- Validation: an unbound var in an **input** port → `node.generic_unbound`, once per var, on
  the first input port that uses it. Vars only in unconnected outputs are harmless.

### 5.4 Example

`list.get` has `list: list<$T>`, `index: int`, output `item: $T?`. Connect
`Characters (list<Character>)` → `list` ⇒ `T = Character`; `item: Character?`. Connecting
`item` to a `string` input is rejected (`Character? → string` ✗). Disconnect `list` ⇒ `T`
unbound again.

## 6. Constraints and limits

Only numbers and lists take constraints in the IR:

| Type | Constraint | Validation message (suffix after the path) |
|---|---|---|
| int | `min`, `max` (inclusive, safe ints) | `must be >= {n}` / `must be <= {n}` |
| int | (always) `Number.isSafeInteger` | `must be a whole number` |
| float | `min`, `max` (inclusive) | same as int |
| float | (always) finite | `must be a number` |
| list | `minItems`, `maxItems` | `must have at least {n} items` / `at most {n} items` |

**Limits of text and media are static fields** of the built-in structs (§1.2), set by extending
them. They are checked on values:

| Struct | Static field | Message (at the path shown) |
|---|---|---|
| Text | `minLength`, `maxLength` (code points) | `{path}.value must be at least / at most {n} characters long` |
| Text | `pattern` (whole string) | `{path}.value must match the pattern {pattern}` |
| media | the mime fits the kind | `media.kind_mismatch` |
| media | `formats` | `must be one of the formats {formats} (got {mime})` |
| media | `maxBytes` | `must be at most {n} bytes` (when the size is known) |
| Image, Video | `minWidth` … `maxHeight` | `must be at least {n} px wide` … (when known) |
| Video, Audio | `maxDuration` | `must be at most {n} seconds long` (when known) |

Text limits are checked with the value (§7). Media limits need the registry entry: the engine
checks them when a node gets the media (`checkMediaEntry`, media.md §4); validation of documents
and inputs never looks entries up.

Wrong constraint or limit definitions (`min > max`, negative lengths, a regex that does not
compile) fail with `type.invalid_constraint` (`t` builder throws `TypeDefinitionError`;
commands reject; validation reports).

**Where values are checked** (never at connect time): flow inputs when a run starts; node
inputs before `run()`; node outputs after `run()`; constants set by commands (`node.setValue`,
`global.setValue`, defaults).

## 7. Values: validation and normalization

```ts
validateValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): Diagnostic[];
normalizeValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): NormalizeResult;

type NormalizeResult = { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] };

interface ValueCheckOptions {
  path?: string;          // root of the value path in messages; default "value"
  at?: DiagnosticPath;    // merged into every diagnostic's path
  constraints?: boolean;  // default true; false checks only JSON shape and kinds
}
```

`normalizeValue` validates and normalizes in one pass and never mutates its input.
`validateValue(v) = []` ⇔ `normalizeValue(v).ok`.

| Type | Accepted JSON | Normalized |
|---|---|---|
| string | string | as is |
| int | safe integer | as is |
| float | finite number | as is |
| bool | `true`/`false` | as is |
| binary | `{ mediaId }` (§8) | as is |
| enum | a member `value` (case-sensitive) | as is |
| struct | object with its **instance** fields; no unknown keys, no static fields; every non-optional field without default present | every instance field present; omitted optional → `null`; omitted defaulted → default |
| list | array | element-wise |
| optional | `null` or a valid inner value; missing → `null` | `null` or inner |

So `Text` values are `{ "value": "Hello" }`, `Image` values are
`{ "data": { "mediaId": "med_1" }, "mime": "image/png", "name": "a.png", "size": 2048, "width": 512, "height": 512 }`,
`Json` values are `{ "text": "{\"a\":1}" }`, `Secret` values are `{ "name": "OPENAI_API_KEY" }`.

Paths use dot notation with `[i]`: `inputs.character.name.value`, `inputs.characters[2].age`.
Message template: `` `{path}` {suffix} ``. Kind mismatches end with ` (got <json>)` (compact
JSON, cut to 60 characters, or `nothing`):

| Expected | Suffix |
|---|---|
| string | `must be a string (got …)` |
| int | `must be a whole number (got …)` |
| float | `must be a number (got …)` |
| bool | `must be true or false (got …)` |
| list | `must be a list (got …)` |
| struct `X` | `must be an object with the fields of X (got …)` |
| enum | `must be one of a, b, c (got …)` |

Unknown field: ``… is not a field of Character. Known fields: name, age, style``. Missing field:
``… is required``.

### 7.1 Truthiness

One rule for every yes / no reading of a value (Branch, `{{#if}}`, As bool; `isTruthy`):
`false`, `0`, `""`, an empty list, a `Text` (or a struct extending it) whose `value` is `""`,
`null` and no value are **false**; everything else is true. A `Json` value is read first
(`{ "text": "0" }` is false). Loops (`{{#each}}`, For each) accept only lists.

## 8. Binary values

The value of `binary` is the id of a media registry entry (media.md):

```ts
interface MediaRef { mediaId: string }
```

| Rule | Code on failure |
|---|---|
| an object with exactly the key `mediaId` | `media.invalid_ref` |
| `mediaId` matches `^[A-Za-z0-9_-]{1,128}$` | `media.invalid_ref` |

Validation checks the shape only. The media structs (§1.2) wrap a `binary` in `data` with the
facts a node needs without reading the registry (mime, name, size, dimensions). The registry
entry is authoritative: the engine checks the entry against the struct's kind and limits when a
node gets the media (media.md §4). The media API (`ctx.media.read`, `entry`, `url`) accepts a
`binary`, a media struct value or a bare id.

## 9. JSON Schema mapping (`toJsonSchema`)

Target: JSON Schema draft 2020-12, one schema with `$defs` for named types.

| Type | Schema |
|---|---|
| string | `{"type":"string"}` |
| int / float | `{"type":"integer"}` / `{"type":"number"}`, with `minimum` / `maximum` |
| bool | `{"type":"boolean"}` |
| binary | `{"$ref":"#/$defs/MediaRef"}`; `MediaRef` = `{ mediaId }` (pattern dropped in strict mode) |
| struct `X` | `{"$ref":"#/$defs/X"}`; def: object of its **instance** fields, `title`, `description`, `required`, `additionalProperties: false` |
| Text (and structs extending it) | its def's `value` gets `minLength` / `maxLength`, and `pattern` `^(?:…)$` (not in strict mode) |
| media structs | the def also gets `x-briar-media: "image"` and `x-briar-formats: [mimes]` (not in strict mode) |
| enum `E` | `{"$ref":"#/$defs/E"}`; def: `{"type":"string","enum":[…],"title":"E"}`, labels in `x-briar-labels` |
| list | `{"type":"array","items":…,"minItems":…,"maxItems":…}` |
| optional | `{"anyOf":[ inner, {"type":"null"} ]}` |
| var | error `type.var_not_allowed` |

- `required` lists fields that are non-optional and have no default. Field `default` → schema
  `default`, `description` → `description`. Static fields are not in the schema.
- `{ strict: true }` (LLM structured output): every field in `required`; no `default`, no
  `pattern`, no `x-briar-*`.
- `$defs` keys: the type name; pack types use the qualified id. If two ids share a name, the
  widest scope keeps the plain name and narrower ones get `<Name>__<id>`.
- Every root carries `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
- A flow signature compiles to `{ inputs: <object schema>, outputs: <object schema> }`.

## 10. Structural checks on type declarations

| Check | Code | When |
|---|---|---|
| a struct contains itself through instance fields, lists, optionals | `type.recursive` | hard reject in commands; error in validation |
| a global type uses a local type | `visibility.local_type_in_global` | hard reject |
| enum with zero members | `type.enum_empty` | warning |
| field default not valid for the field type | `type.invalid_default` | hard reject on set; error when it becomes invalid later |
| static field without a value and not optional | `type.static_without_value` | error |
| `extends` problems | §1.3 | error |

## 11. Diagnostic codes (type system)

Shape (core `validation/diagnostic.ts`):

```ts
interface Diagnostic {
  severity: "error" | "warning";
  code: string;            // area.snake_case
  message: string;         // what, where, how to fix
  path: DiagnosticPath;    // flowId?, nodeId?, port?, edgeId?, typeId?, field?, variableId?, globalId?, valuePath?
  details?: unknown;
}
```

| Code | Severity | Message template |
|---|---|---|
| `type.syntax` | error | `Cannot read the type "{text}": {reason} at position {pos}. Example of valid types: string, list<Image>, Character?` |
| `type.unknown` | error | `Unknown type "{name}" in {where}. Define it in the Types panel or check the spelling.` |
| `type.unknown_id` | error | `{where} refers to type id {id}, which no longer exists. Pick another type.` |
| `type.ambiguous` | error | `"{name}" matches several pack types: {ids}. Use the full name, e.g. {firstId}.` |
| `type.var_not_allowed` | error | `Generic type "${name}" can only be used in node definitions.` |
| `type.invalid_name` | error | `"{name}" is not a valid type name. …` |
| `type.reserved_name` | error | `"{name}" is reserved. Choose another type name.` |
| `type.duplicate_name` | error | `A type named "{existing}" already exists in {scope}. …` |
| `type.shadows_global` | warning | `Local type "{name}" in flow "{flow}" hides the global type with the same name.` |
| `type.recursive` | error | `Type "{name}" contains itself through {chain}. Recursive types are not supported.` |
| `type.invalid_constraint` | error | `Constraint {constraint} on {where} is invalid: {reason}.` |
| `type.invalid_default` | error | `Default value of {where} is not valid: {detail}.` |
| `type.static_without_value` | error | `Static field "{type}.{field}" has no value. Give it one, or make its type optional.` |
| `type.extends_unknown` | error | `"{type}" extends type id {id}, which no longer exists. Pick another struct.` |
| `type.extends_not_struct` | error | `"{type}" extends "{base}", which is not a struct. Only structs can be extended.` |
| `type.extends_cycle` | error | `"{type}" extends itself through {chain}.` |
| `type.extends_instance_field` | error | `"{type}.{field}" is not static. A struct that extends another may only add or set static fields.` |
| `type.extends_override` | error | `"{type}.{field}" sets an inherited static field with another type. Keep the type it has in the base.` |
| `type.enum_empty` | warning | `Enum "{name}" has no members, so no value can be valid. Add a member.` |
| `visibility.local_type_in_public_signature` | error | `Flow {input\|output} "{name}" uses local type "{type}". …` |
| `visibility.local_type_in_global` | error | `{where} uses local type "{type}", which is only visible inside flow "{flow}". …` |
| `visibility.local_type_in_public_variable` | error | `Public variable "{name}" uses local type "{type}". …` |
| `edge.type_mismatch` | error | `Cannot connect {fromNode}.{fromPort} ({fromType}) to {toNode}.{toPort} ({toType}). {hint}` |
| `edge.generic_conflict` / `node.generic_conflict` | error | `{node} already uses {T} = {bound}; {port} would need {T} = {other}.` |
| `node.generic_unbound` | error | `{node} does not know its type yet. Connect a value to "{port}".` |
| `value.invalid` | error | `{path} {suffix}` (§6, §7) |
| `value.generic_unbound` | error | `Cannot set a constant on "{port}" of {node} before its type is known. Connect an input first.` |
| `media.invalid_ref` / `media.kind_mismatch` | error | `{path} is not a valid binary value: {reason}.` / `… is {mime}, which is not an image (…)` |

Type diagnostics point at the declaring entity (`path.typeId` + `field`); the referenced id
goes to `details.id`. Non-type validation codes are in commands.md §9.

## 12. Members (`value.member`)

Every type has a fixed list of **members**: what Get member / Set member and split pins read
(`typeMembers`, `memberAt`, `memberPaths`, `readMember`, `writeMember`).

| Type | Members | Writable |
|---|---|---|
| struct | its instance fields, then its static fields (with the type's values) | instance fields only |
| `string`, `list<T>` | `length: int` (string: code points) | no |
| `T?` | the members of `T`, each optional | no |
| others (`int`, `float`, `bool`, `binary`, enums) | none | — |

So `image.width`, `image.mime`, `image.maxWidth` (the type's limit), `title.value`,
`title.maxLength`, `portrait.image.data` are members; nested paths go up to 3 steps (a struct is
not entered again inside itself). A missing step gives `none`; an absent field with a default
gives the default. Set member returns a copy with the field replaced; a path through a static
field is read-only (`config.invalid`).

## 13. Format 1 → 2

Context documents of format 1 are upgraded when read (`MIGRATIONS[1]`):

- type refs: `text` → `string` (text constraints are dropped: extend `Text` for limits),
  `boolean` → `bool`, `image` … `file` → `Image` … `File`, `json` → `Json`, `secret` →
  `Secret` (`ApiKey` when its kind was `apiKey`), `error` → `Error`;
- values whose type is known (defaults, globals, variables): media `{ mediaId }` →
  `{ data: { mediaId }, mime: "" }` (the entry's mime is used when a node reads it), JSON →
  `{ text }`, secret names → `{ name }`;
- node constants: only media values are recognised (by shape) and wrapped; validation reports
  others that no longer fit.
