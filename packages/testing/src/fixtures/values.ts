/**
 * Data-driven value rows for types.md §6 (constraints) and §7 (accepted JSON). Each row is
 * validated with `validateValue(value, type, scope, { path: "v" })`.
 */
import type { TypeRef } from "@briarflow/core";
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
}

const ref = () => ({ mediaId: "med_1" });

/** Rows of the §6 constraint table: one pass and one fail per constraint, exact suffixes. */
export const constraintCases: readonly ValueCase[] = [
  // text
  { label: "text minLength ok", type: ir.text({ minLength: 2 }), value: "ab", ok: true },
  { label: "text minLength fail", type: ir.text({ minLength: 2 }), value: "a", ok: false, message: "v must be at least 2 characters long" },
  { label: "text minLength counts code points", type: ir.text({ minLength: 2 }), value: "😀", ok: false, message: "v must be at least 2 characters long" },
  { label: "text minLength 0 accepts empty", type: ir.text({ minLength: 0 }), value: "", ok: true },
  { label: "text maxLength ok (code points)", type: ir.text({ maxLength: 2 }), value: "😀😀", ok: true },
  { label: "text maxLength boundary", type: ir.text({ maxLength: 2 }), value: "ab", ok: true },
  { label: "text maxLength fail", type: ir.text({ maxLength: 2 }), value: "abc", ok: false, message: "v must be at most 2 characters long" },
  { label: "text pattern ok", type: ir.text({ pattern: "[a-z]+" }), value: "abc", ok: true },
  { label: "text pattern anchored at end", type: ir.text({ pattern: "[a-z]+" }), value: "abc1", ok: false, message: "v must match the pattern [a-z]+" },
  { label: "text pattern anchored at start", type: ir.text({ pattern: "[a-z]+" }), value: "1abc", ok: false, message: "v must match the pattern [a-z]+" },
  { label: "text pattern alternation is anchored as a whole", type: ir.text({ pattern: "a|b" }), value: "ab", ok: false, message: "v must match the pattern a|b" },
  { label: "text pattern uses the u flag", type: ir.text({ pattern: "\\p{L}+" }), value: "héllo", ok: true },
  { label: "text multiline is never validated", type: ir.text({ multiline: false }), value: "a\nb", ok: true },
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
  { label: "boolean true", type: ir.boolean(), value: true, ok: true },
  { label: "boolean false", type: ir.boolean(), value: false, ok: true },
  { label: "boolean string", type: ir.boolean(), value: "true", ok: false, message: "v must be true or false", match: "prefix" },
  { label: "boolean number", type: ir.boolean(), value: 1, ok: false, message: "v must be true or false", match: "prefix" },
  // media: constraints are checked against the registry entry when a node reads it (checkMediaEntry)
  { label: "media constraints are not checked on the value", type: ir.image({ formats: ["png"], maxWidth: 1 }), value: ref(), ok: true },
  { label: "media old uri shape", type: ir.image(), value: { uri: "briar-media://m_1", mime: "image/png" }, ok: false, message: "v is not a valid image", match: "prefix" },
  // list
  { label: "list minItems ok", type: ir.list(ir.text(), { minItems: 2 }), value: ["a", "b"], ok: true },
  { label: "list minItems fail", type: ir.list(ir.text(), { minItems: 2 }), value: ["a"], ok: false, message: "v must have at least 2 items" },
  { label: "list maxItems ok", type: ir.list(ir.text(), { maxItems: 2 }), value: [], ok: true },
  { label: "list maxItems fail", type: ir.list(ir.text(), { maxItems: 2 }), value: ["a", "b", "c"], ok: false, message: "v must have at most 2 items" },
];

/** Rows of the §7 table (accepted JSON per type, type mismatches, element paths). */
export const shapeCases: readonly ValueCase[] = [
  { label: "text accepts a string", type: ir.text(), value: "hi", ok: true },
  { label: "text rejects a number", type: ir.text(), value: 3, ok: false, message: "v ", match: "prefix" },
  { label: "text rejects null", type: ir.text(), value: null, ok: false, message: "v ", match: "prefix" },
  { label: "int rejects a numeric string", type: ir.int(), value: "27", ok: false, message: 'v must be a whole number (got "27")' },
  { label: "float rejects a string", type: ir.float(), value: "1.5", ok: false, message: "v must be a number", match: "prefix" },
  { label: "media accepts a media value", type: ir.image(), value: ref(), ok: true },
  { label: "media rejects a string", type: ir.image(), value: "med_1", ok: false, message: "v ", match: "prefix" },
  { label: "list accepts an array", type: ir.list(ir.int()), value: [1, 2], ok: true },
  { label: "list rejects an object", type: ir.list(ir.int()), value: { 0: 1 }, ok: false, message: "v ", match: "prefix" },
  { label: "list element path", type: ir.list(ir.int({ min: 0 })), value: [1, -1], ok: false, message: "v[1] must be >= 0" },
  { label: "nested list element path", type: ir.list(ir.list(ir.text())), value: [["a"], ["b", 3]], ok: false, message: "v[1][1] ", match: "prefix" },
  { label: "optional accepts null", type: ir.optional(ir.int()), value: null, ok: true },
  { label: "optional accepts undefined", type: ir.optional(ir.int()), value: undefined, ok: true },
  { label: "optional accepts the inner value", type: ir.optional(ir.int()), value: 3, ok: true },
  { label: "optional checks the inner value", type: ir.optional(ir.int({ min: 0 })), value: -1, ok: false, message: "v must be >= 0" },
  { label: "list of optionals", type: ir.list(ir.optional(ir.text())), value: ["a", null], ok: true },
];
