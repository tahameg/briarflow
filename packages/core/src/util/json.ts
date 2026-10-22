import { BriarError } from "../errors.js";

/** Any JSON value. Briarflow documents and values are plain JSON. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON: object keys sorted (UTF-16 code unit order) at every level, arrays in
 * order, no whitespace, `undefined` object entries dropped. Used for cache keys, hashes and
 * deep-equality. Throws `BriarError("json.invalid")` for non-finite numbers, functions,
 * symbols, bigints and cycles.
 *
 * @example
 * ```ts
 * canonicalJson({ b: 1, a: [true, null] }); // '{"a":[true,null],"b":1}'
 * ```
 */
export function canonicalJson(value: unknown): string {
  return stringifySorted(value, 0);
}

/**
 * Deep equality of two JSON values (object key order ignored, `undefined` entries ignored).
 * Throws `BriarError("json.invalid")` like {@link canonicalJson} for non-JSON input.
 *
 * @example
 * ```ts
 * jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 }); // true
 * ```
 */
export function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b && (a === null || typeof a !== "object")) return true;
  return canonicalJson(a) === canonicalJson(b);
}

function invalid(reason: string, path: string): never {
  throw new BriarError("json.invalid", `Value is not JSON: ${reason} at ${path || "the root"}.`, {
    details: { path },
  });
}

/**
 * Internal: sorted-key JSON with an optional indent (0 = compact). Shared by `canonicalJson`
 * and `serializeContext` so both use exactly the same key order.
 */
export function stringifySorted(value: unknown, indent: number): string {
  const stack = new Set<object>();
  const pad = (depth: number) => (indent > 0 ? "\n" + " ".repeat(indent * depth) : "");
  const sep = indent > 0 ? ": " : ":";

  const write = (v: unknown, depth: number, path: string): string => {
    if (v === null) return "null";
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) invalid(`non-finite number ${String(v)}`, path);
        return JSON.stringify(v);
      case "undefined":
        return "null";
      case "function":
      case "symbol":
      case "bigint":
        return invalid(`${typeof v}`, path);
      default:
        break;
    }
    const obj = v as object;
    const withToJson = obj as { toJSON?: () => unknown };
    if (!Array.isArray(obj) && typeof withToJson.toJSON === "function") {
      return write(withToJson.toJSON(), depth, path);
    }
    if (stack.has(obj)) invalid("circular reference", path);
    stack.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      if (obj.length === 0) out = "[]";
      else {
        const parts = obj.map((item, i) => pad(depth + 1) + write(item, depth + 1, `${path}[${i}]`));
        out = "[" + parts.join(",") + pad(depth) + "]";
      }
    } else {
      const rec = obj as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (keys.length === 0) out = "{}";
      else {
        const parts = keys.map(
          (k) => pad(depth + 1) + JSON.stringify(k) + sep + write(rec[k], depth + 1, path ? `${path}.${k}` : k),
        );
        out = "{" + parts.join(",") + pad(depth) + "}";
      }
    }
    stack.delete(obj);
    return out;
  };

  return write(value, 0, "");
}

/** Internal: deep copy of a JSON value, dropping `undefined` object entries. */
export function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = cloneJson(v);
  }
  return out as T;
}

/** Internal: true for a plain (non-array, non-null) object. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
