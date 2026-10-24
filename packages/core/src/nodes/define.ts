/**
 * Node definition API (docs/specs/node-api.md §1–§6).
 */
import type { FieldDecl, FlowVariable, GlobalVariable, TypeDecl } from "../documents/model.js";
import { NodeDefinitionError } from "../errors.js";
import type { TypeSpec, UnknownValue } from "../types/builder.js";
import { isTypeSpec } from "../types/builder.js";
import { createTypeScope } from "../types/scope.js";
import { isValidEnumValue, isValidFieldName, isValidNodeType, RESERVED_FIELD_NAMES } from "../util/names.js";
import { capitalize, titleFromNodeType } from "../util/titles.js";
import { checkValue } from "../values/validate.js";
import type { ConfigField, ConfigFieldKind, ConfigMap, ConfigValues } from "./config.js";
import type { NodeRunArgs } from "./exec.js";

/** UI hint for an input port's constant widget. */
export type PortWidget = "textarea" | "slider" | "color" | "password";

/** Header accent colors (design-system.md). */
export type NodeColor = "mint" | "lavender" | "peach" | "sky" | "pink" | "yellow";

/** A port with metadata. */
export interface PortOptions<V = UnknownValue> {
  type: TypeSpec<V>;
  /** Default: the port name split into words (`maxTokens` → "Max tokens"). */
  title?: string;
  description?: string;
  /** Inputs only: used when unconnected and without a constant. Validated at definition time. */
  default?: V;
  widget?: PortWidget;
}

/** A port: a bare `TypeSpec` or a spec with metadata. */
export type Port<V = UnknownValue> = TypeSpec<V> | PortOptions<V>;

/** Map of port name → port. */
export type PortMap = Record<string, Port>;

/** Static value type of one port. */
export type PortValue<P> =
  P extends TypeSpec<infer V> ? V
  : P extends { type: TypeSpec<infer V> } ? V
  : never;

/** Readonly map of port name → value. `{}` (no static ports) widens to `Record<string, UnknownValue>`. */
export type PortValues<P> = [keyof P] extends [never]
  ? Readonly<Record<string, UnknownValue>>
  : { readonly [K in keyof P]: PortValue<P[K]> };

/** Output ports whose value may be `null`. */
type NullableKeys<O> = { [K in keyof O]: null extends PortValue<O[K]> ? K : never }[keyof O];
type NonNullableKeys<O> = Exclude<keyof O, NullableKeys<O>>;

/**
 * What `run` returns: every output port; ports whose type allows `null` may be omitted.
 * No static ports → `Record<string, UnknownValue>` (dynamic ports).
 */
export type NodeOutputs<O> = [keyof O] extends [never]
  ? Record<string, UnknownValue>
  : { [K in NonNullableKeys<O>]: PortValue<O[K]> } & { [K in NullableKeys<O>]?: PortValue<O[K]> };

/** Retry policy (runtime.md §5). */
export interface RetryPolicy {
  /** Total attempts including the first. Default 1. */
  maxAttempts: number;
  /** Default 500. */
  initialDelayMs?: number;
  /** Default 2. */
  factor?: number;
  /** Default 10 000. */
  maxDelayMs?: number;
  /** Default true: delay × random in [0.5, 1). */
  jitter?: boolean;
}

/** What `resolvePorts` sees of the node's surroundings. */
export interface PortScope {
  readonly flow: {
    readonly id: string;
    readonly inputs: readonly FieldDecl[];
    readonly outputs: readonly FieldDecl[];
    readonly variables: readonly FlowVariable[];
  };
  readonly globals: readonly GlobalVariable[];
  /** Local → global → pack. */
  resolveType(id: string): TypeDecl | undefined;
}

/** Returned by `resolvePorts` when the config cannot produce ports (`node.ports_unresolved`). */
export interface PortError {
  error: { code: string; message: string };
}

