/**
 * Identifier rules (docs/specs/types.md §1). Regexes are exported as data; the `is…`
 * functions also apply length limits and reserved words.
 */

/** Struct/enum type names: `Character`, `ArtStyle`. Max 64. */
export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]*$/;
/** Field, port, flow input/output, variable and global names. Max 64. */
export const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Enum member values: `anime`, `16x9`, `gpt-4.1`. Max 64. */
export const ENUM_VALUE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Pack names: `openai`, `my_tools`. Max 32. */
export const PACK_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Generic variable names used with `t.var`: `T`, `Item`. Max 16. */
export const TYPE_VAR_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
/** Node types: `<namespace>.<name>[.<sub>]`, e.g. `openai.chat`, `briar.variable.get`. */
export const NODE_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][A-Za-z0-9_]*)+$/;

/** Type names that may not be used (case-sensitive). */
export const RESERVED_TYPE_NAMES: readonly string[] = [
  "Text", "Int", "Float", "Boolean", "Image", "Video", "Audio", "Model3d", "Model3D", "File", "List", "Optional",
];
/** Field/port/variable names that may not be used. */
export const RESERVED_FIELD_NAMES: readonly string[] = ["__proto__", "constructor", "prototype"];

/** True for a valid, non-reserved struct/enum name (≤ 64 chars). */
export function isValidTypeName(name: string): boolean {
  return name.length <= 64 && TYPE_NAME_PATTERN.test(name) && !RESERVED_TYPE_NAMES.includes(name);
}

/** True for a valid, non-reserved field/port/variable/global name (≤ 64 chars). */
export function isValidFieldName(name: string): boolean {
  return name.length <= 64 && FIELD_NAME_PATTERN.test(name) && !RESERVED_FIELD_NAMES.includes(name);
}

/** True for a valid enum member value (≤ 64 chars). */
export function isValidEnumValue(value: string): boolean {
  return value.length <= 64 && ENUM_VALUE_PATTERN.test(value);
}

/** True for a valid pack name (≤ 32 chars). */
export function isValidPackName(name: string): boolean {
  return name.length <= 32 && PACK_NAME_PATTERN.test(name);
}

/** True for a valid node type string. */
export function isValidNodeType(type: string): boolean {
  return NODE_TYPE_PATTERN.test(type);
}
