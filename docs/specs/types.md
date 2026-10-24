# Spec: Type system

Status: draft v1 (phase 0). Owner: ux-designer. Implemented in `@briarflow/core` (phase 1).

This spec makes ARCHITECTURE §4.1–4.5 precise: shorthand grammar, identifiers, scopes,
assignability, generics, constraints, MediaRef validation, JSON Schema mapping, diagnostics.

## Deviations from ARCHITECTURE.md

1. **Optional struct fields may be omitted in values.** ARCH §4.3 says a struct value has
   "exactly the declared fields". v1 keeps "no unknown fields" but lets a value omit a field
   whose type is `optional` (normalized to `null`) or that has a `default` (normalized to the
   default). Reason: REST callers and LLM output should not have to spell out every `null`.
   `normalizeValue()` produces the canonical form with every field present.
2. **Unqualified pack type names.** ARCH §4.1 lists the resolution order "flow local → global
   → pack". Pack types are always addressable by their qualified id (`openai.ChatMessage`);
   the short name (`ChatMessage`) also resolves if exactly one loaded pack exports it and no
   local/global type has that name. This is the only way pack types take part in "→ pack".

---

## 1. Identifiers

| Thing | Regex | Max length | Example |
|---|---|---|---|
| Type name (struct/enum, local or global) | `^[A-Z][A-Za-z0-9_]*$` | 64 | `Character`, `ArtStyle`, `Shot_2` |
| Field name, flow input/output name, variable name, global name, port name | `^[A-Za-z_][A-Za-z0-9_]*$` | 64 | `name`, `maxTokens`, `max_tokens` |
| Enum member value | `^[A-Za-z0-9_][A-Za-z0-9_.-]*$` | 64 | `anime`, `16x9`, `gpt-4.1` |
| Enum member label | any non-empty string, trimmed | 120 | `Pixel art` |
| Pack name | `^[a-z][a-z0-9_]*$` | 32 | `openai`, `my_tools` |
| Pack type id | `<pack>.<TypeName>` | — | `openai.ChatMessage` |
| Generic variable name (`t.var`) | `^[A-Z][A-Za-z0-9]*$` | 16 | `T`, `Item` |
| Context / flow / type / global / variable / node / edge id | `^(ctx\|flow\|ty\|gv\|var\|n\|e)_[A-Za-z0-9_-]{1,60}$` | 64 | `flow_8fK2`, `n_tpl1` |

Rules:

- **Reserved words.** Type names cannot be a primitive name with a capital (`Text`, `Int`,
  `Float`, `Boolean`, `Image`, `Video`, `Audio`, `Model3d`, `Model3D`, `File`) nor `List`,
  `Optional`. Port/field/variable names cannot be `__proto__`, `constructor`, `prototype`, or
  start with `$` (the regex already forbids `$`; `$media` is a wire marker, see
  python-protocol.md).
- **Uniqueness is case-insensitive within a scope; lookup is case-sensitive.** You cannot
  have `Character` and `character` types in the same scope, nor fields `Name` and `name` in
  one struct. Reason: avoids look-alike names in UIs and in Python bindings.
- Names are trimmed by nothing: a name with surrounding whitespace is simply invalid.
- Uniqueness scopes:
  - global types: unique within the context's global types;
  - local types: unique within the flow's local types (may shadow a global, see §3);
  - fields: unique within their struct; enum member values unique within their enum;
  - flow inputs: unique within the flow's inputs; outputs: unique within outputs (an input
    and an output may share a name);
  - flow variables: unique within the flow; globals: unique within the context;
  - flow names: unique within the context (case-insensitive); context names are **not**
    required to be unique.
- Ids are immutable. Renaming never changes an id.

## 2. Shorthand grammar

Shorthand strings are accepted everywhere a type is written by a human: the `t` builder via
`t.ref`, command payloads (`"type": "list<Character?>"`), fluent handles, the Python SDK
manifest never (it sends IR). They parse to the IR in ARCH §4.1.

