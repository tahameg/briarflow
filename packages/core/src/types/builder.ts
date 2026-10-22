/**
 * The `t` type builder (docs/specs/node-api.md §3). Each builder returns a {@link TypeSpec}
 * that carries the IR plus the static TypeScript value type, so node `run` functions get typed
 * inputs and must return typed outputs.
 */
import type { EnumDecl, StructDecl } from "../documents/model.js";
import { TypeDefinitionError } from "../errors.js";
import { TYPE_VAR_NAME_PATTERN } from "../util/names.js";
import { constraintMessage, constraintProblems } from "./constraints.js";
import { parseType } from "./shorthand.js";
import type {
  ErrorValue,
  ImageConstraints,
  MediaConstraints,
  MediaRef,
  NumberConstraints,
  PrimitiveName,
  TextConstraints,
  TimedMediaConstraints,
  TypeRef,
} from "./ir.js";

/** Phantom key carrying the static value type. Never present at run time. */
declare const valueTypeKey: unique symbol;

/**
 * Static type of values whose Briarflow type is not known to TypeScript (`t.ref("Name")`,
 * `t.var`, `t.parse`, `t.fromRef`). Behaves like `unknown` for reading (narrow before use) but,
 * unlike `unknown`, lets TypeScript keep literal types (enum members) in `run` return values.
 * Every JSON value except `undefined`.
 */
export type UnknownValue = string | number | boolean | object | null;

/**
 * A type built with `t`: the IR (`ref`) plus a phantom static value type `V`.
 *
 * @example
 * ```ts
 * const age: TypeSpec<number> = t.int({ min: 0 });
 * age.ref; // { kind: "primitive", name: "int", constraints: { min: 0 } }
 * ```
 */
export interface TypeSpec<V = UnknownValue> {
  readonly kind: "typeSpec";
  readonly ref: TypeRef;
  readonly [valueTypeKey]?: V;
}

/**
 * A pack struct created with `defineStruct`. Pass it to `t.ref()` for a typed reference and to
 * `definePack({ types })` to publish it. `decl.id` is the bare name until `definePack`
 * qualifies it (`"ChatMessage"` → `"openai.ChatMessage"`).
 */
export interface StructType<V = UnknownValue> {
  readonly kind: "structType";
  readonly decl: StructDecl;
  readonly [valueTypeKey]?: V;
}

/** A pack enum created with `defineEnum`. `V` is the union of member values. */
export interface EnumType<V extends string = string> {
  readonly kind: "enumType";
  readonly decl: EnumDecl;
  readonly [valueTypeKey]?: V;
}

/**
 * Static value type of a `TypeSpec`, `StructType` or `EnumType`.
 *
 * @example
 * ```ts
 * type Age = ValueOf<typeof ageSpec>;          // number
 * type Msg = ValueOf<typeof ChatMessage>;      // { role: "system" | "user"; content: string; … }
 * ```
 */
export type ValueOf<S> =
  S extends TypeSpec<infer V> ? V
  : S extends StructType<infer V> ? V
  : S extends EnumType<infer V> ? V
  : never;

/** Options of `t.list`. */
export interface ListOptions {
  minItems?: number;
  maxItems?: number;
}

/** True when `value` is a {@link TypeSpec}. */
export function isTypeSpec(value: unknown): value is TypeSpec {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "typeSpec";
}

function spec<V>(ref: TypeRef): TypeSpec<V> {
  return { kind: "typeSpec", ref };
}

function checked<V>(ref: TypeRef, builder: string): TypeSpec<V> {
  const problem = constraintProblems(ref)[0];
  if (problem !== undefined) {
    throw new TypeDefinitionError("type.invalid_constraint", constraintMessage(problem, builder), {
      details: { constraint: problem.constraint, reason: problem.reason },
    });
  }
  return spec<V>(ref);
}