/** Ports computed by `resolvePorts`; they replace the static ones. */
export interface DynamicPorts {
  inputs?: PortMap;
  outputs?: PortMap;
}

/** Argument of `resolvePorts`. */
export interface ResolvePortsArgs<C> {
  config: C;
  scope: PortScope;
}

/** `T` or a promise of `T`. */
export type MaybePromise<T> = T | Promise<T>;

/** Output keys returned by `run` that are not declared output ports. */
export type ExtraOutputKeys<R, O> = Exclude<keyof Awaited<R>, keyof O>;

/**
 * Compile-time check used by {@link defineNode}: `unknown` when `run` returns only declared
 * outputs (or the node has dynamic outputs), otherwise an object type whose missing property
 * names the unknown ports in the error message.
 */
export type CheckOutputKeys<R, O> = [keyof O] extends [never]
  ? unknown
  : [ExtraOutputKeys<R, O>] extends [never]
    ? unknown
    : { "run() returns unknown output ports": ExtraOutputKeys<R, O> };

/**
 * Everything a developer writes in `defineNode`. Only `type` and `run` are required.
 * `R` is the inferred return type of `run` (checked against the declared outputs).
 */
export interface NodeDefinitionInput<
  I extends PortMap,
  O extends PortMap,
  C extends ConfigMap,
  R extends MaybePromise<NodeOutputs<O>> = MaybePromise<NodeOutputs<O>>,
> {
  /** `<namespace>.<name>`, e.g. `openai.chat`. */
  type: string;
  /** Default: derived from the type (`openai.chatCompletion` → "Chat completion"). */
  title?: string;
  /** Default `""`. */
  description?: string;
  /** Default: the namespace, capitalized. */
  category?: string;
  /** Lucide icon name. */
  icon?: string;
  color?: NodeColor;
  inputs?: I;
  outputs?: O;
  config?: C;
  /** Secret names the node needs. */
  secrets?: readonly string[];
  /** Default `true`. `false` for non-deterministic or side-effecting nodes. */
  cache?: boolean;
  /** Default `"1"`. Bump to invalidate cached results. */
  cacheVersion?: string;
  /** Per attempt. Default 300 000; `0` = none. */
  timeoutMs?: number;
  /** `n` = up to n+1 attempts with default backoff. Default 0. */
  retry?: number | RetryPolicy;
  /** Max simultaneous executions of this node type per engine. Default unlimited. */
  concurrency?: number;
  /** Palette message; the node still runs. */
  deprecated?: string;
  /**
   * A frontend node: its effect happens in the viewer (the studio), not on the server, e.g.
   * printing to the studio console. The engine runs it like any node (its `run` is usually
   * a no-op); when it completes, the viewer rebuilds its inputs from the run (wired sources'
   * outputs, typed values, defaults) and does the work. Editors mark these nodes.
   */
  frontend?: boolean;
  /**
   * A pure node has no execution line: it only computes outputs from inputs (conversions,
   * operators, templates, variable GET). It runs when a node on the execution line needs one
   * of its outputs. Default false: the node sits on the execution line (in → then).
   */
  pure?: boolean;
  /**
   * The node can fail on purpose (network, model, file errors): it gets a second outgoing
   * execution line, `failed`, and an `error` output that holds why. Default false.
   */
  canFail?: boolean;
  /**
   * A conversion node turns a value of one type into another (As text, As int, …). It must be
   * pure, have static ports, one output, and take the converted value on its first input
   * (any other input needs a default). Editors insert it on their own when a wire joins two
   * types it converts between (`findConversions`).
   */
  conversion?: boolean;
  /** Pure, synchronous, deterministic. Replaces static ports when present. */
  resolvePorts?(args: ResolvePortsArgs<ConfigValues<C>>): DynamicPorts | PortError;
  /** Only on nodes with variants (see {@link VariantNodeDefinitionInput}). */
  variants?: undefined;
  /** The work. Returning a missing, ill-typed or undeclared output is a compile error. */
  run(args: NodeRunArgs<PortValues<I>, ConfigValues<C>>): R;
}

