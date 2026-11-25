/**
 * Finds the binary values inside a value, guided by its type (media.md §4).
 */
import type { TypeDecl } from "../documents/model.js";
import { BUILTIN, mediaKindOfBuiltin } from "../types/builtins.js";
import type { MediaKind, MediaRef, TypeRef } from "../types/ir.js";
import { structLayout } from "../types/layout.js";
import { isMediaRef } from "../types/media.js";

/** The media struct a binary value is the `data` of. */
export interface MediaSlot {
  kind: MediaKind;
  /** The struct's limits: its static fields (formats, maxBytes, minWidth…). */
  limits: ReadonlyMap<string, unknown>;
}

/** One binary value found by {@link findMedia}. */
export interface FoundMedia {
  ref: MediaRef;
  /** Set when it is the `data` of a media struct (Image, Video…). */
  media: MediaSlot | undefined;
  /** Value path from the root, e.g. `portrait.image.data` or `[2].data`. */
  path: string;
}

/**
 * Every binary value in `value`. Typed places are found by their type; vars and Json are
 * searched by shape (`{ mediaId }`).
 *
 * @example
 * ```ts
 * findMedia({ data: { mediaId: "med_1" }, mime: "image/png" }, { kind: "named", id: "briar.Image" }, getType);
 * // [{ ref: { mediaId: "med_1" }, media: { kind: "image", limits }, path: "data" }]
 * ```
 */
export function findMedia(value: unknown, type: TypeRef | undefined, getType: (id: string) => TypeDecl | undefined, path = ""): FoundMedia[] {
  const out: FoundMedia[] = [];
  walk(value, type, getType, path, out, 0, undefined);
  return out;
}

/** Does a value of `type` hold binary anywhere (through lists, optionals and struct fields)? */
export function typeHasMedia(type: TypeRef, getType: (id: string) => TypeDecl | undefined, seen: ReadonlySet<string> = new Set()): boolean {
  switch (type.kind) {
    case "primitive":
      return type.name === "binary";
    case "optional":
    case "list":
      return typeHasMedia(type.of, getType, seen);
    case "named": {
      if (seen.has(type.id)) return false;
      const decl = getType(type.id);
      if (decl?.kind !== "struct") return false;
      const next = new Set([...seen, type.id]);
      return structLayout(decl, getType).fields.some((f) => typeHasMedia(f.type, getType, next));
    }
    default:
      return false;
  }
}

function walk(
  value: unknown,
  type: TypeRef | undefined,
  getType: (id: string) => TypeDecl | undefined,
  path: string,
  out: FoundMedia[],
  depth: number,
  slot: MediaSlot | undefined,
): void {
  if (value === null || typeof value !== "object" || depth > 64) return;
  const at = (key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`);
  if (type === undefined || type.kind === "var" || (type.kind === "named" && type.id === BUILTIN.Json)) {
    if (isMediaRef(value)) {
      out.push({ ref: value, media: undefined, path });
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, undefined, getType, at(i), out, depth + 1, undefined));
    else for (const [k, v] of Object.entries(value)) walk(v, undefined, getType, at(k), out, depth + 1, undefined);
    return;
  }
  switch (type.kind) {
    case "primitive":
      if (type.name === "binary" && isMediaRef(value)) out.push({ ref: value, media: slot, path });
      return;
    case "optional":
      walk(value, type.of, getType, path, out, depth + 1, slot);
      return;
    case "list":
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, type.of, getType, at(i), out, depth + 1, undefined));
      return;
    case "named": {
      const decl = getType(type.id);
      if (decl?.kind !== "struct" || Array.isArray(value)) return;
      const layout = structLayout(decl, getType);
      const kind = mediaKindOfBuiltin(layout.root);
      const rec = value as Record<string, unknown>;
      for (const f of layout.fields) {
        if (!(f.name in rec)) continue;
        const inner = kind !== undefined && f.name === "data" ? { kind, limits: new Map([...layout.statics].map(([k, s]) => [k, s.value])) } : undefined;
        walk(rec[f.name], f.type, getType, at(f.name), out, depth + 1, inner);
      }
      return;
    }
  }
}
