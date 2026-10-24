# Spec: Node definition API

Status: draft v1 (phase 0). Owner: ux-designer. Implemented in `@briarflow/core` (API,
catalog, descriptors), `@briarflow/nodes-std` and `@briarflow/nodes-mock` (phase 3).

Goal: a developer writes one file per node, readable top to bottom, with full type inference
and no boilerplate. Everything has a sensible default.

## Deviations from ARCHITECTURE.md

1. **`config` fields and the `cfg` builder** are added to `defineNode`. ARCH mentions
   `NodeInstance.config` and `resolvePorts` but not how a definition declares its config. The
   declaration is needed for validation (`node.add`), descriptors and editor widgets.
2. **Pack namespaces.** A node type is `<namespace>.<name>`. By default the namespace must be
   the pack name; a pack may claim extra namespaces with `namespaces: [...]`. The std pack is
   named `briar` and claims `text`, `list`, `convert`. Reason: keeps `briar.input` and
   `text.template` (both in ARCH) while giving a checkable naming rule.
3. **`text.template` uses a config template.** ARCH §4.8 shows `template`/`values` inputs as an
   illustration. The std node instead takes `config.template` and creates one input port per
   `{placeholder}` (see §9). Reason: named placeholders map to named ports; the ARCH version
   needed positional lists.
4. **`ExecContext`**: `globals`/`variables` are read-only (see variables.md); added
   `attempt`, `secrets` limited to declared names, `fetch` and `resolveType` (§6). `NodeRunArgs` also carries
   the validated `config` (same as `node.config`, but typed).

---

## 1. `defineNode`