/**
 * A validated node definition with every default applied. Created by {@link defineNode}.
 */
export interface NodeDefinition<I extends PortMap = PortMap, O extends PortMap = PortMap, C extends ConfigMap = ConfigMap> {
  readonly kind: "nodeDefinition";
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly icon?: string;
  readonly color?: NodeColor;
  readonly inputs: I;
  readonly outputs: O;
  readonly config: C;
  readonly secrets: readonly string[];
  readonly cache: boolean;
  readonly cacheVersion: string;
  readonly timeoutMs: number;
  /** Normalized: `retry: 2` → `{ maxAttempts: 3 }`. */
  readonly retry: RetryPolicy;
  readonly concurrency?: number;
  readonly deprecated?: string;
  /** Set (true) on frontend nodes only; see {@link NodeDefinitionInput.frontend}. */
  readonly frontend?: true;
  /** Set (true) on pure nodes only; see {@link NodeDefinitionInput.pure}. */
  readonly pure?: true;
  /** Set (true) on nodes with a `failed` line; see {@link NodeDefinitionInput.canFail}. */
  readonly canFail?: true;
  /** Set (true) on conversion nodes; see {@link NodeDefinitionInput.conversion}. */
  readonly conversion?: true;
  /** On a node with variants: the variant this definition is (each variant is a full definition). */
  readonly variant?: string;
  /** On a node with variants: the selector and every variant (the same object on each of them). */
  readonly variants?: NodeVariants;
  resolvePorts?(args: ResolvePortsArgs<ConfigValues<C>>): DynamicPorts | PortError;
  run(args: NodeRunArgs<PortValues<I>, ConfigValues<C>>): MaybePromise<NodeOutputs<O>>;
}

/** What one variant declares: its own ports, config and `run` (see {@link variant}). */
export interface VariantInput<
  I extends PortMap,
  O extends PortMap,
  C extends ConfigMap,
  R extends MaybePromise<NodeOutputs<O>> = MaybePromise<NodeOutputs<O>>,
> {
  /** Shown in the variant dropdown. Default: the variant name. */
  title?: string;
  description?: string;
  /** The variant still works; editors steer away from it. */
  deprecated?: string;
  inputs?: I;
  outputs?: O;
  config?: C;
  resolvePorts?(args: ResolvePortsArgs<ConfigValues<C>>): DynamicPorts | PortError;
  run(args: NodeRunArgs<PortValues<I>, ConfigValues<C>>): R;
}

/** A variant made by {@link variant}, with its static types erased. */
export interface NodeVariantDefinition extends VariantInput<PortMap, PortMap, ConfigMap> {
  readonly kind: "nodeVariant";
}

/** The `variants` field of `defineNode`. */
export interface VariantsInput {
  /** Label of the selector, e.g. "Model". Default "Variant". */
  title?: string;
  description?: string;
  /** Variant of new nodes. Default: the first option. */
  default?: string;
  /** Variant name (`gpt-image-1`, `fast`) → variant. Order is the dropdown order. */
  options: Record<string, NodeVariantDefinition>;
}

/** `defineNode` input of a node with variants: shared settings plus `variants`. */
export type VariantNodeDefinitionInput = Omit<
  NodeDefinitionInput<PortMap, PortMap, ConfigMap>,
  "inputs" | "outputs" | "config" | "run" | "resolvePorts" | "conversion" | "variants"
> & { variants: VariantsInput; inputs?: never; outputs?: never; config?: never; run?: never };

/** The selector and the variants of a node type (on every variant's definition). */
export interface NodeVariants {
  readonly title: string;
  readonly description?: string;
  readonly default: string;
  readonly options: readonly NodeVariantInfo[];
}

