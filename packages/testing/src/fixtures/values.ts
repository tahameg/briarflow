/**
 * Data-driven value rows for types.md §6 (constraints) and §7 (accepted JSON). Each row is
 * validated with `validateValue(value, type, scope, { path: "v" })`.
 */
import { BUILTIN, type StructDecl, type TypeDecl, type TypeRef } from "@briarflow/core";
import { ir } from "./build.js";

/** How `message` is compared with the diagnostic message (path `v` included). */
export type MessageMatch = "exact" | "prefix" | "contains";

/** One value row. */
export interface ValueCase {
  label: string;
  type: TypeRef;
  value: unknown;
  ok: boolean;
  /** Full expected message for path `v`, e.g. `"v must be >= 0"` (failing rows). */
  message?: string;
  /** Default `"exact"`. */
  match?: MessageMatch;
  /** Types the row's type needs in scope (e.g. a struct extending Text). */
  types?: readonly TypeDecl[];
}

/** A struct extending Text whose static fields have these values. */
export function textType(id: string, statics: { minLength?: number; maxLength?: number; pattern?: string; multiline?: boolean }): StructDecl {
  const types: Record<string, TypeRef> = {
    minLength: ir.int(),
    maxLength: ir.optional(ir.int()),
    pattern: ir.optional(ir.string()),
    multiline: ir.bool(),
  };
  return {
    kind: "struct",
    id,
    name: `Text_${id.replace(/[^A-Za-z0-9]/g, "")}`,
    extends: BUILTIN.Text,
    fields: Object.entries(statics).map(([name, value]) => ({ name, type: types[name] ?? ir.string(), static: true, default: value })),
  };
}

