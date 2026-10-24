/**
 * The value an input gets when it has no edge, no constant and no port default.
 */
import type { TypeRef } from "../types/ir.js";

/**
 * Empty value of a type: `""` for text, `0` for numbers (moved into `min`/`max`), `false` for
 * booleans, `[]` for lists, `null` for everything else (structs, enums, media, optionals,
 * generics).
 *
 * @example
 * ```ts
 * emptyValue({ kind: "primitive", name: "int", constraints: { min: 1 } }); // 1
 * emptyValue({ kind: "named", id: "ty_person" });                         // null
 * ```
 */
export function emptyValue(type: TypeRef): unknown {
  if (type.kind === "list") return [];
  if (type.kind !== "primitive") return null;
  switch (type.name) {
    case "text":
      return "";
    case "boolean":
      return false;
    case "int":
    case "float": {
      const { min, max } = type.constraints ?? {};
      if (min !== undefined && min > 0) return min;
      if (max !== undefined && max < 0) return max;
      return 0;
    }
    default:
      return null;
  }
}
