/**
 * Assignability and type equality (docs/specs/types.md §4).
 */
import { jsonEquals } from "../util/json.js";
import type { TypeRef } from "./ir.js";
import { extendsStruct, type DeclResolver } from "./layout.js";

/**
 * Can a value of type `from` flow into a port of type `to`? Nominal for named types (a struct
 * fits where a struct it extends is expected, when `resolve` is given), `int → float` is the
 * only widening, `T → T?` is allowed, lists are covariant. Constraints are ignored. A `var` on
 * either side → `false` (resolve generics first).
 *
 * @example
 * ```ts
 * isAssignable({ kind: "primitive", name: "int" }, { kind: "primitive", name: "float" }); // true
 * ```
 */
export function isAssignable(from: TypeRef, to: TypeRef, resolve?: DeclResolver): boolean {
  if (from.kind === "var" || to.kind === "var") return false;
  if (to.kind === "optional") {
    if (from.kind === "optional") return isAssignable(from.of, to.of, resolve);
    return isAssignable(from, to.of, resolve);
  }
  switch (from.kind) {
    case "optional":
      return false;
    case "primitive":
      if (to.kind !== "primitive") return false;
      if (from.name === to.name) return true;
      return to.name === "float" && from.name === "int";
    case "named":
      if (to.kind !== "named") return false;
      return to.id === from.id || (resolve !== undefined && extendsStruct(from.id, to.id, resolve));
    case "list":
      return to.kind === "list" && isAssignable(from.of, to.of, resolve);
  }
}

/**
 * Structural equality of two type refs. `ignoreConstraints` (default `false`) also ignores
 * primitive constraints and list bounds.
 *
 * @example
 * ```ts
 * typeEquals(a, b, { ignoreConstraints: true });
 * ```
 */
export function typeEquals(a: TypeRef, b: TypeRef, options: { ignoreConstraints?: boolean } = {}): boolean {
  if (options.ignoreConstraints) return jsonEquals(stripConstraints(a), stripConstraints(b));
  return jsonEquals(normalizeEmpty(a), normalizeEmpty(b));
}

function normalizeEmpty(type: TypeRef): TypeRef {
  switch (type.kind) {
    case "primitive":
      if (type.constraints && Object.values(type.constraints).every((v) => v === undefined)) {
        return { kind: "primitive", name: type.name } as TypeRef;
      }
      return type;
    case "list":
      return { ...type, of: normalizeEmpty(type.of) };
    case "optional":
      return { kind: "optional", of: normalizeEmpty(type.of) };
    default:
      return type;
  }
}

/**
 * Removes primitive constraints and list bounds, recursively (bindings drop constraints,
 * types.md §5.2 step 5).
 */
export function stripConstraints(type: TypeRef): TypeRef {
  switch (type.kind) {
    case "primitive":
      return { kind: "primitive", name: type.name } as TypeRef;
    case "list":
      return { kind: "list", of: stripConstraints(type.of) };
    case "optional":
      return { kind: "optional", of: stripConstraints(type.of) };
    case "named":
      return { kind: "named", id: type.id };
    case "var":
      return { kind: "var", name: type.name };
  }
}
