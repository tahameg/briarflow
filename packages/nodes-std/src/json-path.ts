/**
 * JSON field paths: `user.name`, `items[0].id`, `[2]` (root array), `""` (the root itself).
 * A json value may still be raw JSON text (As JSON does not parse); it is parsed here, at the
 * step that goes into it, and fails with `json.invalid_json` when it is not valid JSON.
 */
import { NodeError } from "@briarflow/core";

/** One step of a path: an object key or an array index. */
export type PathSegment = string | number;

const NAME = /^[^.[\]\s]+/;

/**
 * Parses a path. Returns the segments, or a message saying what is wrong.
 *
 * @example
 * ```ts
 * parsePath("items[0].id"); // ["items", 0, "id"]
 * ```
 */
export function parsePath(path: string): PathSegment[] | { problem: string } {
  const out: PathSegment[] = [];
  let i = 0;
  const s = path.trim();
  while (i < s.length) {
    if (s[i] === "[") {
      const end = s.indexOf("]", i);
      const raw = end < 0 ? "" : s.slice(i + 1, end);
      if (end < 0 || !/^\d+$/.test(raw)) return { problem: `"${s}" has a bad index at position ${i}. Write [0], [1], …` };
      out.push(Number(raw));
      i = end + 1;
      continue;
    }
    if (s[i] === ".") {
      if (out.length === 0 || s[i + 1] === undefined || s[i + 1] === "." || s[i + 1] === "[") {
        return { problem: `"${s}" has an empty field name at position ${i}.` };
      }
      i += 1;
    } else if (out.length > 0) {
      return { problem: `"${s}" needs a "." before the field at position ${i}.` };
    }
    const m = NAME.exec(s.slice(i));
    if (!m) return { problem: `"${s}" has an empty field name at position ${i}.` };
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

/** Parses a path or throws `NodeError("json.invalid_path")`. */
export function pathOrThrow(path: string): PathSegment[] {
  const p = parsePath(path);
  if (!Array.isArray(p)) throw new NodeError("json.invalid_path", `Invalid JSON path: ${p.problem}`);
  return p;
}

/** Shows a path prefix for messages: `items[0].id`, or `(root)`. */
export function showPath(segments: readonly PathSegment[]): string {
  if (segments.length === 0) return "(root)";
  return segments.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join("");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  return `a ${typeof v}`;
}

/**
 * The value at `segments`, or throws `NodeError("json.field_missing")` naming the first step
 * that does not exist.
 */
export function getAt(root: unknown, segments: readonly PathSegment[]): unknown {
  let cur = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as PathSegment;
    const here = showPath(segments.slice(0, i));
    cur = openJson(cur, here);
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) throw missing(segments, `${here} is ${kindOf(cur)}, not an array`);
      if (seg >= cur.length) throw missing(segments, `${here} has ${cur.length} items, so [${seg}] does not exist`);
      cur = cur[seg];
    } else {
      if (!isObject(cur)) throw missing(segments, `${here} is ${kindOf(cur)}, not an object`);
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) throw missing(segments, `${here} has no field "${seg}"`);
      cur = cur[seg];
    }
  }
  return cur;
}

/** True when `segments` exists in `root`. */
export function hasAt(root: unknown, segments: readonly PathSegment[]): boolean {
  try {
    getAt(root, segments);
    return true;
  } catch {
    return false;
  }
}

/**
 * A copy of `root` with `value` at `segments`. Missing objects on the way are created; an
 * index may point at an existing item or one past the end (append). Throws
 * `NodeError("json.field_missing")` when a step goes through a value of the wrong kind.
 */
export function setAt(root: unknown, segments: readonly PathSegment[], value: unknown): unknown {
  const write = (raw: unknown, i: number): unknown => {
    if (i === segments.length) return value;
    const seg = segments[i] as PathSegment;
    const here = showPath(segments.slice(0, i));
    const cur = openJson(raw, here);
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) throw missing(segments, `${here} is ${kindOf(cur)}, not an array`);
      if (seg > cur.length) throw missing(segments, `${here} has ${cur.length} items, so [${seg}] cannot be set (use [${cur.length}] to append)`);
      const copy = [...cur];
      copy[seg] = write(cur[seg], i + 1);
      return copy;
    }
    const base = cur === undefined ? {} : cur;
    if (!isObject(base)) throw missing(segments, `${here} is ${kindOf(cur)}, not an object`);
    return { ...base, [seg]: write(base[seg], i + 1) };
  };
  return write(root, 0);
}

/** Parses JSON text found where a step goes in; other values pass through. */
export function openJson(value: unknown, here: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (err) {
    const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    throw new NodeError("json.invalid_json", `${here} is text that is not valid JSON (${err instanceof Error ? err.message : String(err)}): ${JSON.stringify(shown)}.`, {
      details: { text: value.slice(0, 200) },
    });
  }
}

/** JSON as text: a string as it is, anything else as compact JSON; `null` for no value. */
export function jsonToText(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function missing(segments: readonly PathSegment[], why: string): NodeError {
  return new NodeError("json.field_missing", `Cannot reach ${showPath(segments)}: ${why}. Check the path or the JSON that feeds this node.`, {
    details: { path: showPath(segments) },
  });
}