```ebnf
type        = ws , base , { ws , "?" } , ws ;          (* "?" may appear at most once, see rules *)
base        = list | primitive | named | var ;
list        = "list" , ws , "<" , type , ">" , [ ws , listBounds ] ;
listBounds  = "[" , ws , [ int ] , ws , ".." , ws , [ int ] , ws , "]" ;   (* list<text>[1..4] *)
primitive   = "text" | "int" | "float" | "boolean" | "json" | "secret"
            | "image" | "video" | "audio" | "model3d" | "file" ;
named       = [ packName , "." ] , typeName ;
var         = "$" , varName ;                           (* "$T"; only in node definitions *)
packName    = lower , { lower | digit | "_" } ;
typeName    = upper , { letter | digit | "_" } ;
varName     = upper , { letter | digit } ;
int         = digit , { digit } ;
ws          = { " " } ;
```

Rules:

- `T??` is invalid (`type.syntax`): optional of optional is not a type.
- `?` binds to the whole preceding base: `list<image>?` = optional list; `list<image?>` = list
  of optional images.
- `listBounds` sets `minItems`/`maxItems`: `list<text>[1..]`, `list<text>[..4]`,
  `list<text>[2..2]`. `min > max` → `type.invalid_constraint`.
- Primitive constraints cannot be written in shorthand; use the `t` builder or the IR.
- `var` (`$T`) is accepted only when parsing node-definition ports
  (`parseType(s, { allowVars: true })`). Anywhere else → `type.var_not_allowed`.
- Primitive names are lowercase and win over named types (named types must start uppercase,
  so there is no ambiguity).