function withoutUndefined(options: object | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

function primitive<V>(name: PrimitiveName, constraints: object | undefined): TypeSpec<V> {
  const c = withoutUndefined(constraints);
  if (Array.isArray(c["formats"])) c["formats"] = [...(c["formats"] as string[])];
  const ref = (Object.keys(c).length > 0 ? { kind: "primitive", name, constraints: c } : { kind: "primitive", name }) as TypeRef;
  return checked<V>(ref, `t.${name}()`);
}

/** The `t` builder. See {@link t}. */
export interface TypeBuilder {
  /** `text`. @example `t.text({ maxLength: 40, multiline: true })` */
  text(constraints?: TextConstraints): TypeSpec<string>;
  /** `int` (safe integer). @example `t.int({ min: 0, max: 120 })` */
  int(constraints?: NumberConstraints): TypeSpec<number>;
  /** `float` (finite number). */
  float(constraints?: NumberConstraints): TypeSpec<number>;
  /** `boolean`. */
  boolean(): TypeSpec<boolean>;
  /** `image` media. @example `t.image({ formats: ["png", "jpeg"] })` */
  image(constraints?: ImageConstraints): TypeSpec<MediaRef>;
  /** `video` media. */
  video(constraints?: TimedMediaConstraints): TypeSpec<MediaRef>;
  /** `audio` media. */
  audio(constraints?: TimedMediaConstraints): TypeSpec<MediaRef>;
  /** `model3d` media. */
  model3d(constraints?: MediaConstraints): TypeSpec<MediaRef>;
  /** `file` media (any mime). */
  file(constraints?: MediaConstraints): TypeSpec<MediaRef>;
  /** Why a node failed (`{ code, message, nodeId?, node?, details? }`). */
  error(): TypeSpec<ErrorValue>;
  /** `list<item>`. Values are readonly arrays. @example `t.list(t.image(), { maxItems: 4 })` */
  list<V>(item: TypeSpec<V>, options?: ListOptions): TypeSpec<readonly V[]>;
  /** `item?` — the value or `null`. Optional of optional throws `type.syntax`. */
  optional<V>(inner: TypeSpec<V>): TypeSpec<V | null>;
  /** Typed reference to a pack struct from `defineStruct`. */
  ref<V>(type: StructType<V>): TypeSpec<V>;
  /** Typed reference to a pack enum from `defineEnum`. */
  ref<V extends string>(type: EnumType<V>): TypeSpec<V>;
  /**
   * Reference by name or id: `"Role"` (resolved against the pack by `definePack`),
   * `"openai.ChatMessage"`, `"ty_abc"`. Statically {@link UnknownValue}.
   */
  ref(nameOrId: string): TypeSpec<UnknownValue>;
  /** Generic placeholder (`$T`). Node definitions only. Statically {@link UnknownValue}. */
  var(name: string): TypeSpec<UnknownValue>;
  /** Shorthand → spec: `t.parse("list<Character?>")`. Names stay unresolved until `definePack`. */
  parse(shorthand: string): TypeSpec<UnknownValue>;
  /** Wraps an IR `TypeRef` (e.g. from a document inside `resolvePorts`). */
  fromRef(ref: TypeRef): TypeSpec<UnknownValue>;
}

/**
 * The type builder used in node definitions, pack types and tests.
 *
 * @example
 * ```ts
 * import { t } from "@briarflow/core";
 * const ports = {
 *   prompt: t.text({ multiline: true, maxLength: 4000 }),
 *   images: t.list(t.image({ formats: ["png"] }), { maxItems: 4 }),
 *   seed: t.optional(t.int({ min: 0 })),
 * };
 * ```
 */
export const t: TypeBuilder = {
  text: (constraints) => primitive<string>("text", constraints),
  int: (constraints) => primitive<number>("int", constraints),
  float: (constraints) => primitive<number>("float", constraints),
  boolean: () => primitive<boolean>("boolean", undefined),
  image: (constraints) => primitive<MediaRef>("image", constraints),
  video: (constraints) => primitive<MediaRef>("video", constraints),
  audio: (constraints) => primitive<MediaRef>("audio", constraints),
  model3d: (constraints) => primitive<MediaRef>("model3d", constraints),
  file: (constraints) => primitive<MediaRef>("file", constraints),
  error: () => primitive<ErrorValue>("error", undefined),
  list<V>(item: TypeSpec<V>, options: ListOptions = {}): TypeSpec<readonly V[]> {
    return checked<readonly V[]>({ kind: "list", of: item.ref, ...withoutUndefined(options) }, "t.list()");
  },
  optional<V>(inner: TypeSpec<V>): TypeSpec<V | null> {
    if (inner.ref.kind === "optional") {
      throw new TypeDefinitionError(
        "type.syntax",
        "t.optional() received a type that is already optional. Optional of optional is not a type; use the inner type once.",
      );
    }
    return spec<V | null>({ kind: "optional", of: inner.ref });
  },
  ref(target: string | StructType | EnumType): TypeSpec<never> {
    const id = typeof target === "string" ? target : target.decl.id;
    return spec<never>({ kind: "named", id });
  },
  var(name) {
    if (typeof name !== "string" || name.length > 16 || !TYPE_VAR_NAME_PATTERN.test(name)) {
      throw new TypeDefinitionError(
        "type.invalid_name",
        `"${String(name)}" is not a valid generic type name. Generic names start with an uppercase letter and use letters and digits (e.g. T, Item), at most 16 characters.`,
      );
    }
    return spec<UnknownValue>({ kind: "var", name });
  },
  parse(shorthand) {
    const result = parseType(shorthand, { allowVars: true });
    if (!result.ok) {
      throw new TypeDefinitionError(result.diagnostic.code, result.diagnostic.message, { details: result.diagnostic.details });
    }
    return spec<UnknownValue>(result.type);
  },
  fromRef: (ref) => spec<UnknownValue>(ref),
};
