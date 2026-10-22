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
| `run` | `(args: NodeRunArgs) => Promise<Outputs> \| Outputs` | **required** | The work |

Validation at definition time throws `NodeDefinitionError` (code `node_def.invalid`) with a
message naming the node type and field: e.g.
`defineNode "text.tmpl": input "Template" is not a valid port name (use letters, digits and _; start with a letter or _).`

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
  → port `default` → `null` if the type is optional → validation error `input.unconnected`.
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
  media: MediaStore;
  secrets: { get(name: string): Promise<string> };   // only names listed in `secrets`
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

Non-`NodeError` exceptions are wrapped as `node.failed` with the original message; a
`TypeError` from `fetch` (network failure) is wrapped as `node.unavailable` (retryable).

- **Cancellation.** Pass `ctx.signal` to every `fetch`/SDK call. When the signal aborts, throw
  (any error); the engine reports `node.cancelled` / `node.timeout`. Ignoring the signal is
  tolerated: the engine stops waiting after a grace period (runtime.md §4).
- **Outputs.** Return an object with every output port. Optional outputs may be omitted
  (become `null`). Media outputs: store bytes with `ctx.media.put(...)` and return the
  `MediaRef`.

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
| `briar.constant` | `type: cfg.type()` | `value: <type>` (set as constant) | `value: <type>` | identity when wired |
| `text.template` | `template: cfg.text({multiline:true})` | one generic port per distinct `{name}` placeholder, in order of first appearance | `text: text` | values rendered with toText rules; `{{` / `}}` are literal braces; placeholder names follow port-name rules, invalid ones → `PortError`; each port gets its own type var with a **synthetic** name `T1`, `T2`, … by order of first appearance (placeholder names may break var-name rules `^[A-Z][A-Za-z0-9]*$`, ≤ 16 chars) |
| `text.join` | — | `items: list<text>`, `separator: text` (default `""`) | `text: text` | |
| `list.make` | `count: cfg.int({min:0,max:32,default:2})` | `item1…itemN: $T` | `list: list<$T>` | |
| `list.length` | — | `list: list<$T>` | `length: int` | |
| `list.get` | — | `list: list<$T>`, `index: int` | `item: $T?` | negative index counts from the end; out of range → `null` |
| `convert.toText` | — | `value: $T` | `text: text` | rules below |
| `convert.parseInt` | — | `text: text` | `value: int` | trims; invalid → `NodeError("convert.invalid_number")` |
| `convert.parseFloat` | — | `text: text` | `value: float` | same |
| `convert.floatToInt` | — | `value: float`, `mode: briar.RoundingMode` (default `round`) | `value: int` | `round` = half away from zero |

Pack types: `briar.RoundingMode` enum: `round`, `floor`, `ceil`, `trunc`.

**toText rules:** text as is; int/float via JS `String()`; boolean `"true"`/`"false"`; enum →
member value; `null` → `""`; media → its `uri`; struct/list → `JSON.stringify` with stable key
order and no spaces.

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
