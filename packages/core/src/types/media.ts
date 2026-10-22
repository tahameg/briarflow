/**
 * Media formats and MediaRef validation (docs/specs/types.md §6, §8).
 */
import { MediaError } from "../errors.js";
import type { Diagnostic } from "../validation/diagnostic.js";
import type { MediaPrimitiveName } from "./ir.js";

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

/**
 * Validates a MediaRef against the rules of types.md §8 (uri, mime, kind match, bytes, hash,
 * meta, no extra keys). Codes: `media.invalid_uri`, `media.invalid_mime`,
 * `media.kind_mismatch`, `media.invalid_ref`. Does not check constraints.
 *
 * @example
 * ```ts
 * validateMediaRef({ uri: "briar-media://m_1", mime: "image/png" }, "image", "inputs.photo"); // []
 * ```
 */
export function validateMediaRef(value: unknown, primitive: MediaPrimitiveName, path: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (code: string, reason: string) =>
    out.push({
      severity: "error",
      code,
      message: `${path} is not a valid ${primitive}: ${reason}.`,
      path: { valuePath: path },
    });
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    add("media.invalid_ref", `expected a media reference object { uri, mime } (got ${describe(value)})`);
    return out;
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (v[key] !== undefined && !MEDIA_REF_KEYS.includes(key)) add("media.invalid_ref", `unknown key "${key}" (allowed: ${MEDIA_REF_KEYS.join(", ")})`);
  }
  const uri = v["uri"];
  if (typeof uri !== "string" || !isValidMediaUri(uri)) {
    add("media.invalid_uri", `uri must be briar-media://<id> or an http(s) URL (got ${describe(uri)})`);
  }
  const mime = v["mime"];
  if (typeof mime !== "string" || !MIME_PATTERN.test(mime)) {
    add("media.invalid_mime", `mime must be a lowercase mime type like image/png without parameters (got ${describe(mime)})`);
  } else if (!mimeMatchesKind(mime, primitive)) {
    add("media.kind_mismatch", `mime ${mime} does not fit ${primitive} (${KIND_HINT[primitive]})`);
  }
  const bytes = v["bytes"];
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 0)) {
    add("media.invalid_ref", `bytes must be a whole number >= 0 (got ${describe(bytes)})`);
  }
  const hash = v["hash"];
  if (hash !== undefined && (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) {
    add("media.invalid_ref", "hash must be 64 lowercase hex characters (sha-256)");
  }
  const meta = v["meta"];
  if (meta !== undefined) {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) add("media.invalid_ref", "meta must be an object");
    else {
      const m = meta as Record<string, unknown>;
      for (const k of ["width", "height"]) {
        if (m[k] !== undefined && (!Number.isSafeInteger(m[k]) || (m[k] as number) <= 0)) {
          add("media.invalid_ref", `meta.${k} must be a whole number > 0 (got ${describe(m[k])})`);
        }
      }
      const d = m["durationSec"];
      if (d !== undefined && (typeof d !== "number" || !Number.isFinite(d) || d < 0)) {
        add("media.invalid_ref", `meta.durationSec must be a number >= 0 (got ${describe(d)})`);
      }
      const fps = m["fps"];
      if (fps !== undefined && (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0)) {
        add("media.invalid_ref", `meta.fps must be a number > 0 (got ${describe(fps)})`);
      }
    }
  }
  return out;
}

const MEDIA_REF_KEYS = ["uri", "mime", "bytes", "hash", "meta"];
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
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

function isValidMediaUri(uri: string): boolean {
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
