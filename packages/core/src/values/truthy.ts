/**
 * Truthiness (docs/specs/types.md §7.1): how Branch and `{{#if}}` read any value as a yes / no.
 */
import { BUILTIN } from "../types/builtins.js";
import type { TypeRef } from "../types/ir.js";
import { rootOf, type DeclResolver } from "../types/layout.js";

/**
 * `false`, `0`, `""`, an empty list, `null` and an unset value (`undefined`) are false; anything
 * else is true. A Text is true when its `value` is not empty. With `type` and `resolve`, structs
 * that extend Text count too.
 *
 * @example
 * ```ts
 * isTruthy(0); // false
 * isTruthy([]); // false
 * isTruthy({ value: "" }, { kind: "named", id: "briar.Text" }, resolve); // false
 * ```
 */
export function isTruthy(value: unknown, type?: TypeRef, resolve?: DeclResolver): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (typeof value === "number" && Number.isNaN(value)) return false;
  if (Array.isArray(value)) return value.length > 0;
  const inner = type?.kind === "optional" ? type.of : type;
  if (inner?.kind === "named" && typeof value === "object") {
    const root = resolve ? rootOf(inner.id, resolve) : inner.id;
    if (root === BUILTIN.Text) return (value as { value?: unknown }).value !== "";
  }
  return true;
}
