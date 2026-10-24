/**
 * Members of a type (types.md §12): what `value.member` reads on a value of the type, for the
 * Get member / Set member nodes. Struct fields can be read and set; members of primitives
 * (media metadata, error fields, length of text and lists) are read-only.
 */
import type { TypeDecl } from "../documents/model.js";
import type { MediaEntry } from "../interfaces/media-registry.js";
import type { MediaRef, TypeRef } from "./ir.js";
import { MEDIA_FORMATS, isMediaRef } from "./media.js";

/** Looks up a struct or enum by id (local → global → pack). */
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

interface BuiltinMember extends TypeMember {
  /** `entry` is the registry entry of a media value (media members only). */
  read(value: unknown, entry: MediaEntry | undefined): unknown;
}

const text: TypeRef = { kind: "primitive", name: "text" };
const int: TypeRef = { kind: "primitive", name: "int" };
const float: TypeRef = { kind: "primitive", name: "float" };
const opt = (of: TypeRef): TypeRef => (of.kind === "optional" ? of : { kind: "optional", of });

const metaNumber = (key: string) => (_v: unknown, e: MediaEntry | undefined) => {
  const n = e?.meta?.[key];
  return typeof n === "number" ? n : null;
};

/** File extension of a media entry: from its file name, else from its mime type (`png`). */
export function mediaExtension(entry: Pick<MediaEntry, "mime" | "meta">): string {
  const name = entry.meta?.filename;
  const dot = typeof name === "string" ? name.lastIndexOf(".") : -1;
  if (typeof name === "string" && dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  for (const [format, mime] of Object.entries(MEDIA_FORMATS)) if (mime === entry.mime) return format;
  return (entry.mime.split("/")[1] ?? "").replace(/^x-/, "").split("+")[0] ?? "";
}

function member(name: string, title: string, type: TypeRef, read: BuiltinMember["read"], description?: string): BuiltinMember {
  return { name, title, type, writable: false, read, ...(description === undefined ? {} : { description }) };
}

const MEDIA_COMMON: readonly BuiltinMember[] = [
  member("id", "Media id", text, (v) => (isMediaRef(v) ? v.mediaId : null), "The id of the media's registry entry."),
  member("mime", "Mime type", text, (_v, e) => e?.mime ?? null),
  member("extension", "Extension", text, (_v, e) => (e ? mediaExtension(e) : null), "From the file name, else from the mime type (png, jpeg, mp4, …)."),
  member("name", "File name", opt(text), (_v, e) => (typeof e?.meta?.filename === "string" ? e.meta.filename : null)),
  member("size", "Size (bytes)", opt(int), (_v, e) => e?.bytes ?? null),
  member("url", "Web address", opt(text), (_v, e) => (e?.source.kind === "link" ? e.source.url : null), "For media linked from the web; none for media Briarflow keeps."),
];
const WIDTH = member("width", "Width", opt(int), metaNumber("width"), "In pixels; none when unknown.");
const HEIGHT = member("height", "Height", opt(int), metaNumber("height"), "In pixels; none when unknown.");
const DURATION = member("duration", "Duration (s)", opt(float), metaNumber("durationSec"));
const FPS = member("fps", "Frames per second", opt(float), metaNumber("fps"));
const errorField = (key: "code" | "message" | "node" | "nodeId") => (v: unknown) => {
  const x = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  return typeof x === "string" ? x : null;
};
const LENGTH = member("length", "Length", int, (v: unknown) => (typeof v === "string" ? [...v].length : Array.isArray(v) ? v.length : null));

const PRIMITIVE_MEMBERS: Readonly<Record<string, readonly BuiltinMember[]>> = {
  image: [...MEDIA_COMMON, WIDTH, HEIGHT],
  video: [...MEDIA_COMMON, WIDTH, HEIGHT, DURATION, FPS],
  audio: [...MEDIA_COMMON, DURATION],
  model3d: MEDIA_COMMON,
  file: MEDIA_COMMON,
  text: [LENGTH],
  error: [
    member("code", "Code", text, errorField("code"), "Stable code, e.g. node.timeout."),
    member("message", "Message", text, errorField("message")),
    member("node", "Node", opt(text), errorField("node"), "Title of the node that failed."),
    member("nodeId", "Node id", opt(text), errorField("nodeId")),
  ],
};

function builtinMembers(type: TypeRef): readonly BuiltinMember[] {
  if (type.kind === "primitive") return PRIMITIVE_MEMBERS[type.name] ?? [];
  if (type.kind === "list") return [LENGTH];
  return [];
}

/**
 * The members of `type`, in display order. Members of an optional value are optional
 * themselves and read-only.
 *
 * @example
 * ```ts
 * typeMembers({ kind: "primitive", name: "image" }, resolve).map((m) => m.name);
 * // → ["id", "mime", "extension", "name", "size", "url", "width", "height"]
 * ```
 */
export function typeMembers(type: TypeRef, resolve: TypeResolver): TypeMember[] {
  if (type.kind === "optional") return typeMembers(type.of, resolve).map((m) => ({ ...m, type: opt(m.type), writable: false }));
  if (type.kind === "named") {
    const decl = resolve(type.id);
    if (decl?.kind !== "struct") return [];
    return decl.fields.map((f) => ({ name: f.name, title: f.name, type: f.type, writable: true, ...(f.description === undefined ? {} : { description: f.description }) }));
  }
  return builtinMembers(type).map(({ read: _read, ...m }) => m);
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
      if (inner.kind === "primitive" && (inner.name === "int" || inner.name === "float" || inner.name === "text")) continue;
      walk(m.type, path, inner.kind === "named" ? new Set([...seen, inner.id]) : seen);
    }
  };
  walk(type, undefined, type.kind === "named" ? new Set([type.id]) : new Set());
  return out;
}

