/**
 * Pure helpers behind the inline field editors: splitting a type into the base and the
 * list / optional wrappers the type picker toggles, and fresh names for "+" buttons.
 */
import { formatType } from "@briarflow/core";
import type { TypeRef, TypeScope } from "@briarflow/core";

/** A type as the type picker sees it: a base plus list / optional wrappers. */
export interface TypeShape {
  base: TypeRef;
  /** `list<…>`. */
  array: boolean;
  /** The whole value may be null (`T?`, `list<T>?`). */
  optional: boolean;
  /** List items may be null (`list<T?>`). Only meaningful with `array`. */
  itemOptional: boolean;
}

/**
 * Splits `list<T?>?` into `{ base: T, array, optional, itemOptional }`.
 *
 * @example
 * ```ts
 * typeShape({ kind: "list", of: { kind: "primitive", name: "int" } }); // { base: int, array: true, … }
 * ```
 */
export function typeShape(type: TypeRef): TypeShape {
  let t = type;
  let optional = false;
  let array = false;
  let itemOptional = false;
  if (t.kind === "optional") {
    optional = true;
    t = t.of;
  }
  if (t.kind === "list") {
    array = true;
    t = t.of;
    if (t.kind === "optional") {
      itemOptional = true;
      t = t.of;
    }
  }
  return { base: t, array, optional, itemOptional };
}

/**
 * Shorthand of a shape (`list<Character?>?`); the inverse of {@link typeShape}.
 *
 * @example
 * ```ts
 * shapeShorthand({ base: { kind: "primitive", name: "text" }, array: true, optional: false, itemOptional: false }); // "list<text>"
 * ```
 */
export function shapeShorthand(shape: TypeShape, scope?: TypeScope): string {
  const base = formatType(shape.base, scope);
  if (!shape.array) return shape.optional || shape.itemOptional ? `${base}?` : base;
  return `list<${base}${shape.itemOptional ? "?" : ""}>${shape.optional ? "?" : ""}`;
}

/** Shorthand of `type` with the list wrapper switched on or off (one-click `[ ]`). */
export function toggleArray(type: TypeRef, scope?: TypeScope): string {
  const s = typeShape(type);
  if (s.array) return shapeShorthand({ base: s.base, array: false, optional: s.optional || s.itemOptional, itemOptional: false }, scope);
  return shapeShorthand({ ...s, array: true }, scope);
}

/**
 * First `<prefix><n>` (n ≥ 1) not taken by `existing`, compared ignoring case like the
 * authoring name checks.
 *
 * @example
 * ```ts
 * nextName("input", ["input1", "Input2"]); // "input3"
 * ```
 */
export function nextName(prefix: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `${prefix}${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}
