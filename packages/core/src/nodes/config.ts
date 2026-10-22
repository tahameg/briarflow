/**
 * Node config fields and the `cfg` builder (docs/specs/node-api.md §4).
 */
import type { TypeRef } from "../types/ir.js";

/** Kinds of config fields. */
export type ConfigFieldKind = "text" | "int" | "boolean" | "choice" | "type" | "typeId" | "flowVariable" | "global";

/** Phantom key carrying the static config value type. */
declare const configValueKey: unique symbol;

/**
 * One config field. `V` is the static value type (`V | undefined` for optional fields
 * without a default). Values are JSON.
 */
export interface ConfigField<V = unknown> {
  readonly kind: ConfigFieldKind;
  /** `true` unless the field has a default or `optional: true`. */
  readonly required: boolean;
  readonly default?: V;
  readonly title?: string;
  readonly description?: string;
  /** `text` only. */
  readonly multiline?: boolean;
  /** `int` only. */
  readonly min?: number;
  readonly max?: number;
  /** `choice` only. */
  readonly choices?: readonly string[];
  /** `typeId` only. */
  readonly typeKind?: "struct" | "enum" | "any";
  /** `global` only: `true` rejects readonly globals (`variable.write_to_readonly`). */
  readonly writable?: boolean;
  readonly [configValueKey]?: V;
}

/** Map of config key → field. */
export type ConfigMap = Record<string, ConfigField>;

/** Static value of one config field. */
export type ConfigFieldValue<F> = F extends ConfigField<infer V> ? V : never;

type RequiredConfigKeys<C> = { [K in keyof C]: undefined extends ConfigFieldValue<C[K]> ? never : K }[keyof C];
type OptionalConfigKeys<C> = { [K in keyof C]: undefined extends ConfigFieldValue<C[K]> ? K : never }[keyof C];

/**
 * Validated config passed to `run` and `resolvePorts`: defaults applied; optional fields
 * without a value are absent.
 */
export type ConfigValues<C> = {
  readonly [K in RequiredConfigKeys<C>]: ConfigFieldValue<C[K]>;
} & {
  readonly [K in OptionalConfigKeys<C>]?: Exclude<ConfigFieldValue<C[K]>, undefined>;
};

/** Options common to every config field. */
export interface ConfigFieldOptions {
  title?: string;
  description?: string;
}

/** Marks a field optional (no default). */
interface Optional {
  optional: true;
}
/** Marks a field required (the default). */
interface NotOptional {
  optional?: false;
}

/** Options of `cfg.text`. */
export interface CfgTextOptions extends ConfigFieldOptions {
  default?: string;
  multiline?: boolean;
}
/** Options of `cfg.int`. */
export interface CfgIntOptions extends ConfigFieldOptions {
  default?: number;
  min?: number;
  max?: number;
}
/** Options of `cfg.boolean`. */
export interface CfgBooleanOptions extends ConfigFieldOptions {
  default?: boolean;
}
/** Options of `cfg.choice`. */
export interface CfgChoiceOptions<V extends string> extends ConfigFieldOptions {
  default?: V;
}
/** Options of `cfg.typeId`. */
export interface CfgTypeIdOptions extends ConfigFieldOptions {
  kind?: "struct" | "enum" | "any";
}
/** Options of `cfg.global`. */
export interface CfgGlobalOptions extends ConfigFieldOptions {
  writable?: boolean;
}

/** The `cfg` builder. See {@link cfg}. */
export interface ConfigBuilder {
  /** Text. */
  text(options?: CfgTextOptions & NotOptional): ConfigField<string>;
  text(options: CfgTextOptions & Optional): ConfigField<string | undefined>;
  /** Safe integer. */
  int(options?: CfgIntOptions & NotOptional): ConfigField<number>;
  int(options: CfgIntOptions & Optional): ConfigField<number | undefined>;
  /** Boolean. */
  boolean(options?: CfgBooleanOptions & NotOptional): ConfigField<boolean>;
  boolean(options: CfgBooleanOptions & Optional): ConfigField<boolean | undefined>;
  /** One of fixed strings. */
  choice<const V extends string>(choices: readonly V[], options?: CfgChoiceOptions<V> & NotOptional): ConfigField<V>;
  choice<const V extends string>(choices: readonly V[], options: CfgChoiceOptions<V> & Optional): ConfigField<V | undefined>;
  /** A type (IR). Commands also accept shorthand strings and store IR. */
  type(options?: ConfigFieldOptions & NotOptional): ConfigField<TypeRef>;
  type(options: ConfigFieldOptions & Optional): ConfigField<TypeRef | undefined>;
  /** A type id visible in the node's flow (`kind` restricts struct/enum). */
  typeId(options?: CfgTypeIdOptions & NotOptional): ConfigField<string>;
  typeId(options: CfgTypeIdOptions & Optional): ConfigField<string | undefined>;
  /** A flow variable id of the node's flow. */
  flowVariable(options?: ConfigFieldOptions & NotOptional): ConfigField<string>;
  flowVariable(options: ConfigFieldOptions & Optional): ConfigField<string | undefined>;
  /** A global id of the context. */
  global(options?: CfgGlobalOptions & NotOptional): ConfigField<string>;
  global(options: CfgGlobalOptions & Optional): ConfigField<string | undefined>;
}

function field<V>(kind: ConfigFieldKind, options: object | undefined, extra: object = {}): ConfigField<V> {
  const { optional, ...rest } = (options ?? {}) as { optional?: boolean; default?: unknown };
  const required = optional !== true && rest.default === undefined;
  return { kind, required, ...extra, ...rest } as ConfigField<V>;
}

/**
 * Builder for node config fields. Every field is required unless it has a `default` or
 * `optional: true`.
 *
 * @example
 * ```ts
 * config: {
 *   template: cfg.text({ multiline: true, title: "Template" }),
 *   mode: cfg.choice(["round", "floor", "ceil"], { default: "round" }),
 *   typeId: cfg.typeId({ kind: "struct" }),
 * }
 * ```
 */
export const cfg: ConfigBuilder = {
  text: (options?: object) => field<string>("text", options),
  int: (options?: object) => field<number>("int", options),
  boolean: (options?: object) => field<boolean>("boolean", options),
  choice: (choices: readonly string[], options?: object) => field<string>("choice", options, { choices: [...choices] }),
  type: (options?: object) => field<TypeRef>("type", options),
  typeId: (options?: CfgTypeIdOptions) => {
    const { kind, ...rest } = options ?? {};
    return field<string>("typeId", rest, { typeKind: kind ?? "any" });
  },
  flowVariable: (options?: object) => field<string>("flowVariable", options),
  global: (options?: object) => field<string>("global", options),
} as ConfigBuilder;