/** One variant of a node type. */
export interface NodeVariantInfo {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly deprecated?: string;
  /** The full definition of the node in this variant. */
  readonly definition: AnyNodeDefinition;
}

/** A node definition with its static types erased (catalogs, packs). */
export type AnyNodeDefinition = NodeDefinition<PortMap, PortMap, ConfigMap>;

/** Typed input values of a definition. @example `type In = InputsOf<typeof slugify>;` */
export type InputsOf<D> = D extends { readonly inputs: infer I } ? PortValues<I> : never;

/** Normalized output values of a definition (every key present, omitted optionals as `null`). */
export type OutputsOf<D> = D extends { readonly outputs: infer O } ? PortValues<O> : never;

/** Typed config values of a definition. */
export type ConfigOf<D> = D extends { readonly config: infer C } ? ConfigValues<C> : never;

/**
 * Defines a node. Validates names, ports, defaults and config at definition time and throws
 * `NodeDefinitionError` (`node_def.invalid`) with a message naming the node type and field.
 *
 * A node with `variants` (instead of `inputs` / `outputs` / `config` / `run`) is a family of
 * shapes under one type: each {@link variant} has its own ports, config and `run`, and the
 * placed node picks one (node-api.md §1.2).
 *
 * @example
 * ```ts
 * export const shout = defineNode({
 *   type: "words.shout",
 *   inputs: { text: t.text(), marks: { type: t.int({ min: 0, max: 5 }), default: 1 } },
 *   outputs: { text: t.text() },
 *   run: ({ inputs }) => ({ text: inputs.text.toUpperCase() + "!".repeat(inputs.marks) }),
 * });
 * ```
 */
export function defineNode<
  I extends PortMap = Record<never, never>,
  O extends PortMap = Record<never, never>,
  C extends ConfigMap = Record<never, never>,
  const R extends MaybePromise<NodeOutputs<O>> = MaybePromise<NodeOutputs<O>>,
>(def: (NodeDefinitionInput<I, O, C, R> & CheckOutputKeys<R, O>) | VariantNodeDefinitionInput): NodeDefinition<I, O, C> {
  const input = def as unknown as NodeDefinitionInput<PortMap, PortMap, ConfigMap> & { variants?: VariantsInput };
  const type = input.type;
  if (typeof type !== "string" || !isValidNodeType(type)) {
    throw new NodeDefinitionError(
      `defineNode "${String(type)}": type must look like "<namespace>.<name>" (lowercase namespace, then a camelCase name, e.g. "words.shout").`,
    );
  }
  const fail = (what: string): never => {
    throw new NodeDefinitionError(`defineNode "${type}": ${what}`);
  };
  const base = commonDefinition(input, fail);
  if (input.variants !== undefined) return defineVariants(base, input as unknown as VariantNodeDefinitionInput & Record<string, unknown>, fail) as NodeDefinition<I, O, C>;
  const shape = checkShape(type, input, input.canFail === true, fail);
  if (input.conversion !== undefined && typeof input.conversion !== "boolean") fail("conversion must be true or false.");
  if (input.conversion === true) checkConversion(input.inputs ?? {}, input.outputs ?? {}, input.pure === true, input.resolvePorts !== undefined, fail);
  const out: AnyNodeDefinition = { ...base, ...shape };
  if (input.conversion === true) (out as { conversion?: true }).conversion = true;
  return out as NodeDefinition<I, O, C>;
}

type Fail = (what: string) => never;

/** Internal: everything of a definition except its shape (ports, config, run). */
export type CommonDefinition = Omit<AnyNodeDefinition, "inputs" | "outputs" | "config" | "run" | "resolvePorts" | "conversion" | "variant" | "variants">;
type Shape = Pick<AnyNodeDefinition, "inputs" | "outputs" | "config" | "run" | "resolvePorts">;

