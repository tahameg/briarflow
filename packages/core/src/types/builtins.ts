/**
 * Built-in structs and enums (docs/specs/types.md §1.2): text, media, JSON, secrets and errors
 * are structs built from the primitives, always in scope, under ids `briar.<Name>`. Their
 * limits (a text's maximum length, an image's formats…) are static fields: a struct that
 * extends one gives them other values (`ShortText extends Text { maxLength = 80 }`).
 */
import type { EnumDecl, FieldDecl, StructDecl, TypeDecl } from "../documents/model.js";
import type { MediaKind, MediaRef, TypeRef } from "./ir.js";

const int: TypeRef = { kind: "primitive", name: "int" };
const float: TypeRef = { kind: "primitive", name: "float" };
const bool: TypeRef = { kind: "primitive", name: "bool" };
const string: TypeRef = { kind: "primitive", name: "string" };
const binary: TypeRef = { kind: "primitive", name: "binary" };
const opt = (of: TypeRef): TypeRef => ({ kind: "optional", of });
const named = (id: string): TypeRef => ({ kind: "named", id });

/** Ids of the built-in types. */
export const BUILTIN = {
  Text: "briar.Text",
  Image: "briar.Image",
  Video: "briar.Video",
  Audio: "briar.Audio",
  Model3D: "briar.Model3D",
  File: "briar.File",
  Json: "briar.Json",
  SecretKind: "briar.SecretKind",
  Secret: "briar.Secret",
  ApiKey: "briar.ApiKey",
  Error: "briar.Error",
} as const;

/** The pack-like namespace of built-in ids. */
export const BUILTIN_NAMESPACE = "briar";

const field = (name: string, type: TypeRef, description?: string): FieldDecl => ({
  name,
  type,
  ...(description === undefined ? {} : { description }),
});
const fixed = (name: string, type: TypeRef, value: unknown, description: string): FieldDecl => ({
  name,
  type,
  static: true,
  default: value,
  description,
});

const MEDIA_INSTANCE: readonly FieldDecl[] = [
  field("data", binary, "The bytes (an entry of the media registry)."),
  field("mime", string, "Mime type, e.g. image/png. The registry entry is authoritative."),
  field("name", opt(string), "File name, when known."),
  field("size", opt(int), "Size in bytes, when known."),
];
const MEDIA_STATIC: readonly FieldDecl[] = [
  fixed("formats", { kind: "list", of: string }, [], "Allowed formats (png, jpeg, mp4…) or mime types; empty = any of its kind."),
  fixed("maxBytes", opt(int), null, "Largest allowed size in bytes."),
];
const DIMENSIONS: readonly FieldDecl[] = [
  field("width", opt(int), "In pixels, when known."),
  field("height", opt(int), "In pixels, when known."),
];
const DIMENSION_LIMITS: readonly FieldDecl[] = [
  fixed("minWidth", opt(int), null, "Narrowest allowed width in pixels."),
  fixed("maxWidth", opt(int), null, "Widest allowed width in pixels."),
  fixed("minHeight", opt(int), null, "Lowest allowed height in pixels."),
  fixed("maxHeight", opt(int), null, "Highest allowed height in pixels."),
];
const DURATION_LIMIT = fixed("maxDuration", opt(float), null, "Longest allowed duration in seconds.");

const struct = (id: string, description: string, fields: readonly FieldDecl[]): StructDecl => ({
  kind: "struct",
  id,
  name: id.slice(BUILTIN_NAMESPACE.length + 1),
  description,
  fields,
});

/** Every built-in type, in display order. */
export const BUILTIN_TYPES: readonly TypeDecl[] = [
  struct(BUILTIN.Text, "Text with limits, for what people type. Unlimited text is a plain string.", [
    field("value", string),
    fixed("minLength", int, 0, "Fewest characters (Unicode code points)."),
    fixed("maxLength", opt(int), null, "Most characters; none = no limit."),
    fixed("pattern", opt(string), null, "A regular expression the whole text must match (u flag)."),
    fixed("multiline", bool, false, "Edited in a multi-line box (a hint for editors)."),
  ]),
  struct(BUILTIN.Image, "A picture.", [...MEDIA_INSTANCE, ...DIMENSIONS, ...MEDIA_STATIC, ...DIMENSION_LIMITS]),
  struct(BUILTIN.Video, "A video.", [
    ...MEDIA_INSTANCE,
    ...DIMENSIONS,
    field("duration", opt(float), "In seconds, when known."),
    field("fps", opt(float), "Frames per second, when known."),
    ...MEDIA_STATIC,
    DURATION_LIMIT,
  ]),
  struct(BUILTIN.Audio, "A sound.", [...MEDIA_INSTANCE, field("duration", opt(float), "In seconds, when known."), ...MEDIA_STATIC, DURATION_LIMIT]),
  struct(BUILTIN.Model3D, "A 3D model.", [...MEDIA_INSTANCE, ...MEDIA_STATIC]),
  struct(BUILTIN.File, "Any file.", [...MEDIA_INSTANCE, ...MEDIA_STATIC]),
  struct(BUILTIN.Json, "A JSON document, as text. Read it with Get field or the As … conversions.", [field("text", string)]),
  {
    kind: "enum",
    id: BUILTIN.SecretKind,
    name: "SecretKind",
    description: "Which secrets a picker offers.",
    members: [
      { value: "apiKey", label: "API key" },
      { value: "text", label: "Text" },
      { value: "number", label: "Number" },
      { value: "json", label: "JSON" },
    ],
  } satisfies EnumDecl,
  struct(BUILTIN.Secret, "The name of a secret in the vault; nodes read its value on the server.", [
    field("name", string),
    fixed("kind", opt(named(BUILTIN.SecretKind)), null, "Which secrets fit; none = any."),
  ]),
  {
    ...struct(BUILTIN.ApiKey, "An API key in the vault.", [fixed("kind", opt(named(BUILTIN.SecretKind)), "apiKey", "Always apiKey.")]),
    extends: BUILTIN.Secret,
  },
  struct(BUILTIN.Error, "Why a node failed.", [
    field("code", string, "Stable code, e.g. node.timeout."),
    field("message", string),
    field("node", opt(string), "Title of the node that failed."),
    field("nodeId", opt(string)),
    field("details", opt(named(BUILTIN.Json))),
  ]),
];

