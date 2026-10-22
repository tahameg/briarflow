/**
 * Pack types: `defineStruct` / `defineEnum` (docs/specs/node-api.md §7).
 */
import type { EnumMember, FieldDecl } from "../documents/model.js";
import { PackDefinitionError } from "../errors.js";
import { isValidEnumValue, isValidFieldName, RESERVED_FIELD_NAMES, RESERVED_TYPE_NAMES, TYPE_NAME_PATTERN } from "../util/names.js";
import { checkValue } from "../values/validate.js";
import type { EnumType, StructType, TypeSpec, UnknownValue } from "./builder.js";
import { isTypeSpec } from "./builder.js";
import { createTypeScope } from "./scope.js";
import { containsVar } from "./walk.js";

/** A struct field in `defineStruct`: a spec, or a spec with metadata. */
export type FieldInput<V = UnknownValue> =
  | TypeSpec<V>
  | { type: TypeSpec<V>; description?: string; default?: V };

/** Map of field name → {@link FieldInput}. */
export type FieldInputMap = Record<string, FieldInput>;

/** Static value of one field input. */
export type FieldValue<F> =
  F extends TypeSpec<infer V> ? V
  : F extends { type: TypeSpec<infer V> } ? V
  : never;

/** Normalized struct value (every field present) of a field map. */
export type StructValueOf<F> = { -readonly [K in keyof F]: FieldValue<F[K]> };

/** Options of `defineStruct` / `defineEnum`. */
export interface DefineTypeOptions {
  description?: string;
}

/** An enum member input: a value, or a value with a label. */
export type EnumMemberInput = string | { value: string; label?: string };

/** Union of member values of an enum member list. */
export type EnumValueOf<M extends readonly EnumMemberInput[]> =
  M[number] extends infer E ? (E extends string ? E : E extends { value: infer V extends string } ? V : never) : never;

/**
 * Defines a pack struct. Its id becomes `<pack>.<name>` when passed to `definePack`.
 * Throws `PackDefinitionError` (`pack.invalid`) for invalid names, duplicate fields or invalid
 * defaults.
 *
 * @example
 * ```ts
 * const ChatMessage = defineStruct("ChatMessage", {
 *   role: t.ref(Role),
 *   content: t.text(),
 *   name: { type: t.optional(t.text()), description: "Optional speaker name" },
 * });
 * type Msg = ValueOf<typeof ChatMessage>; // { role: …; content: string; name: string | null }
 * ```
 */
export function defineStruct<const F extends FieldInputMap>(
  name: string,
  fields: F,
  options?: DefineTypeOptions,
): StructType<StructValueOf<F>> {
  checkTypeName("defineStruct", name);
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    throw new PackDefinitionError(`defineStruct "${name}": fields must be an object of field name → type.`);
  }
  const seen = new Map<string, string>();
  const decls: FieldDecl[] = [];
  for (const [fieldName, input] of Object.entries(fields)) {
    const where = `defineStruct "${name}": field "${fieldName}"`;
    if (RESERVED_FIELD_NAMES.includes(fieldName)) throw new PackDefinitionError(`${where} uses a reserved name. Choose another field name.`);
    if (!isValidFieldName(fieldName)) {
      throw new PackDefinitionError(`${where} is not a valid field name (use letters, digits and _; start with a letter or _; at most 64 characters).`);
    }
    const lower = fieldName.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined) {
      throw new PackDefinitionError(`${where} clashes with field "${existing}". Field names must be unique (ignoring case).`);
    }
    seen.set(lower, fieldName);
    const spec = isTypeSpec(input) ? input : (input as { type?: unknown }).type;
    if (!isTypeSpec(spec)) throw new PackDefinitionError(`${where} must be a type from t (e.g. t.text()) or { type, description?, default? }.`);
    if (containsVar(spec.ref)) throw new PackDefinitionError(`${where} uses a generic type; generics are only allowed in node ports.`);
    const decl: FieldDecl = { name: fieldName, type: spec.ref };
    if (!isTypeSpec(input)) {
      const meta = input as { description?: unknown; default?: unknown };
      if (meta.description !== undefined) {
        if (typeof meta.description !== "string") throw new PackDefinitionError(`${where}: description must be a string.`);
        decl.description = meta.description;
      }
      if (meta.default !== undefined) {
        const r = checkValue(meta.default, spec.ref, EMPTY_SCOPE, {
          path: `default`,
          lenientUnknownNamed: true,
        });
        const first = r.diagnostics[0];
        if (first) throw new PackDefinitionError(`${where} has an invalid default: ${first.message}.`);
        decl.default = meta.default;
      }
    }
    decls.push(decl);
  }
  const decl = { kind: "struct" as const, id: name, name, fields: decls, ...describeOption("defineStruct", name, options) };
  return { kind: "structType", decl };
}

const EMPTY_SCOPE = createTypeScope({});

function checkTypeName(fn: string, name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length > 64 || !TYPE_NAME_PATTERN.test(name)) {
    throw new PackDefinitionError(
      `${fn}: "${String(name)}" is not a valid type name. Type names start with an uppercase letter and use letters, digits and _ (e.g. Character).`,
    );
  }
  if (RESERVED_TYPE_NAMES.includes(name)) throw new PackDefinitionError(`${fn}: "${name}" is reserved. Choose another type name.`);
}

function describeOption(fn: string, name: string, options: DefineTypeOptions | undefined): { description?: string } {
  if (options?.description === undefined) return {};
  if (typeof options.description !== "string") throw new PackDefinitionError(`${fn} "${name}": description must be a string.`);
  return { description: options.description };
}

/**
 * Defines a pack enum. Member values follow the enum value rules (types.md §1).
 *
 * @example
 * ```ts
 * const Role = defineEnum("Role", ["system", "user", { value: "assistant", label: "AI" }]);
 * type R = ValueOf<typeof Role>; // "system" | "user" | "assistant"
 * ```
 */
export function defineEnum<const M extends readonly EnumMemberInput[]>(
  name: string,
  members: M,
  options?: DefineTypeOptions,
): EnumType<EnumValueOf<M>> {
  checkTypeName("defineEnum", name);
  if (!Array.isArray(members)) throw new PackDefinitionError(`defineEnum "${name}": members must be a list.`);
  const seen = new Map<string, string>();
  const out: EnumMember[] = [];
  for (const m of members as readonly EnumMemberInput[]) {
    const value = typeof m === "string" ? m : (m as { value?: unknown } | null)?.value;
    if (typeof value !== "string" || !isValidEnumValue(value)) {
      throw new PackDefinitionError(
        `defineEnum "${name}": member ${JSON.stringify(value) ?? String(value)} is not a valid enum value (letters, digits, _, . and -; at most 64 characters).`,
      );
    }
    const existing = seen.get(value.toLowerCase());
    if (existing !== undefined) {
      throw new PackDefinitionError(`defineEnum "${name}": member "${value}" duplicates "${existing}". Members must be unique (ignoring case).`);
    }
    seen.set(value.toLowerCase(), value);
    const member: EnumMember = { value };
    if (typeof m !== "string" && m.label !== undefined) {
      const label = typeof m.label === "string" ? m.label.trim() : "";
      if (label === "" || label.length > 120) {
        throw new PackDefinitionError(`defineEnum "${name}": label of "${value}" must be 1–120 characters.`);
      }
      member.label = label;
    }
    out.push(member);
  }
  const decl = { kind: "enum" as const, id: name, name, members: out, ...describeOption("defineEnum", name, options) };
  return { kind: "enumType", decl };
}