function commonDefinition(input: Omit<NodeDefinitionInput<PortMap, PortMap, ConfigMap>, "run">, fail: Fail): CommonDefinition {
  const type = input.type;
  for (const key of ["title", "description", "category", "icon", "cacheVersion", "deprecated"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") fail(`${key} must be a string.`);
  }
  if (input.color !== undefined && !NODE_COLORS.includes(input.color)) fail(`color must be one of ${NODE_COLORS.join(", ")}.`);
  if (input.cache !== undefined && typeof input.cache !== "boolean") fail("cache must be true or false.");
  if (input.frontend !== undefined && typeof input.frontend !== "boolean") fail("frontend must be true or false.");
  if (input.pure !== undefined && typeof input.pure !== "boolean") fail("pure must be true or false.");
  if (input.canFail !== undefined && typeof input.canFail !== "boolean") fail("canFail must be true or false.");
  if (input.pure === true && input.canFail === true) fail("a pure node has no execution line, so it cannot have a failed line (canFail). Drop one of them.");
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) fail("timeoutMs must be a whole number >= 0 (0 = no timeout).");
  if (input.concurrency !== undefined && (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1)) {
    fail("concurrency must be a whole number >= 1.");
  }
  const secrets = input.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((x) => typeof x !== "string" || x === "")) fail("secrets must be a list of secret names.");
  const retry = normalizeRetry(type, input.retry);
  const namespace = type.split(".")[0] ?? type;
  const out: CommonDefinition = {
    kind: "nodeDefinition",
    type,
    title: input.title ?? titleFromNodeType(type),
    description: input.description ?? "",
    category: input.category ?? capitalize(namespace),
    secrets: [...secrets],
    cache: input.cache ?? true,
    cacheVersion: input.cacheVersion ?? "1",
    timeoutMs,
    retry,
  };
  const o = out as { -readonly [K in keyof CommonDefinition]: CommonDefinition[K] };
  if (input.icon !== undefined) o.icon = input.icon;
  if (input.color !== undefined) o.color = input.color;
  if (input.concurrency !== undefined) o.concurrency = input.concurrency;
  if (input.deprecated !== undefined) o.deprecated = input.deprecated;
  if (input.frontend === true) o.frontend = true;
  if (input.pure === true) o.pure = true;
  if (input.canFail === true) o.canFail = true;
  return out;
}

/** Checks and copies the shape (ports, config, run) of a node or one of its variants. */
function checkShape(where: string, input: Partial<Shape> & { inputs?: PortMap; outputs?: PortMap; config?: ConfigMap }, canFail: boolean, fail: Fail): Shape {
  if (typeof input.run !== "function") fail("run must be a function.");
  if (input.resolvePorts !== undefined && typeof input.resolvePorts !== "function") fail("resolvePorts must be a function.");
  checkPorts(where, "input", input.inputs ?? {}, true);
  checkPorts(where, "output", input.outputs ?? {}, false);
  checkConfig(where, input.config ?? {});
  if (canFail && input.outputs && "error" in input.outputs) fail('canFail adds an "error" output; rename your own "error" output.');
  const shape: Shape = {
    inputs: input.inputs ?? {},
    outputs: input.outputs ?? {},
    config: input.config ?? {},
    run: input.run as AnyNodeDefinition["run"],
  };
  if (input.resolvePorts !== undefined) shape.resolvePorts = input.resolvePorts;
  return shape;
}

