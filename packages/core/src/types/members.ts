/**
 * Members of a type (types.md §12): what `value.member` reads on a value of the type, for the
 * Get member / Set member nodes and split pins. Struct fields are members (instance fields can be
 * set; static fields are read from the type); `string` and lists have a read-only `length`.
 */
import type { FieldDecl, TypeDecl } from "../documents/model.js";
import type { TypeRef } from "./ir.js";
import { structLayout, withBuiltins } from "./layout.js";

/** Looks up a struct or enum by id (local → global → built-in → pack). */
export type TypeResolver = (id: string) => TypeDecl | undefined;

/** One member of a type. */
export interface TypeMember {
  name: string;
  title: string;
  type: TypeRef;
  /** Set member can replace it (struct fields only). */
  writable: boolean;
  description?: string;
}

/** A member reached through a path (`portrait.width`). */
export interface MemberPath {
  path: readonly string[];
  /** Type of the value at the end of the path. */
  type: TypeRef;
  /** Every step is a struct field. */
  writable: boolean;
  /** Titles of the steps, joined with `.` by UIs. */
  titles: readonly string[];
  description?: string;
}

const int: TypeRef = { kind: "primitive", name: "int" };
const opt = (of: TypeRef): TypeRef => (of.kind === "optional" ? of : { kind: "optional", of });

const LENGTH: TypeMember = { name: "length", title: "Length", type: int, writable: false, description: "Characters (code points) of a string, items of a list." };

function fieldMember(f: FieldDecl, writable: boolean): TypeMember {
  return { name: f.name, title: f.name, type: f.type, writable, ...(f.description === undefined ? {} : { description: f.description }) };
}

/**
 * The members of `type`, in display order. Members of an optional value are optional
 * themselves and read-only.
 *
 * @example
 * ```ts
 * typeMembers({ kind: "named", id: "briar.Image" }, resolve).map((m) => m.name);
 * // → ["data", "mime", "name", "size", "width", "height", "formats", "maxBytes", …]
 * ```
 */
export function typeMembers(type: TypeRef, given: TypeResolver): TypeMember[] {
  const resolve = withBuiltins(given);
  if (type.kind === "optional") return typeMembers(type.of, resolve).map((m) => ({ ...m, type: opt(m.type), writable: false }));
  if (type.kind === "named") {
    const decl = resolve(type.id);
    if (decl?.kind !== "struct") return [];
    const layout = structLayout(decl, resolve);
    return [...layout.fields.map((f) => fieldMember(f, true)), ...[...layout.statics.values()].map((s) => fieldMember(s.field, false))];
  }
  if (type.kind === "list" || (type.kind === "primitive" && type.name === "string")) return [LENGTH];
  return [];
}

/**
 * Follows `path` from `type`. Returns the member at its end, or what is wrong with the path.
 *
 * @example
 * ```ts
 * memberAt(characterType, ["portrait", "width"], resolve); // → { type: int?, writable: false, … }
 * ```
 */
export function memberAt(type: TypeRef, path: readonly string[], resolve: TypeResolver): MemberPath | { error: string } {
  if (path.length === 0) return { error: "The member path is empty." };
  let current = type;
  let writable = true;
  let description: string | undefined;
  const titles: string[] = [];
  for (const [i, name] of path.entries()) {
    const m = typeMembers(current, resolve).find((x) => x.name === name);
    if (!m) {
      const where = i === 0 ? "this type" : path.slice(0, i).join(".");
      const known = typeMembers(current, resolve).map((x) => x.name);
      return { error: `"${name}" is not a member of ${where}.${known.length > 0 ? ` Members: ${known.join(", ")}.` : " It has no members."}` };
    }
    current = m.type;
    writable &&= m.writable;
    titles.push(m.title);
    description = m.description;
  }
  return { path, type: current, writable, titles, ...(description === undefined ? {} : { description }) };
}

/**
 * Every member reachable from `type`, nested members after their parent, up to `depth` steps.
 * A struct is not entered again inside itself.
 */
export function memberPaths(type: TypeRef, resolve: TypeResolver, depth = 3): MemberPath[] {
  const out: MemberPath[] = [];
  const walk = (t: TypeRef, prefix: MemberPath | undefined, seen: ReadonlySet<string>) => {
    for (const m of typeMembers(t, resolve)) {
      const path: MemberPath = {
        path: [...(prefix?.path ?? []), m.name],
        type: m.type,
        writable: (prefix?.writable ?? true) && m.writable,
        titles: [...(prefix?.titles ?? []), m.title],
        ...(m.description === undefined ? {} : { description: m.description }),
      };
      out.push(path);
      const inner = m.type.kind === "optional" ? m.type.of : m.type;
      if (path.path.length >= depth || (inner.kind === "named" && seen.has(inner.id))) continue;
      // Length of text and lists says nothing more; do not list `length.…`.
      if (inner.kind === "primitive") continue;
      walk(m.type, path, inner.kind === "named" ? new Set([...seen, inner.id]) : seen);
    }
  };
  walk(type, undefined, type.kind === "named" ? new Set([type.id]) : new Set());
  return out;
}

/**
 * Reads `path` from `value` of `type`. A missing step (none / absent field) gives `null`; a
 * static field gives the type's value.
 */
export function readMember(value: unknown, type: TypeRef, path: readonly string[], given: TypeResolver): unknown {
  const resolve = withBuiltins(given);
  let current: unknown = value;
  let t = type;
  for (const name of path) {
    if (current === null || current === undefined) return null;
    if (t.kind === "optional") t = t.of;
    if (t.kind === "named") {
      const decl = resolve(t.id);
      if (decl?.kind !== "struct") return null;
      const layout = structLayout(decl, resolve);
      const s = layout.statics.get(name);
      if (s) {
        current = s.value;
        t = s.field.type;
        continue;
      }
      const field = layout.fields.find((f) => f.name === name);
      if (!field) return null;
      const obj = typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      current = name in obj ? obj[name] : (field.default ?? null);
      t = field.type;
      continue;
    }
    if (name !== "length") return null;
    current = typeof current === "string" ? [...current].length : Array.isArray(current) ? current.length : null;
    t = int;
  }
  return current ?? null;
}

/**
 * A copy of struct `value` with the member at `path` replaced (nested structs are copied
 * along the way; `value` is not changed). Every step must be a struct field.
 */
export function writeMember(value: unknown, type: TypeRef, path: readonly string[], next: unknown, given: TypeResolver): unknown {
  const resolve = withBuiltins(given);
  const [name, ...rest] = path;
  if (name === undefined) return next;
  if (type.kind !== "named") return value;
  const decl = resolve(type.id);
  const field = decl?.kind === "struct" ? structLayout(decl, resolve).fields.find((f) => f.name === name) : undefined;
  if (!field) return value;
  const obj = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const inner = name in obj ? obj[name] : (field.default ?? null);
  return { ...obj, [name]: writeMember(inner, field.type, rest, next, resolve) };
}