const BY_ID = new Map(BUILTIN_TYPES.map((d) => [d.id, d]));

/** The built-in declaration with this id, if any. */
export function builtinType(id: string): TypeDecl | undefined {
  return BY_ID.get(id);
}

/** Is `id` the id of a built-in type? */
export function isBuiltinId(id: string): boolean {
  return BY_ID.has(id);
}

/** Built-in type names (`Text`, `Image`…): no user or pack type may use them. */
export const BUILTIN_TYPE_NAMES: readonly string[] = BUILTIN_TYPES.map((d) => d.name);

const MEDIA_ROOTS: Readonly<Record<string, MediaKind>> = {
  [BUILTIN.Image]: "image",
  [BUILTIN.Video]: "video",
  [BUILTIN.Audio]: "audio",
  [BUILTIN.Model3D]: "model3d",
  [BUILTIN.File]: "file",
};

/** The media kind of a built-in media struct id (`briar.Image` → `image`), if it is one. */
export function mediaKindOfBuiltin(id: string): MediaKind | undefined {
  return MEDIA_ROOTS[id];
}

/** The built-in media struct id of a kind (`image` → `briar.Image`). */
export function mediaBuiltinOf(kind: MediaKind): string {
  return { image: BUILTIN.Image, video: BUILTIN.Video, audio: BUILTIN.Audio, model3d: BUILTIN.Model3D, file: BUILTIN.File }[kind];
}

/** Value of `Text`. */
export interface TextValue {
  value: string;
}

/** Fields every media value has. */
export interface MediaValue {
  data: MediaRef;
  mime: string;
  name: string | null;
  size: number | null;
}

/** Value of `Image`. */
export interface ImageValue extends MediaValue {
  width: number | null;
  height: number | null;
}

/** Value of `Video`. */
export interface VideoValue extends ImageValue {
  duration: number | null;
  fps: number | null;
}

/** Value of `Audio`. */
export interface AudioValue extends MediaValue {
  duration: number | null;
}

/** Value of `Json`: the JSON document as text. */
export interface JsonText {
  text: string;
}

/** Value of `Secret` / `ApiKey`: the vault secret's name. */
export interface SecretValue {
  name: string;
}

/** Value of `Error`. */
export interface ErrorValue {
  code: string;
  message: string;
  node?: string | null;
  nodeId?: string | null;
  details?: JsonText | null;
}

/** A Text value. */
export const textValue = (value: string): TextValue => ({ value });

/** A Json value from any JSON-compatible data. */
export const jsonText = (data: unknown): JsonText => ({ text: JSON.stringify(data ?? null) });

/**
 * Reads a Json value's document. Throws `SyntaxError` when the text is not JSON.
 *
 * @example
 * ```ts
 * parseJsonText({ text: '{"a":1}' }); // { a: 1 }
 * ```
 */
export const parseJsonText = (value: JsonText): unknown => JSON.parse(value.text);

/** What a media value is made from: the registry entry's facts (or what a node knows). */
export interface MediaInfo {
  mime: string;
  bytes?: number;
  meta?: { width?: number; height?: number; durationSec?: number; fps?: number; filename?: string; [key: string]: unknown };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A media struct value (Image, Video, Audio, Model3D, File) for a registry entry.
 *
 * @example
 * ```ts
 * const ref = await ctx.media.put(bytes, { mime: "image/png", meta: { width: 512, height: 512 } });
 * return { image: mediaValue("image", ref, { mime: "image/png", meta: { width: 512, height: 512 } }) };
 * ```
 */
export function mediaValue(kind: "image", ref: MediaRef, info: MediaInfo): ImageValue;
export function mediaValue(kind: "video", ref: MediaRef, info: MediaInfo): VideoValue;
export function mediaValue(kind: "audio", ref: MediaRef, info: MediaInfo): AudioValue;
export function mediaValue(kind: MediaKind, ref: MediaRef, info: MediaInfo): MediaValue;
export function mediaValue(kind: MediaKind, ref: MediaRef, info: MediaInfo): MediaValue {
  const meta = info.meta ?? {};
  const base: MediaValue = { data: ref, mime: info.mime, name: typeof meta.filename === "string" ? meta.filename : null, size: num(info.bytes) };
  if (kind === "image") {
    const image: ImageValue = { ...base, width: num(meta.width), height: num(meta.height) };
    return image;
  }
  if (kind === "video") {
    const video: VideoValue = { ...base, width: num(meta.width), height: num(meta.height), duration: num(meta.durationSec), fps: num(meta.fps) };
    return video;
  }
  if (kind === "audio") {
    const audio: AudioValue = { ...base, duration: num(meta.durationSec) };
    return audio;
  }
  return base;
}

/** The binary ref inside a media value, or the ref itself when given one. */
export function mediaRefOf(value: MediaValue | MediaRef): MediaRef {
  return "data" in value ? value.data : value;
}
