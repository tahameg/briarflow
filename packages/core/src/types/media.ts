/**
 * Media formats, media values and entry checks (docs/specs/types.md §6, §8; media.md).
 */
import { MediaError } from "../errors.js";
import type { Diagnostic } from "../validation/diagnostic.js";
import type { MediaEntry } from "../interfaces/media-registry.js";
import type { MediaPrimitiveName, MediaRef, PrimitiveTypeRef } from "./ir.js";

/** Format name → mime type (types.md §6). Unknown formats are treated as literal mimes. */
export const MEDIA_FORMATS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
};

/** URI scheme of media stored in a `MediaStore`. */
export const MEDIA_URI_SCHEME = "briar-media://";

/**
 * Mime type for a format name (`"png"` → `"image/png"`); unknown names are returned lowercased
 * as literal mimes.
 */
export function formatToMime(format: string): string {
  return MEDIA_FORMATS[format.toLowerCase()] ?? format.toLowerCase();
}

/** Media ids: what a {@link MediaRef} carries (types.md §8). */
export const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Is `value` a media value (`{ mediaId }` and nothing else)?
 *
 * @example
 * ```ts
 * isMediaRef({ mediaId: "med_1" }); // true
 * ```
 */
export function isMediaRef(value: unknown): value is MediaRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "mediaId" && typeof (value as MediaRef).mediaId === "string" && MEDIA_ID_PATTERN.test((value as MediaRef).mediaId);
}

/**
 * Validates the shape of a media value (types.md §8): `{ mediaId }` with a valid id. Whether the
 * entry exists, and its mime and constraints, are checked against the media registry when a
 * node reads it ({@link checkMediaEntry}). Code: `media.invalid_ref`.
 *
 * @example
 * ```ts
 * validateMediaRef({ mediaId: "med_1" }, "image", "inputs.photo"); // []
 * ```
 */
export function validateMediaRef(value: unknown, primitive: MediaPrimitiveName, path: string): Diagnostic[] {
  if (isMediaRef(value)) return [];
  const v = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const reason =
    v && typeof v["uri"] === "string"
      ? "media values are { mediaId } now; upload the file again or use the id of its registry entry"
      : v && "mediaId" in v && Object.keys(v).length === 1
        ? `mediaId must be 1–128 of A–Z, a–z, 0–9, _ or - (got ${describe(v["mediaId"])})`
        : v
          ? `expected { mediaId } and nothing else (got keys ${Object.keys(v).join(", ") || "none"})`
          : `expected a media value { mediaId } (got ${describe(value)})`;
  return [
    {
      severity: "error",
      code: "media.invalid_ref",
      message: `${path} is not a valid ${primitive}: ${reason}.`,
      path: { valuePath: path },
    },
  ];
}

/**
 * Checks a registry entry against the media type a port expects (types.md §6, §8): the mime
 * fits the primitive (`media.kind_mismatch`) and the constraints hold (`value.invalid`).
 * Constraints on size, dimensions or duration are skipped when the entry does not know them.
 *
 * @example
 * ```ts
 * checkMediaEntry(entry, { kind: "primitive", name: "image", constraints: { maxWidth: 2048 } }, "inputs.photo");
 * ```
 */
export function checkMediaEntry(entry: Pick<MediaEntry, "mime" | "bytes" | "meta">, type: PrimitiveTypeRef, path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (code: string, message: string) => out.push({ severity: "error", code, message: `${path} ${message}.`, path: { valuePath: path } });
  const kind = type.name as MediaPrimitiveName;
  if (!mimeMatchesKind(entry.mime, kind)) {
    add("media.kind_mismatch", `is ${entry.mime}, which is not a${kind === "image" || kind === "audio" ? "n" : ""} ${kind} (${KIND_HINT[kind]})`);
    return out;
  }
  const c = (type.constraints ?? {}) as Record<string, unknown>;
  const formats = c["formats"];
  if (Array.isArray(formats) && formats.length > 0) {
    const mimes = formats.map((f) => formatToMime(String(f)));
    if (!mimes.includes(entry.mime)) add("value.invalid", `must be one of the formats ${formats.join(", ")} (got ${entry.mime})`);
  }
  const maxBytes = c["maxBytes"];
  if (typeof maxBytes === "number" && typeof entry.bytes === "number" && entry.bytes > maxBytes) add("value.invalid", `must be at most ${maxBytes} bytes`);
  const meta = entry.meta ?? {};
  const dims: [string, unknown, (n: number) => string, boolean][] = [
    ["minWidth", meta.width, (n) => `must be at least ${n} px wide`, true],
    ["maxWidth", meta.width, (n) => `must be at most ${n} px wide`, false],
    ["minHeight", meta.height, (n) => `must be at least ${n} px tall`, true],
    ["maxHeight", meta.height, (n) => `must be at most ${n} px tall`, false],
  ];
  for (const [key, actual, msg, isMin] of dims) {
    const bound = c[key];
    if (typeof bound !== "number" || typeof actual !== "number") continue;
    if (isMin ? actual < bound : actual > bound) add("value.invalid", msg(bound));
  }
  const maxDuration = c["maxDurationSec"];
  if (typeof maxDuration === "number" && typeof meta.durationSec === "number" && meta.durationSec > maxDuration) {
    add("value.invalid", `must be at most ${maxDuration} seconds long`);
  }
  return out;
}