/**
 * Reads `path` from `value` of `type`. A missing step (none / absent field) gives `null`. Media
 * members are read from the media's registry entry, found with `entryOf`.
 */
export async function readMember(
  value: unknown,
  type: TypeRef,
  path: readonly string[],
  resolve: TypeResolver,
  entryOf?: (ref: MediaRef) => Promise<MediaEntry | undefined>,
): Promise<unknown> {
  let current: unknown = value;
  let t = type;
  for (const name of path) {
    if (current === null || current === undefined) return null;
    if (t.kind === "optional") t = t.of;
    if (t.kind === "named") {
      const decl = resolve(t.id);
      const field = decl?.kind === "struct" ? decl.fields.find((f) => f.name === name) : undefined;
      if (!field) return null;
      const obj = typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      current = name in obj ? obj[name] : (field.default ?? null);
      t = field.type;
      continue;
    }
    const m = builtinMembers(t).find((x) => x.name === name);
    if (!m) return null;
    const entry = t.kind === "primitive" && MEDIA_MEMBER_KINDS.has(t.name) && isMediaRef(current) && entryOf ? await entryOf(current) : undefined;
    current = m.read(current, entry);
    t = m.type;
  }
  return current ?? null;
}

const MEDIA_MEMBER_KINDS = new Set(["image", "video", "audio", "model3d", "file"]);

/**
 * A copy of struct `value` with the member at `path` replaced (nested structs are copied
 * along the way; `value` is not changed). Every step must be a struct field.
 */
export function writeMember(value: unknown, type: TypeRef, path: readonly string[], next: unknown, resolve: TypeResolver): unknown {
  const [name, ...rest] = path;
  if (name === undefined) return next;
  if (type.kind !== "named") return value;
  const decl = resolve(type.id);
  const field = decl?.kind === "struct" ? decl.fields.find((f) => f.name === name) : undefined;
  if (!field) return value;
  const obj = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const inner = name in obj ? obj[name] : (field.default ?? null);
  return { ...obj, [name]: writeMember(inner, field.type, rest, next, resolve) };
}