```ts
function defineNode<I extends PortMap, O extends PortMap, C extends ConfigMap = {}>(
  def: NodeDefinitionInput<I, O, C>,
): NodeDefinition<I, O, C>;
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | `string` | **required** | `<namespace>.<name>`, regex `^[a-z][a-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$`, e.g. `openai.chat`, `briar.variable.get` |
| `title` | `string` | derived from **every segment after the namespace**, split into words, first letter capitalized: `openai.chatCompletion` → `"Chat completion"`, `briar.variable.get` → `"Variable get"`, `text.template` → `"Template"` (DECISIONS #36) | Shown in palette and node header. Std nodes set explicit titles. |
| `description` | `string` | `""` | One or two sentences. Markdown not rendered in v1. |
| `category` | `string` | the namespace, capitalized | Palette group (`"Text"`, `"Image"`, `"AI"`…) |
| `icon` | `string` | none | Name from the studio icon set (lucide names) |
| `color` | `"mint" \| "lavender" \| "peach" \| "sky" \| "pink" \| "yellow"` | by category | Header accent (design-system.md) |
| `inputs` | `Record<string, Port>` | `{}` | See §2 |
| `outputs` | `Record<string, Port>` | `{}` | See §2 |
| `config` | `Record<string, ConfigField>` | `{}` | See §4 |
| `resolvePorts` | `(args) => ResolvedPorts` | none | See §5 |
| `secrets` | `string[]` | `[]` | Secret names the node needs (`"OPENAI_API_KEY"`) |
| `cache` | `boolean` | `true` | `false` for non-deterministic or side-effecting nodes |
| `cacheVersion` | `string` | `"1"` | Bump to invalidate cached results when `run` logic changes without a pack version bump |
| `timeoutMs` | `number` | `300_000` (5 min) | Per attempt. `0` = no timeout |
| `retry` | `number \| RetryPolicy` | `0` retries | `retry: 2` = up to 3 attempts with default backoff (runtime.md §5) |
| `concurrency` | `number` | unlimited | Max simultaneous executions of this node type per engine |
| `deprecated` | `string` | none | Message shown in the palette; node still runs |
| `pure` | `boolean` | `false` | No execution line; runs when a node on the line reads it (execution.md) |
| `canFail` | `boolean` | `false` | Adds the `failed` line and the `error` output |
| `conversion` | `boolean` | `false` | A conversion node (§1.1) |
| `variants` | `VariantsInput` | none | A node with variants (§1.2). Replaces `inputs`, `outputs`, `config`, `resolvePorts` and `run` |
| `run` | `(args: NodeRunArgs) => Promise<Outputs> \| Outputs` | **required** (unless `variants`) | The work |

Validation at definition time throws `NodeDefinitionError` (code `node_def.invalid`) with a
message naming the node type and field: e.g.
`defineNode "text.tmpl": input "Template" is not a valid port name (use letters, digits and _; start with a letter or _).`

### 1.1 Conversion nodes (2026-10-24)

A conversion node turns one value into another type: As text, As int, As JSON, … It is a
first-class kind, not a naming habit:

- `conversion: true` requires `pure: true`, static ports (no `resolvePorts`), exactly one
  output, and at least one input. The **first** input takes the converted value; every other
  input needs a default (e.g. Float to int's rounding `mode`).
- Descriptors carry `conversion: true`.
- `findConversions(catalog, from, to)` (core) lists the conversion nodes that take a `from`
  value and give a value assignable to `to`, best first: an input of exactly `from`, then a
  widening input, then a generic limited by `oneOf` (types.md §5), then a free generic.
- Editors use it: joining two ports whose types do not fit, but convert, inserts the best
  conversion node between them (one undo step: `node.add` + two `edge.connect`). A generic
  input limited by `oneOf` that refuses the source tries each `oneOf` type as the target.
- Conversions are single steps: no chains are searched.

### 1.2 Variants (2026-10-24)

A node with **variants** is one node type with several shapes. The placed node picks one in a
dropdown (`Model ▾`); the pick decides its ports, its config fields and the code that runs.
OpenAI image is one node with a variant per model (`gpt-image-2.5-flare`, `gpt-image-2`,
`gpt-image-1.5`, …): the 2.5 models take quality up to `max` and any custom size, the
deprecated 1.x models only the fixed sizes and quality up to `high`.

```ts
const prompt = { prompt: t.text({ multiline: true }) };   // shared ports are plain objects

export const generate = defineNode({
  type: "img.generate",
  title: "Generate image",
  canFail: true,                     // node-level: everything except the shape
  variants: {
    title: "Model",                  // dropdown label; default "Variant"
    default: "fast",                 // variant of new nodes; default: the first
    options: {
      fast: variant({
        title: "Fast",               // default: the variant name
        description: "Quick drafts.",
        inputs: prompt,
        outputs: { image: t.image() },
        run: async ({ inputs, ctx }) => ({ image: await draft(inputs.prompt, ctx) }),
      }),
      best: variant({
        title: "Best",
        config: { steps: cfg.int({ min: 1, max: 50, default: 20 }) },
        inputs: { ...prompt, negative: t.optional(t.text()) },
        outputs: { image: t.image(), seed: t.int() },
        run: async ({ inputs, config, ctx }) => render(inputs, config.steps, ctx),
      }),
    },
  },
});
```

Rules:

- **Shape on the variant, the rest on the node.** A variant declares `inputs`, `outputs`,
  `config`, optionally `resolvePorts`, and `run`, typed like `defineNode` (a wrong output is
  a compile error inside the variant). `title`, `description` and `deprecated` describe it in
  the dropdown. Everything else (`type`, `title`, `category`, `pure`, `canFail`, `frontend`,
  `cache`, `retry`, `timeoutMs`, `secrets`, …) is the node's and shared by every variant, so
  the execution ports (`in`, `then`, `failed`) never change with the pick. A node with
  `variants` that also declares a shape fails with `node_def.invalid`; so do no options, a bad
  variant name, an unknown `default`, an option not made with `variant()`, and
  `conversion: true` (conversions are single-shaped, §1.1).
- **Variant names** follow enum-member rules (`gpt-image-1`, `dall-e-3`, `fast`); they are
  stored in documents, so renaming one is a breaking change for saved flows.
- **Shared ports are spread**, not inherited: each variant lists all its ports. Ports with the
  same name and a fitting type keep their wires and constants when the pick changes.
- **One definition per variant.** `defineNode` returns the default variant's definition;
  every variant's definition is a full `NodeDefinition` with `variant: "<name>"` and the same
  `variants` object (`{ title, description?, default, options: [{ name, title, description?,
  deprecated?, definition }] }`). Code that does not know about variants (a palette, a
  descriptor reader) sees the default variant. `variantDefinition(def, name)` and
  `nodeDefinition(catalog, node)` (core) give the definition a placed node uses.
- **Documents.** `NodeInstance.variant` holds the pick. `node.add` stores it on every node of a
  type with variants (the default when not given), so changing a pack's `default` never moves
  saved nodes. A node without `variant` uses the default; a variant the type does not have
  gives the error diagnostic `node.unknown_variant` (no ports, edges kept, like an unknown
  type) and the command error of the same code.
- **Switching** is the command `node.setVariant` (commands.md §7): config the new variant
  shares (same key and kind, still valid) is kept, the rest dropped; wires and constants of
  ports the new variant does not have are removed in the same undo step.
- **Validation and runs** use the variant's definition: config is checked against its fields,
  `run` is its `run`, and the cache key includes the variant (runtime.md §6).
- **Descriptors** carry `variants: { title, description?, default, options: [{ name, title,
  description?, deprecated, inputs, outputs, config, dynamicPorts }] }`; the top-level
  `inputs`/`outputs`/`config` are the default variant's. `definitionFromDescriptor` rebuilds
  every variant, so editors without the pack's code resolve them exactly.
- **Editors** show the dropdown under the node header and in the inspector; dropping a wire
  on empty canvas offers each variant whose ports fit ("OpenAI image · DALL·E 3").
- **Testing:** `runNode(def, inputs, { variant: "best" })`; `describeNodePack` checks every
  variant's names and port types and takes `variant` in samples.

When to use variants and when `resolvePorts` (§5): variants for a **known, finite** set of
shapes chosen by the user (models, modes, providers); `resolvePorts` for ports **computed from
data** (a template's placeholders, a list's length, a struct's fields). A variant may have
its own `resolvePorts`.

**Planned: nested variants.** One selector per node in v1. Shapes that depend on two choices
(model × mode) are flattened into one list (`gpt-image-1 · edit`) until nested selectors land
(OPEN_QUESTIONS Q-NODE-10).

## 2. Ports

A port is either a `TypeSpec` or an object:

```ts
type Port<V> = TypeSpec<V> | {
  type: TypeSpec<V>;
  title?: string;          // default: port name split into words ("maxTokens" → "Max tokens")
  description?: string;
  default?: V;             // used when the input is unconnected and has no constant
  widget?: "textarea" | "slider" | "color" | "password";   // UI hint, optional
};
```

- Port names follow field-name rules (types.md §1). Inputs and outputs are separate
  namespaces (a node may have input `image` and output `image`).
- `default` is validated against the type when the node is defined (`defineNode` throws
  `NodeDefinitionError`, code `node_def.invalid`, naming node, port and the value message).
  **Known v1 limit:** the TypeScript types do not reject a `default` of the wrong type at
  compile time (e.g. `{ type: t.int(), default: "3" }` type-checks); the runtime check at
  definition time is the guarantee. Accepted for v1 — every pack is loaded (and its tests run)
  before a node can be used, so the error surfaces immediately on import.
- **Input value resolution order** at run time: edge → instance constant (`NodeInstance.values`)
  → port `default` → the empty value of the type (`emptyValue`: `""`, `0` moved into
  `min`/`max`, `false`, `[]`; `null` for structs, enums, media, optionals and generics). An
  empty input never blocks a run, and a `null` input is passed to `run` unchecked.
- Output ports may not have defaults.

## 3. The `t` builder

```ts
t.text({ minLength?, maxLength?, pattern?, multiline? })   // TypeSpec<string>
t.int({ min?, max? })                                     // TypeSpec<number>
t.float({ min?, max? })                                   // TypeSpec<number>
t.boolean()                                               // TypeSpec<boolean>
t.image({ formats?, maxBytes?, minWidth?, maxWidth?, minHeight?, maxHeight? })  // TypeSpec<MediaRef>
t.video({ formats?, maxBytes?, maxDurationSec? })  t.audio(...)  t.model3d(...)  t.file(...)
t.list(item, { minItems?, maxItems? })                    // TypeSpec<readonly V[]>
t.optional(inner)                                         // TypeSpec<V | null>
t.ref("Character")  t.ref("openai.ChatMessage")           // TypeSpec<UnknownValue> (or typed, see below)
t.ref(chatMessageType)                                    // TypeSpec<ChatMessage> from a defineStruct value
t.var("T")                                                // TypeSpec<UnknownValue>, generic
t.parse("list<Character?>")                               // shorthand → TypeSpec<UnknownValue>
t.fromRef(typeRef)                                        // IR → TypeSpec<UnknownValue>

type UnknownValue = string | number | boolean | object | null;   // exported by core
```

**Static inference expectations** (tested with `expectTypeOf` in core tests):

```ts
const def = defineNode({
  type: "demo.x",
  inputs: { a: t.text(), b: { type: t.optional(t.int()), default: null }, c: t.list(t.image()) },
  outputs: { out: t.text() },
  run({ inputs }) {
    inputs.a;   // string
    inputs.b;   // number | null
    inputs.c;   // readonly MediaRef[]
    return { out: "ok" };          // return type must be { out: string }
  },
});
type In  = InputsOf<typeof def>;   // { a: string; b: number | null; c: readonly MediaRef[] }
type Out = OutputsOf<typeof def>;  // { out: string }
```

- Returning a missing key, an extra key or a wrong type is a **compile error**; at run time the
  engine checks again (`node.invalid_output`), because JS callers and dynamic ports bypass TS.
- `run`'s return type is inferred as a `const` type parameter and checked against `outputs`,
  so a **missing**, **ill-typed** or **undeclared** output key is a compile error
  (DECISIONS #24). Enum literals keep their literal type (`{ role: "user" }` stays `"user"`).
- **Values are immutable.** List values are typed `readonly V[]`; struct values arrive as
  plain objects — do not mutate inputs, return new values. (Returning a mutable array where a
  `readonly` one is expected is fine.)
- `t.ref("Name")`, `t.var`, `t.parse` and `t.fromRef` are `UnknownValue` statically (any JSON
  value: `string | number | boolean | object | null`), not `unknown`: `unknown` as the port
  value constraint made TypeScript widen enum literals returned from `run`. Narrow with a
  check before use. Use `t.ref(structValue)` with a value from `defineStruct` to get a typed
  field object.
- `t.ref("Role")` / `defineStruct("ChatMessage", …)` hold the **bare** name until
  `definePack` qualifies it (`words.Role`); outside a pack a bare name is resolved in the
  document scope like any shorthand. A bare pack-type name stored in a document is
  `type.unknown_id` (DECISIONS #25).

## 4. Config fields: the `cfg` builder

Config is node-instance data that **shapes the node** (its ports or behaviour) and is set in
the node inspector rather than wired. Values must be JSON.

```ts
cfg.text({ default?, multiline?, title?, description? })
cfg.int({ min?, max?, default? })
cfg.boolean({ default? })
cfg.choice(["round", "floor", "ceil"], { default? })
cfg.type({ title? })                         // a TypeRef (shorthand accepted in commands)
cfg.typeId({ kind: "struct" | "enum" | "any" })
cfg.flowVariable()                           // a variable id of the node's flow
cfg.global({ writable?: boolean })           // a global id; writable:true rejects readonly globals
```

Every field is required unless it has a `default` or `{ optional: true }`. Validation errors
use `config.invalid` / `config.unknown_ref` (commands.md §7).

Use an **input port** for anything a user may want to wire; use **config** only when the value
changes the ports, or when wiring it makes no sense (a template string that defines ports).

## 5. Dynamic ports: `resolvePorts`

```ts
resolvePorts?(args: {
  config: C;                      // validated config
  scope: PortScope;               // see below
}): { inputs?: Record<string, Port>; outputs?: Record<string, Port> } | PortError;

interface PortScope {
  flow: { inputs: FieldDecl[]; outputs: FieldDecl[]; variables: FlowVariable[] };
  globals: GlobalVariable[];
  resolveType(id: string): TypeDecl | undefined;   // local → global → pack
}
interface PortError { error: { code: string; message: string } }
```

- When present, its result **replaces** the static `inputs`/`outputs` (static ones are used
  for the descriptor only; they are **not** a fallback when resolution fails).
- Must be **pure, synchronous and deterministic**; it runs in authoring (browser and server)
  after every relevant command.
- Returning `PortError` (or throwing) makes the node show an error diagnostic
  (`node.ports_unresolved`) with that message. Invalid config (`config.invalid` /
  `config.unknown_ref`) on a node with `resolvePorts` has the same effect without calling it
  (a static-port node with invalid config keeps its static ports). In both cases the
  node has **no ports**; its edges and constants are kept, and the edges are **not**
  additionally reported as `edge.unknown_port` — the node-level diagnostic explains them
  (DECISIONS #34; commands.md §9).
- `run()` receives inputs keyed by the resolved port names; for a node with no static
  inputs their static type is `Readonly<Record<string, UnknownValue>>`.
- Descriptors carry `dynamicPorts: true`. A client that has the definition's code (nodes-std
  is a shared package) resolves locally; otherwise the editor waits for the server result
  (see OPEN_QUESTIONS Q-NODE-1).

## 6. `run`, ExecContext, errors, progress

```ts
interface NodeRunArgs<I, C> { inputs: I; config: C; node: NodeInstance; ctx: ExecContext }

interface ExecContext {
  signal: AbortSignal;                 // aborted on cancel or timeout
  runId: string; flowId: string; nodeId: string;
  attempt: number;                     // 1-based
  progress(fraction: number, message?: string): void;
  log: Logger;                         // tagged with runId/nodeId
  media: NodeMedia;                    // put / link (transient, owned by the run), entry, read (media.md §4)
  secrets: {
    get(name: string): Promise<string>;              // only names listed in `secrets` (resolver / env)
    read(ref: SecretRef): Promise<string>;           // a vault secret the node was given (secrets.md)
  };
  settings: { get(name: string): Promise<unknown> }; // the node's pack settings (settings.md)
  globals: { get(name: string): unknown };           // run-start snapshot
  variables: { get(name: string): unknown };         // run-start values
  fetch: typeof fetch;                 // injectable; already bound to `signal` if you pass none
  resolveType(id: string): TypeDecl | undefined;     // flow scope: local → global → pack
}
```

- **Type lookup.** `ctx.resolveType(id)` returns the declaration of a struct/enum type visible
  in the node's flow (same lookup as `scope.resolveType` in `resolvePorts`), or `undefined`.
  Use it when `run` needs a type's fields, e.g. a node configured with `cfg.typeId(...)`
  (`mock.structured`, structured-output provider nodes). Pending in core (REQ-6); until then
  the engine provides it and `@briarflow/runtime` exports `EngineExecContext`.
- **Inputs are checked for you.** Before `run`, every input is normalized and validated
  against its resolved port type (constraints included; struct field defaults filled), so
  `run` can trust its inputs' shape. Ports whose type has an unbound generic are not checked.

- **Secrets.** Before the first attempt the engine resolves every declared secret; a missing
  one fails the node with `node.missing_secret` (not retried):
  `Node {title} needs secret "{name}". Set it in your secrets provider (e.g. env var {name}).`
  `ctx.secrets.get` of an undeclared name throws `node.secret_not_declared`.
- **Vault secrets.** `ctx.secrets.read(ref)` returns the value of a vault secret. A node may
  only read names it was given: the value of one of its `secret` inputs (also inside
  optionals and lists), or a `secret` setting of its pack it read with `ctx.settings.get`.
  Anything else → `node.secret_not_allowed`; a name missing from the vault →
  `node.missing_secret`. Never put a revealed value in an output or a log.
- **Settings.** `ctx.settings.get(name)` returns the stored value of the pack's setting
  `name`, else its declared default, else `null`. An undeclared name → `node.unknown_setting`.
- **Progress.** `fraction` is clamped to `[0, 1]`; NaN ignored. Messages ≤ 200 chars
  (truncated). The engine throttles `node.progress` events to one per 100 ms per node (the
  latest wins; nothing is sent after the node completes).
- **Errors.** Throw `NodeError` for expected failures:

```ts
class NodeError extends BriarError {
  constructor(code: string, message: string, options?: { retryable?: boolean; details?: unknown; cause?: unknown });
}
```

Standard codes (use these before inventing new ones; pack-specific ones are `<pack>.<reason>`):

| Code | retryable default | Use when |
|---|---|---|
| `node.invalid_input` | no | input is valid by type but unusable (e.g. image cannot be decoded) |
| `node.failed` | no | generic failure; also what any non-`NodeError` exception becomes |
| `node.rate_limited` | **yes** | provider said 429 / slow down; set `details.retryAfterMs` if known |
| `node.unavailable` | **yes** | network error, 5xx, provider overloaded |
| `node.timeout` | yes | set by the engine on timeout |
| `node.cancelled` | no | set by the engine on cancellation |
| `node.missing_secret` | no | set by the engine |
| `node.invalid_output` | no | set by the engine when outputs fail type checks |
| `node.content_refused` | no | provider safety refusal |
| `node.secret_not_allowed` | no | set by the engine: `ctx.secrets.read` of a name the node was not given |
| `node.unknown_setting` | no | set by the engine: `ctx.settings.get` of an undeclared setting |

Non-`NodeError` exceptions are wrapped as `node.failed` with the original message; a
`TypeError` from `fetch` (network failure) is wrapped as `node.unavailable` (retryable).

- **Cancellation.** Pass `ctx.signal` to every `fetch`/SDK call. When the signal aborts, throw
  (any error); the engine reports `node.cancelled` / `node.timeout`. Ignoring the signal is
  tolerated: the engine stops waiting after a grace period (runtime.md §4).
- **Outputs.** Return an object with every output port. Optional outputs may be omitted
  (become `null`). Media outputs: store bytes with `ctx.media.put(bytes, { mime, filename?,
  meta? })` and return the `{ mediaId }` it gives. Read media inputs with
  `ctx.media.read(inputs.image)` and their mime / size with `ctx.media.entry(inputs.image)`.

## 7. Packs and pack types

```ts
const Role = defineEnum("Role", ["system", "user", "assistant"], { description: "Who speaks" });
const ChatMessage = defineStruct("ChatMessage", {
  role: t.ref(Role),
  content: t.text(),
  name: { type: t.optional(t.text()), description: "Optional speaker name" },
});

export const openaiPack = definePack({
  name: "openai",                     // pack name regex ^[a-z][a-z0-9_]*$
  version: "0.1.0",                   // semver; part of the cache key
  title: "OpenAI",
  description: "Chat, structured output and images via the OpenAI API.",
  namespaces: [],                     // extra node-type namespaces (default none)
  types: [Role, ChatMessage],         // ids become "openai.Role", "openai.ChatMessage"
  nodes: [chat, structured, image],
  settings: {                         // keys "openai.textKey", … (settings.md)
    textKey: { type: t.optional(t.secret({ kind: "apiKey" })), title: "Key for text" },
  },
});
```

- Inside a pack, `t.ref("Role")` resolves first to the pack's own types.
- Pack types may reference primitives and types from the same pack only (v1).
- `definePack` throws `pack.invalid` on: node type outside the pack's namespaces, duplicate
  node types, duplicate type names, unresolved refs.
- `NodeCatalog` (`createCatalog([packs])`) throws `catalog.duplicate_pack` (same name twice),
  `catalog.namespace_conflict` (two packs claim a namespace). The namespace `briar` is
  reserved for `@briarflow/nodes-std`.

### Descriptors

`toNodeDescriptor(def, pack)` → JSON (used by `GET /node-types` and the Python manifest).
`pack` is `{ name, version }` of the pack the definition belongs to (a definition does not
know its pack; `catalog.descriptors()` passes it):

```json
{
  "type": "text.template", "pack": { "name": "briar", "version": "1.0.0" },
  "title": "Text template", "description": "…", "category": "Text", "icon": "text", "color": "mint",
  "inputs":  [ { "name": "…", "type": { "kind": "…" }, "title": "…", "description": "…", "default": null, "widget": null } ],
  "outputs": [ { "name": "text", "type": { "kind": "primitive", "name": "text" }, "title": "Text" } ],
  "config":  [ { "name": "template", "kind": "text", "required": true, "multiline": true, "title": "Template" } ],
  "dynamicPorts": true, "secrets": [], "cache": true, "timeoutMs": 300000,
  "retry": { "maxAttempts": 1 }, "concurrency": null, "deprecated": null
}
```

Nodes with variants add `"variants": { "title": "Model", "default": "gpt-image-1", "options":
[ { "name": "dall-e-3", "title": "DALL·E 3", "deprecated": null, "inputs": [ … ], "outputs":
[ … ], "config": [ … ], "dynamicPorts": false }, … ] }` (§1.2).

Ports are arrays (to keep order). `default` and `description` are omitted when absent;
`widget` is omitted or `null` when absent; `icon`, `color`, `concurrency` and `deprecated`
are `null` when absent. Descriptors are plain JSON (`JSON.parse(JSON.stringify(d))` deep-equals
`d`).

## 8. Naming conventions

- Node type: `<namespace>.<verbOrNoun>` in camelCase after the dot: `openai.chat`,
  `image.resize`, `text.join`, `convert.toText`. Sub-groups with more dots are fine:
  `briar.variable.get`.
- Titles: sentence case, no namespace: "Resize image", not "Image.Resize".
- Ports: camelCase nouns (`prompt`, `maxTokens`, `image`); booleans as adjectives/questions
  (`transparent`, `isFinal`). Single-output nodes name the output after what it is (`text`,
  `image`), not `result` (Python's default `result` is fine for Python).
- Errors: `<pack>.<snake_reason>` (`openai.context_too_long`).

## 9. Std nodes (`@briarflow/nodes-std`, pack `briar`, phase 3)

All std nodes are deterministic and cached unless marked `cache: false`.

**Built-in nodes live in core (DECISIONS #23).** `briar.input` and `briar.output` are listed
below for completeness but are **not** defined by `@briarflow/nodes-std` and are **not**
catalog entries (`catalog.get("briar.input")` is `undefined`; they are not in
`descriptors()` or `GET /node-types`, and the palette never offers them). Core knows them:
`resolveFlowPorts` derives their ports from the flow signature, validation works without
nodes-std loaded, and the runtime executes them itself. The `briar` namespace stays reserved
for nodes-std, which defines everything else in this table. In messages and the editor the
built-ins are labelled **"Input"** and **"Output"** (DECISIONS #36).

| Type | Config | Inputs | Outputs | Notes |
|---|---|---|---|---|
| `briar.input` | — | — | one per flow input | **core built-in**; emits run inputs (defaults applied); never cached |
| `briar.output` | — | one per flow output | — | **core built-in**; its inputs become `RunResult.outputs`; never cached |
| `briar.variable.get` | `variableId: cfg.flowVariable()` | — | `value: V` | see variables.md; `cache:false` |
| `briar.variable.set` | `variableId` | `value: V` | `value: V` | `cache:false` |
| `briar.global.get` | `globalId: cfg.global()` | — | `value: G` | `cache:false` |
| `briar.global.set` | `globalId: cfg.global({writable:true})` | `value: G` | `value: G` | `cache:false` |
| `briar.struct.make` | `typeId: cfg.typeId({kind:"struct"})` | one per field (field type; field default as port default) | `value: S` | |
| `briar.struct.break` | `typeId` | `value: S` | one per field | |
| `briar.member.get` ("Get .path") | `type: cfg.type()`, `path: cfg.text()` | `value: <type>` | one, named after the last step, the member's type | `value.path` (types.md §12); offered from a dropped wire, not the palette |
| `briar.member.set` ("Set .path") | same | `value: <type>`, `to: <member type>` | `value: <type>` | copy with the struct field replaced; only struct fields (types.md §12) |
| `debug.print` ("Print") | — | `text: text`, `browserConsole: boolean` (false) | — | frontend node: the studio writes the text to its console |
| `debug.image` ("View image") | — | `image: image`, `label: text?` | — | frontend node on the execution line: the studio shows the image on the node (double-click: viewer) and as a console line with mime, size and bytes; reading it makes the pure image nodes before it run |
| `briar.constant` | `type: cfg.type()` | `value: <type>` (set as constant) | `value: <type>` | identity when wired |
| `text.template` (title "Template builder") | `template: cfg.text({multiline:true})` | one port per distinct `{{name}}`, in order of first appearance: generic (synthetic type var `T1`, `T2`, … by order of first appearance) or `json` when any slot reads a field path of it (`{{user.address.city}}`, `{{items[0]}}`); `{{$(name)}}` reads a flow variable, else a global, and adds no port | `text: text` | `cache:false` (it reads variables). Values rendered with toText rules; a field path that does not exist → `NodeError("json.field_missing")`; `\{{` is a literal `{{`, single braces are plain text; bad slot → `PortError` `text.invalid_placeholder`, unclosed `{{` → `text.invalid_template`, unknown variable → `text.unknown_variable`. Variables are read at run start (like `ctx.variables`); use a Get variable node and a port for a value written earlier in the same run |
| `text.join` | — | `items: list<text>`, `separator: text` (default `""`) | `text: text` | |
| `list.make` | `count: cfg.int({min:0,max:32,default:2})` | `item1…itemN: $T` | `list: list<$T>` | |
| `list.length` | — | `list: list<$T>` | `length: int` | |
| `list.get` | — | `list: list<$T>`, `index: int` | `item: $T?` | negative index counts from the end; out of range → `null` |
| `convert.toText` (title "As text") | — | `value: $T` | `text: text` | conversion; never fails; rules below |
| `convert.asJson` | — | `text: text` | `json: json` | conversion; the text as it is, **not parsed**: fields are parsed when read (Get field, Set field, templates) |
| `convert.asInt` / `convert.asFloat` | — | `value: $T` with `oneOf: [text, json]` | `value: int` / `float` | conversion; json is read through its text (As text), then trimmed and parsed; invalid → `convert.invalid_number` |
| `convert.asBoolean` | — | `value: $T` | `value: boolean` | conversion; never fails: `null`, `false`, `0`, NaN and text `""`/`false`/`0`/`no`/`off`/`null` (trimmed, any case) → false; everything else (lists, structs, media) → true |
| `convert.asJsonArray` (title "As JSON array") | — | `value: $T` with `oneOf: [text, json]` | `items: list<json>` | conversion; text is parsed; not an array → `json.wrong_kind`, bad JSON → `json.invalid_json` |
| `convert.floatToInt` | — | `value: float`, `mode: briar.RoundingMode` (default `round`) | `value: int` | conversion; `round` = half away from zero |
| `json.construct` | — | `value: json` (default `{}`, edited in the JSON editor) | `json: json` | |
| `json.getField` | — | `json: json`, `path: text` | `value: json` | path `a.b[0].c`, `[1]` for a root array, `""` = the whole value; missing → `json.field_missing`, bad path → `json.invalid_path`; a string met on the way is JSON text and is parsed there, bad JSON → `json.invalid_json` |
| `json.setField` | — | `json`, `path`, `value: json` | `json: json` | replaces or adds; creates missing objects on the way; an index may be one past the end (append) |
| `json.addField` | — | `json`, `path`, `value: json`, `overwrite: boolean` (default false) | `json: json` | existing field and `overwrite` off → `json.field_exists` |

Pack types: `briar.RoundingMode` enum: `round`, `floor`, `ceil`, `trunc`.

**toText rules:** text as is; int/float via JS `String()`; boolean `"true"`/`"false"`; enum →
member value; `null` → `""`; media → its `uri`; struct/list → `JSON.stringify` with stable key
order and no spaces; json → a string as is, anything else as its JSON text (same stable order).

## 10. Mock nodes (`@briarflow/nodes-mock`, pack `mock`)

Deterministic, offline, no secrets. `hash(x)` = sha-256 hex of the UTF-8 canonical JSON of x.

| Type | Inputs | Outputs | Behaviour |
|---|---|---|---|
| `mock.llm` | `prompt: text`, `system: text?`, `seed: int` (0), `delayMs: int` (0) | `text: text` | `"Mock reply " + hash({system,prompt,seed}).slice(0,8) + ": " + first 200 chars of prompt`. Reports progress 0.5 then 1 while waiting `delayMs` (respects signal). |
| `mock.structured` | config `typeId: cfg.typeId({kind:"struct"})`; inputs `prompt: text`, `seed: int` (0) | `value: S` | Fills the struct deterministically from `hash({prompt,seed,path})`: text → `"<field> <4 hex>"` (respecting maxLength), int → value in `[min,max]` (default 0–99), float same /100, boolean → even/odd, enum → member by index, list → `minItems` or 2 items, optional → value (but `null` for an optional `video`), media: `image`/`file` → a 64×64 mock SVG (`image/svg+xml`), `model3d` → the glTF cube of `mock.model3d`, `audio` → a short silent WAV (`audio/wav`), required `video` → `mock.unsupported_type`; all stored via `ctx.media.put`. Unknown type id → `mock.unknown_type`. |
| `mock.image` | `prompt: text`, `width: int` (512, 1–4096), `height: int` (512), `seed: int` (0) | `image: image` | SVG (`image/svg+xml`) with background color from `hash({prompt, seed})`, 3 rectangles, and the first 60 chars of the prompt as text; `meta.width/height` set; stored via `ctx.media.put`. |
| `mock.model3d` | `prompt: text`, `seed: int` (0) | `model: model3d` | minimal glTF 2.0 JSON cube (`model/gltf+json`), material color from the hash. |
| `mock.delay` | `value: $T`, `ms: int` (1000) | `value: $T` | waits, honours cancellation; `cache:false`. For cancellation tests. |
| `mock.flaky` | `failures: int` (1), `value: text` ("ok") | `value: text` | Fails the first `failures` attempts of each execution with `node.unavailable` (retryable), then succeeds. `retry: 3`, `cache:false`. For retry tests. |
| `mock.fail` | `message: text` ("Mock failure") | `value: text` | Always throws `NodeError("mock.failed", message)`. |

## 10b. Image nodes (`@briarflow/nodes-image`, pack `image`)

Pure, cached. Read PNG and JPEG inputs (other formats → `image.unsupported_format`), work on
8-bit RGBA, store a new image (config `format: png | jpeg`, `quality` for JPEG; PNG drops the
alpha channel when every pixel is opaque) with `meta.width/height`. Up to 64 MP
(`image.invalid_size` beyond, or for sizes below 1×1). Pure JavaScript codecs (fast-png,
jpeg-js); no native modules. Decoded pixels are kept in memory by media id (256 MB, least
recently used dropped), and the PNGs the pack makes leave their pixels there, so a chain of
image nodes decodes each image once.

| Type | Variants / config | Inputs | Outputs | Notes |
|---|---|---|---|---|
| `image.make` | variants `rgba`, `rgb`, `color` | rgba/rgb: `red`, `green`, `blue` (`alpha`) images; color: `width`, `height` (1024), `red`, `green`, `blue` (0), `alpha` (255) as 0–255 ints | `image` | channel images use their brightness (gray images from Split channels); sizes must match (`image.size_mismatch`) |
| `image.split` | variants `rgba`, `rgb` | `image` | `red`, `green`, `blue` (`alpha`): gray PNGs | inverse of Make image |
| `image.resize` | `fit: contain \| cover \| stretch` | `image`, `width: int?`, `height: int?` | `image` | one size empty keeps the aspect ratio; area average when shrinking, bilinear when growing, alpha-weighted |
| `image.crop` | — | `image`, `x`, `y` (0), `width`, `height` | `image` | outside the image → `image.invalid_size` |
| `image.transform` | `op: rotate90 \| rotate180 \| rotate270 \| flipHorizontal \| flipVertical` | `image` | `image` | clockwise |
| `image.grayscale` / `image.invert` | — | `image` | `image` | Rec. 601 luma / 255 − value; alpha kept |
| `image.convert` | — | `image` | `image` | re-encodes as `format` |

## 11. Example node files

### 11.1 A simple node

```ts
// packages/nodes-text-extra/src/slugify.ts
import { defineNode, t } from "@briarflow/core";

export const slugify = defineNode({
  type: "textx.slugify",
  title: "Slugify",
  category: "Text",
  description: "Turns any text into a URL-safe slug: lowercase, dashes, no accents.",
  inputs: {
    text: t.text(),
    maxLength: { type: t.int({ min: 1, max: 200 }), default: 60, description: "Longer slugs are cut at a dash." },
  },
  outputs: {
    slug: t.text({ pattern: "[a-z0-9-]*" }),
  },
  run({ inputs }) {
    const slug = inputs.text
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return { slug: cut(slug, inputs.maxLength) };
  },
});

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const lastDash = head.lastIndexOf("-");
  return lastDash > 0 ? head.slice(0, lastDash) : head;
}
```

### 11.2 A provider node with secrets, retries, progress and media

```ts
// packages/nodes-acme/src/generate-image.ts
import { defineNode, NodeError, t } from "@briarflow/core";
import { Size } from "./types.js";   // export const Size = defineEnum("Size", ["square", "portrait", "landscape"]);

export const generateImage = defineNode({
  type: "acme.generateImage",
  title: "Generate image",
  category: "Image",
  icon: "image",
  color: "peach",
  description: "Creates an image from a prompt with the ACME image API.",
  secrets: ["ACME_API_KEY"],
  cache: true,                 // same prompt + seed → reuse the stored image
  retry: 2,                    // rate limits and 5xx are retried with backoff
  timeoutMs: 120_000,
  concurrency: 2,              // the API allows 2 parallel requests
  inputs: {
    prompt: { type: t.text({ multiline: true, maxLength: 4000 }), widget: "textarea" },
    size: { type: t.ref(Size), default: "square" },
    seed: { type: t.optional(t.int({ min: 0 })), default: null },
  },
  outputs: {
    image: t.image({ formats: ["png"] }),
  },
  async run({ inputs, ctx }) {
    const key = await ctx.secrets.get("ACME_API_KEY");
    ctx.progress(0.1, "Sending request");
    const res = await ctx.fetch("https://api.acme.test/v1/images", {
      method: "POST",
      signal: ctx.signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: inputs.prompt, size: inputs.size, seed: inputs.seed }),
    });
    if (res.status === 429) {
      throw new NodeError("node.rate_limited", "ACME rate limit reached. The request will be retried.", {
        retryable: true,
        details: { retryAfterMs: Number(res.headers.get("retry-after") ?? 1) * 1000 },
      });
    }
    if (!res.ok) {
      throw new NodeError("acme.request_failed", `ACME answered ${res.status}: ${await res.text()}`, {
        retryable: res.status >= 500,
      });
    }
    ctx.progress(0.8, "Saving image");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const image = await ctx.media.put(bytes, { mime: "image/png", filename: "acme.png" });
    return { image };
  },
});
```

### 11.3 A dynamic-port node with config

```ts
// packages/nodes-std/src/struct-make.ts
import { cfg, defineNode, t } from "@briarflow/core";

export const structMake = defineNode({
  type: "briar.struct.make",
  title: "Make struct",
  category: "Data",
  description: "Builds a struct value from one input per field.",
  config: {
    typeId: cfg.typeId({ kind: "struct", title: "Struct" }),
  },
  inputs: {},                                  // replaced by resolvePorts
  outputs: { value: t.var("S") },
  resolvePorts({ config, scope }) {
    const decl = scope.resolveType(config.typeId);
    if (!decl || decl.kind !== "struct") {
      return { error: { code: "config.unknown_ref", message: "Pick a struct type for this node." } };
    }
    const inputs = Object.fromEntries(
      decl.fields.map((f) => [f.name, { type: t.fromRef(f.type), description: f.description, default: f.default }]),
    );
    return { inputs, outputs: { value: t.fromRef({ kind: "named", id: decl.id }) } };
  },
  run({ inputs }) {
    return { value: { ...inputs } };           // the engine validates the struct value
  },
});
```

(`t.fromRef(ref)` wraps an IR `TypeRef` as a `TypeSpec<unknown>`.)