function defineVariants(base: CommonDefinition, input: VariantNodeDefinitionInput & Record<string, unknown>, fail: Fail): AnyNodeDefinition {
  for (const key of ["inputs", "outputs", "config", "run", "resolvePorts"] as const) {
    if (input[key] !== undefined) fail(`a node with variants declares ${key} on each variant, not on the node.`);
  }
  if (input["conversion"] === true) fail("a conversion node cannot have variants.");
  const v = input.variants;
  if (typeof v !== "object" || v === null || typeof v.options !== "object" || v.options === null) fail("variants must be { options: { name: variant({ … }) } }.");
  const sel = v as VariantsInput;
  for (const key of ["title", "description", "default"] as const) {
    if (sel[key] !== undefined && typeof sel[key] !== "string") fail(`variants.${key} must be a string.`);
  }
  const options: VariantOption[] = [];
  for (const [name, option] of Object.entries(sel.options)) {
    const vfail = (what: string): never => fail(`variant "${name}": ${what}`);
    if (!isValidEnumValue(name)) vfail("is not a valid variant name (letters, digits, _ . -; e.g. gpt-image-1).");
    if (typeof option !== "object" || option === null || (option as { kind?: unknown }).kind !== "nodeVariant") vfail("must be made with variant({ … }).");
    for (const key of ["title", "description", "deprecated"] as const) {
      if (option[key] !== undefined && typeof option[key] !== "string") vfail(`${key} must be a string.`);
    }
    const shape = checkShape(`${input.type}" variant "${name}`, option, base.canFail === true, vfail);
    options.push({ name, title: option.title ?? name, ...(option.description === undefined ? {} : { description: option.description }), ...(option.deprecated === undefined ? {} : { deprecated: option.deprecated }), shape });
  }
  if (options.length === 0) fail("variants.options needs at least one variant.");
  const fallback = sel.default ?? (options[0] as VariantOption).name;
  if (!options.some((o) => o.name === fallback)) fail(`variants.default "${fallback}" is not one of ${options.map((o) => o.name).join(", ")}.`);
  return linkVariants(base, { title: sel.title ?? "Variant", ...(sel.description === undefined ? {} : { description: sel.description }), default: fallback }, options);
}

/** Internal: one variant before linking. */
export interface VariantOption {
  name: string;
  title: string;
  description?: string;
  deprecated?: string;
  shape: Shape;
}

/**
 * Internal (define, descriptors): builds one definition per variant from the shared fields and
 * links them through one {@link NodeVariants}. Returns the default variant's definition.
 */
export function linkVariants(
  base: CommonDefinition,
  selector: { title: string; description?: string; default: string },
  options: readonly VariantOption[],
): AnyNodeDefinition {
  const infos: NodeVariantInfo[] = [];
  const variants: NodeVariants = { ...selector, options: infos };
  for (const o of options) {
    const definition: AnyNodeDefinition = { ...base, ...o.shape, variant: o.name, variants };
    if (o.deprecated !== undefined) (definition as { deprecated?: string }).deprecated = o.deprecated;
    const info: NodeVariantInfo = { name: o.name, title: o.title, definition };
    if (o.description !== undefined) (info as { description?: string }).description = o.description;
    if (o.deprecated !== undefined) (info as { deprecated?: string }).deprecated = o.deprecated;
    infos.push(info);
  }
  return (infos.find((i) => i.name === selector.default) as NodeVariantInfo).definition;
}

/**
 * Defines one variant of a node: its ports, config and `run`, typed like `defineNode`. Shared
 * ports are plain objects spread into each variant.
 *
 * @example
 * ```ts
 * const prompt = { prompt: t.text() };
 * defineNode({
 *   type: "img.generate",
 *   variants: {
 *     title: "Model",
 *     options: {
 *       fast: variant({ inputs: prompt, outputs: { image: t.image() }, run: async ({ inputs }) => ({ image: await fast(inputs.prompt) }) }),
 *       best: variant({ inputs: { ...prompt, steps: t.int() }, outputs: { image: t.image() }, run: async ({ inputs }) => ({ image: await best(inputs) }) }),
 *     },
 *   },
 * });
 * ```
 */
export function variant<
  I extends PortMap = Record<never, never>,
  O extends PortMap = Record<never, never>,
  C extends ConfigMap = Record<never, never>,
  const R extends MaybePromise<NodeOutputs<O>> = MaybePromise<NodeOutputs<O>>,