/**
 * Problems with a {@link MediaMeta} object (media.md §2): `width`/`height` whole numbers > 0,
 * `durationSec` ≥ 0, `fps` > 0, `filename` text. Empty when it is fine.
 */
export function mediaMetaProblems(meta: unknown): string[] {
  if (meta === undefined) return [];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return ["meta must be an object"];
  const m = meta as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["width", "height"]) {
    if (m[k] !== undefined && (!Number.isSafeInteger(m[k]) || (m[k] as number) <= 0)) out.push(`meta.${k} must be a whole number > 0 (got ${describe(m[k])})`);
  }
  const d = m["durationSec"];
  if (d !== undefined && (typeof d !== "number" || !Number.isFinite(d) || d < 0)) out.push(`meta.durationSec must be a number >= 0 (got ${describe(d)})`);
  const fps = m["fps"];
  if (fps !== undefined && (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0)) out.push(`meta.fps must be a number > 0 (got ${describe(fps)})`);
  if (m["filename"] !== undefined && typeof m["filename"] !== "string") out.push(`meta.filename must be text (got ${describe(m["filename"])})`);
  return out;
}

/** Mime types: lowercase, no parameters (types.md §8). */
export const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const KIND_HINT: Record<MediaPrimitiveName, string> = {
  image: "expected image/*",
  video: "expected video/*",
  audio: "expected audio/*",
  model3d: "expected model/* or application/octet-stream",
  file: "any mime",
};

/** Internal: does a mime fit a media primitive? */
export function mimeMatchesKind(mime: string, primitive: MediaPrimitiveName): boolean {
  switch (primitive) {
    case "image":
      return mime.startsWith("image/");
    case "video":
      return mime.startsWith("video/");
    case "audio":
      return mime.startsWith("audio/");
    case "model3d":
      return mime.startsWith("model/") || mime === "application/octet-stream";
    case "file":
      return true;
  }
}

/** Is `uri` a `briar-media://<id>` uri or an absolute http(s) URL? */
export function isValidMediaUri(uri: string): boolean {
  if (uri.startsWith(MEDIA_URI_SCHEME)) return MEDIA_ID_PATTERN.test(uri.slice(MEDIA_URI_SCHEME.length));
  if (!/^https?:\/\//i.test(uri)) return false;
  try {
    const u = new URL(uri);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** Internal: short JSON rendering of a value for messages. */
export function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/** Extracts the media id from `briar-media://<id>` (or a bare id); `undefined` otherwise. */
export function mediaIdFromUri(uriOrId: string): string | undefined {
  const id = uriOrId.startsWith(MEDIA_URI_SCHEME) ? uriOrId.slice(MEDIA_URI_SCHEME.length) : uriOrId;
  return MEDIA_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Normalizes a mime type for storage (storage.md §2.2): parameters stripped, lowercased,
 * trimmed. Throws `MediaError("media.invalid_mime")` (`details: { mime }`) when the result is
 * not a valid mime type.
 *
 * @example
 * ```ts
 * normalizeMime("Image/PNG; q=1"); // "image/png"
 * ```
 */
export function normalizeMime(mime: unknown): string {
  const m = typeof mime === "string" ? (mime.split(";")[0] ?? "").trim().toLowerCase() : "";
  if (!MIME_PATTERN.test(m)) {
    throw new MediaError("media.invalid_mime", `${JSON.stringify(mime) ?? String(mime)} is not a valid mime type. Use a type like image/png.`, {
      details: { mime },
    });
  }
  return m;
}
