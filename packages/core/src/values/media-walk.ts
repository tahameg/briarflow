/**
 * Finds the media values inside a value, guided by its type (media.md §4).
 */
import type { TypeDecl } from "../documents/model.js";
import { MEDIA_PRIMITIVE_NAMES, type MediaRef, type PrimitiveTypeRef, type TypeRef } from "../types/ir.js";
import { isMediaRef } from "../types/media.js";

/** One media value found by {@link findMedia}. */
export interface FoundMedia {
  ref: MediaRef;
  /** The media type at that place; `undefined` where the type is a var or json (found by shape). */
  type: PrimitiveTypeRef | undefined;
  /** Value path from the root, e.g. `portrait.image` or `[2]`. */
  path: string;
}

/**
 * Every media value in `value`. Typed places are found by their type; vars and json are
 * searched by shape (`{ mediaId }`).
 *
 * @example
 * ```ts
 * findMedia({ mediaId: "med_1" }, { kind: "primitive", name: "image" }, () => undefined); // [{ ref, type, path: "" }]
 * ```
 */
export function findMedia(value: unknown, type: TypeRef | undefined, getType: (id: string) => TypeDecl | undefined, path = ""): FoundMedia[] {
  const out: FoundMedia[] = [];
  walk(value, type, getType, path, out, 0);
  return out;
}

/** Does a value of `type` hold media anywhere (through lists, optionals and struct fields)? */
export function typeHasMedia(type: TypeRef, getType: (id: string) => TypeDecl | undefined, seen: ReadonlySet<string> = new Set()): boolean {
  switch (type.kind) {
    case "primitive":
      return (MEDIA_PRIMITIVE_NAMES as readonly string[]).includes(type.name);
    case "optional":
    case "list":
      return typeHasMedia(type.of, getType, seen);
    case "named": {
      if (seen.has(type.id)) return false;
      const decl = getType(type.id);
      if (decl?.kind !== "struct") return false;
      const next = new Set([...seen, type.id]);
      return decl.fields.some((f) => typeHasMedia(f.type, getType, next));
    }
    default:
      return false;
  }
}

function walk(value: unknown, type: TypeRef | undefined, getType: (id: string) => TypeDecl | undefined, path: string, out: FoundMedia[], depth: number): void {
  if (value === null || typeof value !== "object" || depth > 64) return;
  const at = (key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`);
  if (type === undefined || type.kind === "var" || (type.kind === "primitive" && type.name === "json")) {
    if (isMediaRef(value)) {
      out.push({ ref: value, type: undefined, path });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, undefined, getType, at(i), out, depth + 1));
    else for (const [k, v] of Object.entries(value)) walk(v, undefined, getType, at(k), out, depth + 1);
    return;
  }
  switch (type.kind) {
    case "primitive":
      if ((MEDIA_PRIMITIVE_NAMES as readonly string[]).includes(type.name) && isMediaRef(value)) out.push({ ref: value, type, path });
      return;
    case "optional":
      walk(value, type.of, getType, path, out, depth + 1);
      return;
    case "list":
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, type.of, getType, at(i), out, depth + 1));
      return;
    case "named": {
      const decl = getType(type.id);
      if (decl?.kind !== "struct" || Array.isArray(value)) return;
      const rec = value as Record<string, unknown>;
      for (const f of decl.fields) if (f.name in rec) walk(rec[f.name], f.type, getType, at(f.name), out, depth + 1);
      return;
    }
  }
}