>(def: VariantInput<I, O, C, R> & CheckOutputKeys<R, O>): NodeVariantDefinition {
  return { ...(def as VariantInput<I, O, C, R>), kind: "nodeVariant" } as unknown as NodeVariantDefinition;
}

/**
 * The variant of `def` named `name` (`undefined` = the default one), or `undefined` when there
 * is no such variant. A node type without variants only answers `undefined` → itself.
 *
 * @example
 * ```ts
 * variantDefinition(openaiImage, "dall-e-3")?.inputs; // the DALL·E 3 ports
 * ```
 */
export function variantDefinition(def: AnyNodeDefinition, name: string | undefined): AnyNodeDefinition | undefined {
  if (!def.variants) return name === undefined ? def : undefined;
  return def.variants.options.find((o) => o.name === (name ?? def.variants?.default))?.definition;
}

function checkConversion(inputs: PortMap, outputs: PortMap, pure: boolean, dynamic: boolean, fail: (what: string) => never): void {
  if (!pure) fail("a conversion node must be pure (pure: true).");
  if (dynamic) fail("a conversion node needs static ports (no resolvePorts).");
  const ins = Object.entries(inputs);
  if (ins.length === 0) fail("a conversion node needs an input: the value it converts.");
  if (Object.keys(outputs).length !== 1) fail("a conversion node has exactly one output.");
  for (const [name, port] of ins.slice(1)) {
    const parts = portParts(port);
    if (!parts || !("default" in parts)) fail(`conversion input "${name}" needs a default; only the first input takes the converted value.`);
  }
}

const NODE_COLORS: readonly NodeColor[] = ["mint", "lavender", "peach", "sky", "pink", "yellow"];
const PORT_WIDGETS: readonly PortWidget[] = ["textarea", "slider", "color", "password"];
const CONFIG_KINDS: readonly ConfigFieldKind[] = ["text", "int", "boolean", "choice", "type", "typeId", "flowVariable", "global"];
const DEFINITION_SCOPE = createTypeScope({});

function normalizeRetry(type: string, retry: number | RetryPolicy | undefined): RetryPolicy {
  if (retry === undefined) return { maxAttempts: 1 };
  if (typeof retry === "number") {
    if (!Number.isSafeInteger(retry) || retry < 0) {
      throw new NodeDefinitionError(`defineNode "${type}": retry must be a whole number >= 0 or a retry policy.`);
    }
    return { maxAttempts: retry + 1 };
  }
  if (typeof retry !== "object" || retry === null || !Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new NodeDefinitionError(`defineNode "${type}": retry.maxAttempts must be a whole number >= 1.`);
  }
  for (const key of ["initialDelayMs", "factor", "maxDelayMs"] as const) {
    const v = retry[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new NodeDefinitionError(`defineNode "${type}": retry.${key} must be a number >= 0.`);
    }
  }
  return { ...retry };
}

/** Internal: the spec and metadata of a port, or `undefined` when malformed. */
export function portParts(port: unknown): (PortOptions & { spec: TypeSpec }) | undefined {
  if (isTypeSpec(port)) return { type: port, spec: port };
  if (typeof port === "object" && port !== null && isTypeSpec((port as { type?: unknown }).type)) {
    const p = port as PortOptions;
    return { ...p, spec: p.type };
  }
  return undefined;
}