const textRow = (label: string, statics: Parameters<typeof textType>[1], text: string, message?: string): ValueCase => {
  const decl = textType(`ty_${label.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), statics);
  return { label, type: ir.named(decl.id), types: [decl], value: { value: text }, ok: message === undefined, ...(message === undefined ? {} : { message }) };
};

const ref = () => ({ mediaId: "med_1" });

/** Rows of the §6 constraint table: one pass and one fail per constraint, exact suffixes. */
export const constraintCases: readonly ValueCase[] = [
  // Text (its limits are static fields of a struct extending it)
  textRow("text minLength ok", { minLength: 2 }, "ab"),
  textRow("text minLength fail", { minLength: 2 }, "a", "v.value must be at least 2 characters long"),
  textRow("text minLength counts code points", { minLength: 2 }, "😀", "v.value must be at least 2 characters long"),
  textRow("text minLength 0 accepts empty", { minLength: 0 }, ""),
  textRow("text maxLength ok (code points)", { maxLength: 2 }, "😀😀"),
  textRow("text maxLength boundary", { maxLength: 2 }, "ab"),
  textRow("text maxLength fail", { maxLength: 2 }, "abc", "v.value must be at most 2 characters long"),
  textRow("text pattern ok", { pattern: "[a-z]+" }, "abc"),
  textRow("text pattern anchored at end", { pattern: "[a-z]+" }, "abc1", "v.value must match the pattern [a-z]+"),
  textRow("text pattern anchored at start", { pattern: "[a-z]+" }, "1abc", "v.value must match the pattern [a-z]+"),
  textRow("text pattern alternation is anchored as a whole", { pattern: "a|b" }, "ab", "v.value must match the pattern a|b"),
  textRow("text pattern uses the u flag", { pattern: "\\p{L}+" }, "héllo"),
  textRow("text multiline is never validated", { multiline: true }, "a\nb"),
  { label: "plain Text has no limits", type: ir.text(), value: { value: "" }, ok: true },
  { label: "string has no limits", type: ir.string(), value: "😀".repeat(5000), ok: true },
  // int
  { label: "int ok", type: ir.int(), value: 5, ok: true },
  { label: "int 2.0 is accepted", type: ir.int(), value: 2.0, ok: true },
  { label: "int fraction", type: ir.int(), value: 1.5, ok: false, message: "v must be a whole number", match: "prefix" },
  { label: "int unsafe", type: ir.int(), value: 2 ** 53, ok: false, message: "v must be a whole number", match: "prefix" },
  { label: "int min boundary", type: ir.int({ min: 0 }), value: 0, ok: true },
  { label: "int min fail", type: ir.int({ min: 0 }), value: -1, ok: false, message: "v must be >= 0" },
  { label: "int max boundary", type: ir.int({ max: 10 }), value: 10, ok: true },
  { label: "int max fail", type: ir.int({ max: 10 }), value: 11, ok: false, message: "v must be <= 10" },
  // float
  { label: "float ok", type: ir.float(), value: 1.5, ok: true },
  { label: "float accepts integers", type: ir.float(), value: 3, ok: true },
  { label: "float infinity", type: ir.float(), value: Number.POSITIVE_INFINITY, ok: false, message: "v must be a number", match: "prefix" },
  { label: "float NaN", type: ir.float(), value: Number.NaN, ok: false, message: "v must be a number", match: "prefix" },
  { label: "float min fail", type: ir.float({ min: -1.5 }), value: -2, ok: false, message: "v must be >= -1.5" },
  { label: "float max fail", type: ir.float({ max: 0.5 }), value: 0.75, ok: false, message: "v must be <= 0.5" },
  { label: "float max boundary", type: ir.float({ max: 0.5 }), value: 0.5, ok: true },
  // boolean
  { label: "boolean true", type: ir.bool(), value: true, ok: true },
  { label: "boolean false", type: ir.bool(), value: false, ok: true },
  { label: "boolean string", type: ir.bool(), value: "true", ok: false, message: "v must be true or false", match: "prefix" },
  { label: "boolean number", type: ir.bool(), value: 1, ok: false, message: "v must be true or false", match: "prefix" },
  // media: limits are checked against the registry entry when a node reads it (checkMediaEntry)
  { label: "media limits are not checked on the value", type: ir.image(), value: { data: ref(), mime: "image/png" }, ok: true },
  { label: "media old uri shape", type: ir.image(), value: { data: { uri: "briar-media://m_1", mime: "image/png" }, mime: "image/png" }, ok: false, message: "v.data is not a valid binary value", match: "prefix" },
  // list
  { label: "list minItems ok", type: ir.list(ir.string(), { minItems: 2 }), value: ["a", "b"], ok: true },
  { label: "list minItems fail", type: ir.list(ir.string(), { minItems: 2 }), value: ["a"], ok: false, message: "v must have at least 2 items" },
  { label: "list maxItems ok", type: ir.list(ir.string(), { maxItems: 2 }), value: [], ok: true },
  { label: "list maxItems fail", type: ir.list(ir.string(), { maxItems: 2 }), value: ["a", "b", "c"], ok: false, message: "v must have at most 2 items" },
];

/** Rows of the §7 table (accepted JSON per type, type mismatches, element paths). */
export const shapeCases: readonly ValueCase[] = [
  { label: "text accepts a string", type: ir.string(), value: "hi", ok: true },
  { label: "text rejects a number", type: ir.string(), value: 3, ok: false, message: "v ", match: "prefix" },
  { label: "text rejects null", type: ir.string(), value: null, ok: false, message: "v ", match: "prefix" },
  { label: "int rejects a numeric string", type: ir.int(), value: "27", ok: false, message: 'v must be a whole number (got "27")' },
  { label: "float rejects a string", type: ir.float(), value: "1.5", ok: false, message: "v must be a number", match: "prefix" },
  { label: "media accepts a media value", type: ir.image(), value: { data: ref(), mime: "image/png" }, ok: true },
  { label: "media rejects a bare binary", type: ir.image(), value: ref(), ok: false, message: "v.data is required", match: "contains" },
  { label: "media rejects a string", type: ir.image(), value: "med_1", ok: false, message: "v ", match: "prefix" },
  { label: "binary accepts a media id", type: ir.binary(), value: ref(), ok: true },
  { label: "Text rejects a static field in the value", type: ir.text(), value: { value: "a", maxLength: 3 }, ok: false, message: "v.maxLength is a static field", match: "prefix" },
  { label: "Json accepts its text", type: ir.json(), value: { text: "[1]" }, ok: true },
  { label: "Secret accepts its name", type: ir.secret(), value: { name: "OPENAI_KEY" }, ok: true },
  { label: "list accepts an array", type: ir.list(ir.int()), value: [1, 2], ok: true },
  { label: "list rejects an object", type: ir.list(ir.int()), value: { 0: 1 }, ok: false, message: "v ", match: "prefix" },
  { label: "list element path", type: ir.list(ir.int({ min: 0 })), value: [1, -1], ok: false, message: "v[1] must be >= 0" },
  { label: "nested list element path", type: ir.list(ir.list(ir.string())), value: [["a"], ["b", 3]], ok: false, message: "v[1][1] ", match: "prefix" },
  { label: "optional accepts null", type: ir.optional(ir.int()), value: null, ok: true },
  { label: "optional accepts undefined", type: ir.optional(ir.int()), value: undefined, ok: true },
  { label: "optional accepts the inner value", type: ir.optional(ir.int()), value: 3, ok: true },
  { label: "optional checks the inner value", type: ir.optional(ir.int({ min: 0 })), value: -1, ok: false, message: "v must be >= 0" },
  { label: "list of optionals", type: ir.list(ir.optional(ir.string())), value: ["a", null], ok: true },
];
