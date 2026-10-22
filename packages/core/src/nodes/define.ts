/**
 * Node definition API (docs/specs/node-api.md §1–§6).
 */
import type { FieldDecl, FlowVariable, GlobalVariable, TypeDecl } from "../documents/model.js";
import { NodeDefinitionError } from "../errors.js";
import type { TypeSpec, UnknownValue } from "../types/builder.js";
import { isTypeSpec } from "../types/builder.js";
import { createTypeScope } from "../types/scope.js";
import { isValidFieldName, isValidNodeType, RESERVED_FIELD_NAMES } from "../util/names.js";
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
  /** Pure, synchronous, deterministic. Replaces static ports when present. */
  resolvePorts?(args: ResolvePortsArgs<ConfigValues<C>>): DynamicPorts | PortError;
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
  resolvePorts?(args: ResolvePortsArgs<ConfigValues<C>>): DynamicPorts | PortError;
  run(args: NodeRunArgs<PortValues<I>, ConfigValues<C>>): MaybePromise<NodeOutputs<O>>;
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
>(def: NodeDefinitionInput<I, O, C, R> & CheckOutputKeys<R, O>): NodeDefinition<I, O, C> {
  const input = def as NodeDefinitionInput<I, O, C, R>;
  const type = input.type;
  if (typeof type !== "string" || !isValidNodeType(type)) {
    throw new NodeDefinitionError(
      `defineNode "${String(type)}": type must look like "<namespace>.<name>" (lowercase namespace, then a camelCase name, e.g. "words.shout").`,
    );
  }
  const fail = (what: string): never => {
    throw new NodeDefinitionError(`defineNode "${type}": ${what}`);
  };
  if (typeof input.run !== "function") fail("run must be a function.");
  if (input.resolvePorts !== undefined && typeof input.resolvePorts !== "function") fail("resolvePorts must be a function.");
  checkPorts(type, "input", input.inputs ?? {}, true);
  checkPorts(type, "output", input.outputs ?? {}, false);
  checkConfig(type, input.config ?? {});
  for (const key of ["title", "description", "category", "icon", "cacheVersion", "deprecated"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") fail(`${key} must be a string.`);
  }
  if (input.color !== undefined && !NODE_COLORS.includes(input.color)) fail(`color must be one of ${NODE_COLORS.join(", ")}.`);
  if (input.cache !== undefined && typeof input.cache !== "boolean") fail("cache must be true or false.");
  const timeoutMs = input.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) fail("timeoutMs must be a whole number >= 0 (0 = no timeout).");
  if (input.concurrency !== undefined && (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1)) {
    fail("concurrency must be a whole number >= 1.");
  }
  const secrets = input.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((x) => typeof x !== "string" || x === "")) fail("secrets must be a list of secret names.");
  const retry = normalizeRetry(type, input.retry);
  const namespace = type.split(".")[0] ?? type;
  const out: NodeDefinition<I, O, C> = {
    kind: "nodeDefinition",
    type,
    title: input.title ?? titleFromNodeType(type),
    description: input.description ?? "",
    category: input.category ?? capitalize(namespace),
    inputs: (input.inputs ?? {}) as I,
    outputs: (input.outputs ?? {}) as O,
    config: (input.config ?? {}) as C,
    secrets: [...secrets],
    cache: input.cache ?? true,
    cacheVersion: input.cacheVersion ?? "1",
    timeoutMs,
    retry,
    run: input.run as NodeDefinition<I, O, C>["run"],
  };
  if (input.icon !== undefined) (out as { icon?: string }).icon = input.icon;
  if (input.color !== undefined) (out as { color?: NodeColor }).color = input.color;
  if (input.concurrency !== undefined) (out as { concurrency?: number }).concurrency = input.concurrency;
  if (input.deprecated !== undefined) (out as { deprecated?: string }).deprecated = input.deprecated;
  if (input.resolvePorts !== undefined) out.resolvePorts = input.resolvePorts;
  return out;
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