function checkPorts(type: string, side: "input" | "output", ports: PortMap, isInput: boolean): void {
  if (typeof ports !== "object" || ports === null || Array.isArray(ports)) {
    throw new NodeDefinitionError(`defineNode "${type}": ${side}s must be an object of port name → type.`);
  }
  for (const [name, port] of Object.entries(ports)) {
    const where = `defineNode "${type}": ${side} "${name}"`;
    if (RESERVED_FIELD_NAMES.includes(name)) throw new NodeDefinitionError(`${where} uses a reserved name. Choose another port name.`);
    if (!isValidFieldName(name)) {
      throw new NodeDefinitionError(`${where} is not a valid port name (use letters, digits and _; start with a letter or _).`);
    }
    const parts = portParts(port);
    if (!parts) throw new NodeDefinitionError(`${where} must be a type from t (e.g. t.text()) or { type, title?, default? }.`);
    if (parts.title !== undefined && typeof parts.title !== "string") throw new NodeDefinitionError(`${where}: title must be a string.`);
    if (parts.description !== undefined && typeof parts.description !== "string") {
      throw new NodeDefinitionError(`${where}: description must be a string.`);
    }
    if (parts.widget !== undefined && !PORT_WIDGETS.includes(parts.widget)) {
      throw new NodeDefinitionError(`${where}: widget must be one of ${PORT_WIDGETS.join(", ")}.`);
    }
    if (Object.prototype.hasOwnProperty.call(port, "default") && parts.default !== undefined) {
      if (!isInput) throw new NodeDefinitionError(`${where} has a default, but output ports cannot have defaults.`);
      const r = checkValue(parts.default, parts.spec.ref, DEFINITION_SCOPE, {
        path: "default",
        lenientUnknownNamed: true,
        lenientVars: true,
      });
      const first = r.diagnostics[0];
      if (first) throw new NodeDefinitionError(`${where} has an invalid default: ${first.message}.`);
    }
  }
}

function checkConfig(type: string, config: ConfigMap): void {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new NodeDefinitionError(`defineNode "${type}": config must be an object of key → cfg field.`);
  }
  for (const [name, field] of Object.entries(config) as [string, ConfigField][]) {
    const where = `defineNode "${type}": config "${name}"`;
    const fail = (what: string): never => {
      throw new NodeDefinitionError(`${where} ${what}`);
    };
    if (RESERVED_FIELD_NAMES.includes(name) || !isValidFieldName(name)) {
      fail("is not a valid config key (use letters, digits and _; start with a letter or _).");
    }
    if (typeof field !== "object" || field === null || !CONFIG_KINDS.includes(field.kind)) fail("must be a field from cfg (e.g. cfg.text()).");
    const d = field.default;
    if (field.kind === "int") {
      if (field.min !== undefined && !Number.isSafeInteger(field.min)) fail("has a min that is not a whole number.");
      if (field.max !== undefined && !Number.isSafeInteger(field.max)) fail("has a max that is not a whole number.");
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) fail(`has min (${field.min}) greater than max (${field.max}).`);
    }
    if (field.kind === "choice") {
      const choices = field.choices ?? [];
      if (choices.length === 0) fail("needs at least one choice.");
      if (new Set(choices).size !== choices.length) fail("has duplicate choices.");
      if (choices.some((c) => typeof c !== "string")) fail("choices must be strings.");
    }
    if (d === undefined) continue;
    switch (field.kind) {
      case "text":
        if (typeof d !== "string") fail(`has default ${JSON.stringify(d)}, which is not text.`);
        break;
      case "int":
        if (!Number.isSafeInteger(d)) fail(`has default ${JSON.stringify(d)}, which is not a whole number.`);
        if (field.min !== undefined && (d as number) < field.min) fail(`has default ${String(d)} below min ${field.min}.`);
        if (field.max !== undefined && (d as number) > field.max) fail(`has default ${String(d)} above max ${field.max}.`);
        break;
      case "boolean":
        if (typeof d !== "boolean") fail(`has default ${JSON.stringify(d)}, which is not true or false.`);
        break;
      case "choice":
        if (!(field.choices ?? []).includes(d as string)) {
          fail(`has default ${JSON.stringify(d)}, which is not one of the choices ${(field.choices ?? []).join(", ")}.`);
        }
        break;
      default:
        if (typeof d !== "string" && field.kind !== "type") fail(`has default ${JSON.stringify(d)}, which is not an id.`);
        break;
    }
  }
}