- A lowercase word that is not a primitive (`string`, `str`, `character`) is `type.syntax`,
  not `type.unknown`: it can never resolve, because named types start uppercase (DECISIONS #31).
  The reason reads `"string" is not a type (primitives are text, int, float, boolean, image,
  video, audio, model3d, file; named types start with an uppercase letter)`, positioned at the
  start of the word. (`pack.Name` is still a named ref: the lowercase part before the dot is a
  pack name.)
- **Positions** in `type.syntax` are **0-based character offsets** (UTF-16 code units, i.e.
  JS string indices) into the shorthand text as given, leading spaces included. The message's
  `{pos}` and `details.position` carry the same number (DECISIONS #30); `details` is
  `{ text, reason, position }`. Example: `"list<text"` → `… expected ">" but the text ended
  at position 9`.
- `parseType(s, { where? })`: `where` names the place in `type.unknown` messages
  (`flow input "character"`); default: the quoted shorthand.

Examples:

| Shorthand | IR |
|---|---|
| `text` | `{kind:"primitive",name:"text"}` |
| `Character?` | `{kind:"optional",of:{kind:"named",id:"ty_c1"}}` |
| `list<Character?>` | `{kind:"list",of:{kind:"optional",of:{kind:"named",id:"ty_c1"}}}` |
| `list<image>[..4]` | `{kind:"list",of:{kind:"primitive",name:"image"},maxItems:4}` |
| `openai.ChatMessage` | `{kind:"named",id:"openai.ChatMessage"}` |
| `list<$T>` | `{kind:"list",of:{kind:"var",name:"T"}}` |

`formatType(ref, scope)` is the inverse: it prints the shortest shorthand that resolves back
to the same IR in that scope (qualified pack name when the short one is shadowed or
ambiguous; `#ty_c1` when the id is unknown). Constraints on primitives are not printed.

## 3. Scopes and name resolution

A **scope** is the set of named types visible at one place:

| Place | Visible types |
|---|---|
| Inside flow F (ports, private variables, node constants, local type fields) | F's local types, global types, pack types |
| Global level (global types' fields, globals) | global types, pack types |
| Flow signature, public variables of F | resolution as inside F, but the visibility check (ARCH §2) then rejects local types |

Resolution of a name `N` (no dot), in order:

1. local type of the current flow named `N` (exact case);
2. global type named `N`;
3. pack type whose short name is `N`, if exactly one loaded pack exports it;
   more than one → `type.ambiguous` (message lists the qualified ids).
4. otherwise `type.unknown`.

A qualified name `p.N` resolves only to the pack type `p.N` (packs are never shadowed).

**Shadowing.** A local type may have the same name as a global type. The local one wins
inside its flow. Validation reports a warning `type.shadows_global` on the local type. Since
documents store ids, shadowing never changes the meaning of existing references; it only
affects how new shorthand is resolved and how `formatType` prints.

## 4. Assignability

`isAssignable(from, to, scope)` — can a value of type `from` flow into a port of type `to`?

| from \ to | same primitive | `float` | named `X` | `list<B>` | `B?` |
|---|---|---|---|---|---|
| primitive `p` | ✓ | ✓ if `p` is `int` or `float` | ✗ | ✗ | ✓ if `p → B` |
| named `X` | ✗ | ✗ | ✓ if same id | ✗ | ✓ if `X → B` |
| `list<A>` | ✗ | ✗ | ✗ | ✓ if `A → B` | ✓ if `list<A> → B` |
| `A?` | ✗ | ✗ | ✗ | ✗ | ✓ if `A → B` |

Notes:

- `int → float` is the only implicit widening. Nothing converts implicitly; conversion nodes
  do it (node-api.md §1.1), and the editor inserts one when a wire joins two types it
  converts between (e.g. json → text puts As text in between).
- Media primitives never convert between each other (`image → file` is ✗).
- `json` is assignable only to `json`. Text becomes json through As JSON (not parsed: a json
  value may be raw JSON text, parsed when a field is read); json leaves through Get field and
  the conversions As text / As int / As float / As boolean / As JSON array (node-api.md §9).
  A missing field, bad JSON text or a wrong kind is a run-time error, never a validation error.
- `secret` is assignable only to `secret` (any kind; `kind` is a constraint). Its value is the
  name of a vault secret, never the secret itself (secrets.md).
- `list<int> → list<float>` ✓ (covariance is safe because values are immutable JSON).
- Constraints never affect assignability (`text{maxLength:10} → text{maxLength:5}` ✓). They are
  checked on values at runtime boundaries (§6).
- `var` is never assignable directly; it is resolved first (§5). An unresolved `var` port
  cannot be connected to an unrelated var port of another node unless one side is bound —
  see §5.

## 5. Generics (`var` ports)

A node definition may use `t.var("T")` inside port types (`T`, `list<T>`, `T?`). A node
instance stores the resolved bindings in `NodeInstance.typeBindings` (`{ "T": TypeRef }`).

### 5.1 Bindings are derived, not sticky

`typeBindings` is **recomputed from the node's current edges** after every command that
touches them (`edge.connect`, `edge.disconnect`, `node.remove` of a neighbour, port type
changes upstream). It is stored only so that readers do not have to recompute. Consequences:

- binding happens on the first connect that constrains `T`;
- **removing the last edge that constrains `T` unbinds it** (the key is deleted);
- the result does not depend on the order edges were connected.

### 5.2 Algorithm

For each var `T` of node `n`:

1. **Pattern match** each connected port. For an input port with pattern `P` fed by an output
   of type `S`, `match(P, S)` yields candidates for vars in `P`; for an output port with
   pattern `P` feeding an input of type `D`, `match(P, D)` yields *upper bounds*.
   ```
   match(var T, X)            → T ↦ X
   match(list<P>, list<X>)    → match(P, X)          (list bounds ignored)
   match(P?, X?)              → match(P, X)
   match(P?, X)               → match(P, X)          (because X → X? is allowed)
   match(concrete C, X)       → no candidate; plain assignability check
   anything else              → mismatch
   ```
   When `S`/`D` itself contains an unbound var of a neighbour (two generic nodes wired
   together), that edge contributes **nothing** until the neighbour is bound.
2. **Lower bound** `L` = least upper bound (join) of all input candidates:
   `join(X, X) = X`, `join(int, float) = float`, `join(X, X?) = X?`,
   `join(list<A>, list<B>) = list<join(A,B)>`, otherwise no join → conflict.
3. **Binding** = `L` if there are input candidates; otherwise the greatest lower bound (meet)
   of the upper bounds: `meet(X, X) = X`, `meet(int, float) = int`, `meet(X?, X) = X`,
   `meet(list<A>, list<B>) = list<meet(A,B)>`, otherwise conflict.
4. **Check**: the binding must be assignable to every upper bound.
5. Constraints are dropped from bindings (`text{maxLength:3}` binds as `text`).

**Order independence and conflicts** (DECISIONS #33). Before folding join/meet, the node's
connections are sorted: inputs before outputs, then by port name, then by the canonical JSON of
the other end's type. The fold therefore gives the same binding whatever order the edges were
connected in. On a conflict the message names the **first conflicting port in that order**
(`{port}` in `edge.generic_conflict` / `node.generic_conflict`), and `{bound}` is the binding
folded from the ports before it.

**Flow-wide fixpoint.** `resolveFlowPorts` recomputes bindings for all generic nodes of a flow
repeatedly until nothing changes (two generic nodes wired together bind once either side is
bound from elsewhere). Within one node, a var with a conflict is left unbound and reported as
`node.generic_conflict` (once per var); the node's other vars still bind normally.

`edge.connect` runs the algorithm with the new edge included; a conflict rejects the command
with `edge.generic_conflict`. Recomputation after other commands (e.g. an upstream port type
changed by `flow.input.setType`) never rejects: a conflict becomes the diagnostic
`node.generic_conflict` and the var is left unbound.

### 5.2.1 Limited generics (`oneOf`)

`t.var("T", { oneOf: [t.text(), t.json()] })` limits what `T` binds to: the folded binding must
be assignable to one of the listed (concrete) types, else `node.generic_conflict` /
`edge.generic_conflict` with `details.allowed` and the message
`{node}: {port} accepts text or json, not int.` A limited var that no connection binds takes
its **first** type (so the port can hold a typed value and is never `node.generic_unbound`);
editors still offer it to any of its types (they look at the declared type).

### 5.3 Unbound vars

- A port whose type still contains an unbound var displays as `$T` and accepts a connection
  from anything that the algorithm accepts.
- `node.setValue` on a port whose type contains an unbound var → `value.generic_unbound`.
- Validation (before a run): any node with an unbound var that appears in an **input** port →
  error `node.generic_unbound` ("Connect a value to `<port>` so the node knows its type").
  It is reported **once per var**, on the first input port (declaration order) whose type uses
  it. Vars appearing only in outputs that are unconnected are harmless and resolve to nothing.
- An input whose type still contains an unbound var is reported by `node.generic_unbound`
  only (DECISIONS #35); empty inputs are never errors (node-api.md).

### 5.4 Example

`list.get` has `list: list<$T>`, `index: int`, output `item: $T?`.

- connect `Characters (list<Character>)` → `list` ⇒ `T = Character`; `item: Character?`.
- connect `item` → a `text` input ⇒ rejected: `Character? → text` ✗ (`edge.type_mismatch`).
- disconnect the `list` edge ⇒ `T` unbound again; `item` shows `$T?`.

## 6. Constraints

Constraints live on primitive and list IR nodes. All are optional.

| Type | Constraint | Meaning | Validation message (suffix after the path) |
|---|---|---|---|
| text | `minLength: int ≥ 0` | min length in Unicode code points | `must be at least {n} characters long` |
| text | `maxLength: int ≥ 0` | max length in code points | `must be at most {n} characters long` |
| text | `pattern: string` | ECMAScript regex, `u` flag, must match the **whole** string (implicitly anchored) | `must match the pattern {pattern}` |
| text | `multiline: boolean` | UI hint only, never validated | — |
| int | `min`, `max` (inclusive, safe ints) | | `must be >= {n}` / `must be <= {n}` |
| int | (always) | `Number.isSafeInteger` | `must be a whole number` |
| float | `min`, `max` (inclusive) | | same as int |
| float | (always) | finite number | `must be a number` |
| boolean | — | | `must be true or false` |
| json | — | | `must be JSON: …` |
| secret | `kind: apiKey \| text \| number \| json` | which secrets a picker offers; not checked on values | — |
| image/video/audio/model3d/file | `formats: string[]` | allowed formats, see table below | `must be one of the formats {formats} (got {mime})` |
| media | `maxBytes: int` | checked only when `bytes` is present | `must be at most {n} bytes` |
| image | `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | checked only when `meta.width/height` present | `must be at least {n} px wide` … |
| video, audio | `maxDurationSec` | checked only when `meta.durationSec` present | `must be at most {n} seconds long` |
| list | `minItems`, `maxItems` | | `must have at least {n} items` / `at most {n} items` |

Formats map to mime types (case-insensitive compare on the mime):

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

A format string that is not in the table is treated as a literal mime type
(`formats: ["application/zip"]`). Invalid constraint definitions (`min > max`, negative
lengths, a regex that does not compile) are rejected when the type is built (`t` builder
throws `TypeDefinitionError`, code `type.invalid_constraint`; commands reject with the same
code).

**Where constraints are checked** (never at connect time):

1. flow inputs, when a run starts (after defaults are applied);
2. node inputs, before `run()` — only ports that declare constraints;
3. node outputs, after `run()` returns (all outputs are type-checked; constraints included);
4. constant values set by commands (`node.setValue`, `global.setValue`, defaults) — hard
   check at the time of the command.

## 7. Values: validation and normalization

```ts
validateValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): Diagnostic[];
normalizeValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): NormalizeResult;

type NormalizeResult =
  | { ok: true; value: unknown }                 // canonical form (table below)
  | { ok: false; diagnostics: Diagnostic[] };    // same findings validateValue returns (never empty)

interface ValueCheckOptions {
  path?: string;          // root of the value path in messages and path.valuePath; default "value"
  at?: DiagnosticPath;    // merged into every diagnostic's path, e.g. { flowId, nodeId, port }
  constraints?: boolean;  // default true; false checks only JSON shape and kinds
}
```

- `normalizeValue` validates and normalizes in one pass (DECISIONS #16): callers never need
  `validateValue` first. It never mutates its input; `value` is a new object/array wherever
  normalization changed something (unchanged leaves may be shared).
- `validateValue(v) = []` ⇔ `normalizeValue(v).ok === true`, for the same options.
- Each diagnostic sets `path.valuePath` to the dotted path of the failing position (below),
  plus the keys from `options.at`.

| Type | Accepted JSON | Normalized |
|---|---|---|
| text | string | as is |
| int | safe integer number | as is (`2.0` is accepted, it is the same JSON number as `2`) |
| float | finite number | as is |
| boolean | `true`/`false` | as is |
| json | any JSON value: object, array (also at the root), string, finite number, boolean, `null` | as is |
| secret | a secret name (`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`) | as is |
| media | MediaRef object (§8) | as is |
| enum | string equal to one member `value` (case-sensitive) | as is |
| struct | object; no unknown keys; every non-optional field without default present | every field present; omitted optional → `null`; omitted defaulted → default |
| list | array | element-wise |
| optional | `null` or a valid inner value; `undefined`/missing → `null` | `null` or inner |

Paths in messages use dot notation with `[i]` for list indices, rooted at the place being
validated: `inputs.character.age`, `nodes.n_tpl1.values.template`, `globals.brandGuide`,
`inputs.characters[2].name`.

Message template: `` `{path}` {suffix} `` — e.g. ``inputs.character.age must be >= 0``.
Constraint messages use exactly the §6 suffixes.

**Type (kind) mismatches always end with ` (got <json>)`**, where `<json>` is the offending
value as compact JSON, cut to 60 characters (57 + `...`), or `nothing` for a missing value
(DECISIONS #32): ``inputs.character.age must be a whole number (got "27")``.

| Expected | Suffix |
|---|---|
| text | `must be text (got …)` |
| int | `must be a whole number (got …)` |
| float | `must be a number (got …)` |
| boolean | `must be true or false (got …)` |
| json | `must be JSON: {problem}` (non-finite number, `undefined`, function, circular reference) |
| secret | `must be the name of a secret (got …)` |
| list | `must be a list (got …)` |
| struct `X` | `must be an object with the fields of X (got …)` |
| enum | `must be one of a, b, c (got …)` |
Unknown field: ``inputs.character.nickname is not a field of Character. Known fields: name, age, style``.
Missing field: ``inputs.character.name is required``.
Enum: ``inputs.character.style must be one of anime, realistic, pixel (got "Anime")``.

## 8. MediaRef validation

```ts
interface MediaRef { uri: string; mime: string; bytes?: number; hash?: string; meta?: {...} }
```

| Field | Rule | Code on failure |
|---|---|---|
| `uri` | `briar-media://<id>` with id `^[A-Za-z0-9_-]{1,128}$`, or an absolute `https://` URL, or `http://` URL (allowed by core; servers may refuse) | `media.invalid_uri` |
| `mime` | `^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$` (lowercase, no parameters) | `media.invalid_mime` |
| mime vs primitive | `image` → `image/*`; `video` → `video/*`; `audio` → `audio/*`; `model3d` → `model/*` or `application/octet-stream`; `file` → any | `media.kind_mismatch` |
| `bytes` | safe integer ≥ 0 | `media.invalid_ref` |
| `hash` | `^[0-9a-f]{64}$` (sha-256, lowercase hex) | `media.invalid_ref` |
| `meta` | object; `width`,`height` positive ints; `durationSec` ≥ 0; `fps` > 0; other keys free (JSON) | `media.invalid_ref` |
| other top-level keys | not allowed | `media.invalid_ref` |

Core never fetches media to validate it. `meta.filename` is the conventional place for an
original file name.

## 9. JSON Schema mapping (`toJsonSchema`)

Target: JSON Schema draft 2020-12. Output is one schema with `$defs` for named types.

| Type | Schema |
|---|---|
| text | `{"type":"string","minLength":…,"maxLength":…,"pattern":"^(?:…)$"}` |
| int | `{"type":"integer","minimum":…,"maximum":…}` |
| float | `{"type":"number","minimum":…,"maximum":…}` |
| boolean | `{"type":"boolean"}` |
| json | `{}` (any value) |
| secret | `{"type":"string","minLength":1}` (the name) |
| media primitive | `{"$ref":"#/$defs/MediaRef"}` combined via `allOf` with `{"properties":{"mime":{"pattern":"^image/"}}}` (or the `enum` of mimes when `formats` is set) |
| struct `X` | `{"$ref":"#/$defs/X"}`; def: `{"type":"object","title":"X","description":…,"properties":{…},"required":[…],"additionalProperties":false}` |
| enum `E` | `{"$ref":"#/$defs/E"}`; def: `{"type":"string","enum":["a","b"],"title":"E"}` (labels in `x-briar-labels`) |
| list | `{"type":"array","items":…,"minItems":…,"maxItems":…}` |
| optional | `{"anyOf":[ inner, {"type":"null"} ]}` |
| var | error `type.var_not_allowed` |

- `required` lists fields that are non-optional and have no default (Deviation 1). Field
  `default` → schema `default`. Field `description` → `description`.
- Option `{ strict: true }` (for LLM structured output): every field listed in `required`;
  **drops** every `default` and every `pattern` — including the mime `pattern` on media
  primitives — and no `format` keywords; optional stays `anyOf [..., null]`; the `MediaRef`
  def is reduced to `{uri, mime}` (both required, `additionalProperties: false`)
  (DECISIONS #37).
- Enum member labels go to the non-standard keyword `x-briar-labels`. Validators in strict
  mode (Ajv's default) reject unknown keywords: use Ajv with `strict: false`, or register the
  keyword.
- `$defs` keys: the type name; pack types use the qualified id (`openai.ChatMessage`). Keys are
  sorted. If two different ids share a name in one schema, the **widest scope keeps the plain
  name** (pack > global > local) and each narrower one gets `<Name>__<id>`
  (e.g. global `Character` → `Character`, local `Character` `ty_c9` → `Character__ty_c9`).
- `MediaRef` def is added once when any media type is used.
- Every schema root carries `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
- A flow signature compiles to `{ inputs: <object schema of inputs>, outputs: <object schema of outputs> }`
  where each is an object whose properties are the signature fields (same `required` rule).

## 10. Structural checks on type declarations

| Check | Code | When |
|---|---|---|
| struct field references itself directly or indirectly (through fields, lists, optionals) | `type.recursive` | hard reject in commands; error diagnostic in validation |
| global type field uses a local type | `visibility.local_type_in_global` | hard reject |
| enum with zero members | `type.enum_empty` | warning |
| struct with zero fields | — | allowed |
| field default not valid for field type | `type.invalid_default` | hard reject on set; diagnostic (error) when it becomes invalid later |

## 11. Diagnostic codes (type system)

All diagnostics follow ARCH §4.10. `{x}` are placeholders. Shape (core
`validation/diagnostic.ts`, DECISIONS #26):

```ts
interface Diagnostic {
  severity: "error" | "warning";
  code: string;            // area.snake_case
  message: string;         // what, where, how to fix
  path: DiagnosticPath;    // every key optional; set all that apply
  details?: unknown;       // optional JSON data, e.g. { usages }, { cycle }, { edgeIds }
}
interface DiagnosticPath {
  flowId?; nodeId?; port?; edgeId?; typeId?; field?;
  variableId?;   // flow variable diagnostics (variables.md)
  globalId?;     // global diagnostics (global.invalid_value, variable.write_to_readonly on globals)
  valuePath?;    // dotted path into a value (§7), e.g. "inputs.characters[2].name"
}
```

| Code | Severity | Message template |
|---|---|---|
| `type.syntax` | error | `Cannot read the type "{text}": {reason} at position {pos}. Example of valid types: text, list<image>, Character?` — `{pos}` = `details.position` = 0-based character offset into `{text}` (§2) |
| `type.unknown` | error | `Unknown type "{name}" in {where}. Define it in the Types panel or check the spelling.` |
| `type.unknown_id` | error | `{where} refers to type id {id}, which no longer exists. Pick another type.` |
| `type.ambiguous` | error | `"{name}" matches several pack types: {ids}. Use the full name, e.g. {firstId}.` |
| `type.var_not_allowed` | error | `Generic type "${name}" can only be used in node definitions.` |
| `type.invalid_name` | error | `"{name}" is not a valid type name. Type names start with an uppercase letter and use letters, digits and _ (e.g. Character).` |
| `type.reserved_name` | error | `"{name}" is reserved. Choose another type name.` |
| `type.duplicate_name` | error | `A type named "{existing}" already exists in {scope}. Names must be unique (ignoring case).` |
| `type.shadows_global` | warning | `Local type "{name}" in flow "{flow}" hides the global type with the same name.` |
| `type.recursive` | error | `Type "{name}" contains itself through {chain}. Recursive types are not supported.` |
| `type.invalid_constraint` | error | `Constraint {constraint} on {where} is invalid: {reason}.` |
| `type.invalid_default` | error | `Default value of {where} is not valid: {detail}.` |
| `type.enum_empty` | warning | `Enum "{name}" has no members, so no value can be valid. Add a member.` |
| `visibility.local_type_in_public_signature` | error | `Flow {input\|output} "{name}" uses local type "{type}". Public signatures can only use primitives, global types and pack types. Move "{type}" to global types.` |
| `visibility.local_type_in_global` | error | `{where} uses local type "{type}", which is only visible inside flow "{flow}". Move it to global types first.` |
| `visibility.local_type_in_public_variable` | error | `Public variable "{name}" uses local type "{type}". Make the variable private or move the type to global.` |
| `edge.type_mismatch` | error | `Cannot connect {fromNode}.{fromPort} ({fromType}) to {toNode}.{toPort} ({toType}). {hint}` (hint, first match wins: `Use list.get to pick one item.` when from is a list whose item fits the target; else `Use convert.toText to turn it into text.` when target is text; else empty — DECISIONS #51) |
| `edge.generic_conflict` | error | `{node} already uses {T} = {bound}; {port} would need {T} = {other}.` |
| `node.generic_conflict` | error | same text as `edge.generic_conflict`, reported after an upstream change |
| `node.generic_unbound` | error | `{node} does not know its type yet. Connect a value to "{port}".` |
| `value.invalid` | error | `{path} {suffix}` (see §7) |
| `value.generic_unbound` | error | `Cannot set a constant on "{port}" of {node} before its type is known. Connect an input first.` From `validateValue` (no node/port known): `Cannot set a constant on "{path}" before its type is known. Connect an input first.` |
| `media.invalid_uri` / `media.invalid_mime` / `media.kind_mismatch` / `media.invalid_ref` | error | `{path} is not a valid {primitive}: {reason}.` |

Type diagnostics point at the **declaring entity** (`path.typeId` + `field`, `flowId` +
`field` for signature fields, `variableId`, `globalId`); the id of the referenced (missing or
ambiguous) type goes to `details.id` (DECISIONS #35).

Non-type validation codes (`flow.duplicate_id`, `flow.duplicate_name`, `edge.unknown_node`,
`edge.unknown_port`, `edge.duplicate_input`, `input.unconnected`, …) are listed in
commands.md §9.

Node labels in messages use the node title, or the definition title plus id when the title is
empty: `Text template (n_tpl1)`.

## 12. Members (`value.member`)

Every type has a fixed list of **members**: what `value.member` reads, like the dot operator in
code. Core computes them (`typeMembers`, `memberAt`, `memberPaths`, `readMember`,
`writeMember`); the std nodes **Get member** (`briar.member.get`) and **Set member**
(`briar.member.set`) use them. In the editor, dropping a wire from an output on empty canvas
lists every member of the output's type, nested ones as dotted paths (`portrait.image.width`,
up to 3 steps; a struct is not entered again inside itself).

| Type | Members | Writable |
|---|---|---|
| struct | its fields, with their types | yes (Set member returns a copy with the field replaced) |
| `image` | `url: text` (the uri), `mime: text`, `extension: text` (from the file name, else the mime type), `name: text?` (`meta.filename`), `size: int?` (bytes), `width: int?`, `height: int?` | no |
| `video` | as image, plus `duration: float?` (seconds), `fps: float?` | no |
| `audio` | url, mime, extension, name, size, `duration: float?` | no |
| `file`, `model3d` | url, mime, extension, name, size | no |
| `error` | `code: text`, `message: text`, `node: text?`, `nodeId: text?` | no |
| `text`, `list<T>` | `length: int` (text: code points) | no |
| `T?` | the members of `T`, each optional (`none` when the value is none) | no |
| others (`int`, `float`, `boolean`, `json`, `secret`, enums) | none | — |

- A path is writable when every step is a struct field. Media metadata is read-only: the bytes
  belong to the media store, and image processing nodes make new images instead.
- Reading a missing step (a `none` value, an absent field) gives `none`; an absent struct field
  with a default gives the default.
- Both nodes are pure. Config `{ type: TypeRef, path: "a.b" }`; Get member has input `value`
  and one output named after the last step; Set member has inputs `value` and `to` and output
  `value`. A path that does not exist, or Set on a read-only member, leaves the node without
  ports (`config.invalid` with the list of members).

