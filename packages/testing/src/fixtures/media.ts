/**
 * In-memory `MediaStore` for tests and sample `MediaRef`s (types.md §8).
 */
import { MediaError, type MediaPrimitiveName, type MediaRef, type MediaStore, type PutMediaInfo, type StoredMedia } from "@briarflow/core";

const MEDIA_SCHEME = "briar-media://";
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readAll(data: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data.slice();
  const chunks: Uint8Array[] = [];
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A stream that yields `bytes` in chunks of `chunkSize`. */
export function streamOf(bytes: Uint8Array, chunkSize = 3): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

/** Options of {@link memoryMediaStore}. */
export interface MemoryMediaStoreOptions {
  /** `put` above this size throws `media.too_large`. */
  maxBytes?: number;
}

/** A `MediaStore` plus test helpers. */
export interface MemoryMediaStore extends MediaStore {
  /** Number of stored items. */
  readonly size: number;
}

/**
 * Minimal in-memory `MediaStore` (ids `m_1`, `m_2`, …). Follows storage.md §2: normalized
 * mime, exact `bytes`, sha-256 `hash`, `meta` = `info.meta` + `filename`, `get` by ref, uri or
 * id, `undefined` for other uris.
 */
export function memoryMediaStore(options: MemoryMediaStoreOptions = {}): MemoryMediaStore {
  const items = new Map<string, { ref: MediaRef; bytes: Uint8Array }>();
  let counter = 0;

  const idOf = (ref: MediaRef | string): string | undefined => {
    const uri = typeof ref === "string" ? ref : ref.uri;
    if (uri.startsWith(MEDIA_SCHEME)) return uri.slice(MEDIA_SCHEME.length);
    if (/^[A-Za-z0-9_-]{1,128}$/.test(uri)) return uri;
    return undefined;
  };

  return {
    kind: "memory",
    get size() {
      return items.size;
    },
    async put(data, info: PutMediaInfo) {
      const mime = info.mime.split(";")[0]!.trim().toLowerCase();
      if (!MIME_PATTERN.test(mime)) throw new MediaError("media.invalid_mime", `"${info.mime}" is not a valid mime type.`);
      const bytes = await readAll(data);
      if (options.maxBytes !== undefined && bytes.length > options.maxBytes) {
        throw new MediaError("media.too_large", `Media is larger than ${options.maxBytes} bytes.`, {
          details: { maxBytes: options.maxBytes },
        });
      }
      counter += 1;
      const id = `m_${counter}`;
      const meta = { ...(info.meta ?? {}), ...(info.filename === undefined ? {} : { filename: info.filename }) };
      const ref: MediaRef = { uri: MEDIA_SCHEME + id, mime, bytes: bytes.length, hash: await sha256(bytes) };
      if (Object.keys(meta).length > 0) ref.meta = meta;
      items.set(id, { ref, bytes });
      return structuredClone(ref);
    },
    async get(ref): Promise<StoredMedia | undefined> {
      const id = idOf(ref);
      const item = id === undefined ? undefined : items.get(id);
      if (!item) return undefined;
      return { ref: structuredClone(item.ref), body: streamOf(item.bytes, 64 * 1024) };
    },
    async delete(ref) {
      const id = idOf(ref);
      return id === undefined ? false : items.delete(id);
    },
  };
}

/** UTF-8 bytes of a string. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** SHA-256 of `"hello"` (storage.md §3). */
export const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/** A valid MediaRef for a primitive. */
export interface MediaRefCase {
  label: string;
  primitive: MediaPrimitiveName;
  value: unknown;
}

/** An invalid MediaRef and the expected code (types.md §8). */
export interface InvalidMediaRefCase extends MediaRefCase {
  code: "media.invalid_uri" | "media.invalid_mime" | "media.kind_mismatch" | "media.invalid_ref";
}

const png = { uri: "briar-media://m_abc", mime: "image/png" };

/** MediaRefs that must validate (types.md §8). */
export const validMediaRefs: readonly MediaRefCase[] = [
  { label: "minimal store ref", primitive: "image", value: png },
  { label: "https url", primitive: "image", value: { uri: "https://cdn.example.com/a.png", mime: "image/png" } },
  { label: "http url", primitive: "image", value: { uri: "http://localhost:8080/a.png", mime: "image/png" } },
  { label: "128-char id", primitive: "file", value: { uri: "briar-media://" + "a".repeat(128), mime: "application/pdf" } },
  {
    label: "every optional field",
    primitive: "video",
    value: {
      uri: "briar-media://m_vid-1",
      mime: "video/mp4",
      bytes: 0,
      hash: HELLO_SHA256,
      meta: { width: 1920, height: 1080, durationSec: 0, fps: 29.97, filename: "clip.mp4", custom: { any: ["json"] } },
    },
  },
  { label: "audio mime", primitive: "audio", value: { uri: "briar-media://m_a", mime: "audio/mpeg" } },
  { label: "model3d model/*", primitive: "model3d", value: { uri: "briar-media://m_m", mime: "model/gltf-binary" } },
  { label: "model3d octet-stream", primitive: "model3d", value: { uri: "briar-media://m_m", mime: "application/octet-stream" } },
  { label: "file accepts any mime", primitive: "file", value: { uri: "briar-media://m_f", mime: "image/png" } },
  { label: "mime with + and .", primitive: "image", value: { uri: "briar-media://m_s", mime: "image/svg+xml" } },
];

/** MediaRefs that must fail with a given code (types.md §8). */
export const invalidMediaRefs: readonly InvalidMediaRefCase[] = [
  { label: "ftp uri", primitive: "image", code: "media.invalid_uri", value: { uri: "ftp://x/a.png", mime: "image/png" } },
  { label: "relative uri", primitive: "image", code: "media.invalid_uri", value: { uri: "/a.png", mime: "image/png" } },
  { label: "empty media id", primitive: "image", code: "media.invalid_uri", value: { uri: "briar-media://", mime: "image/png" } },
  { label: "media id with a space", primitive: "image", code: "media.invalid_uri", value: { uri: "briar-media://m a", mime: "image/png" } },
  { label: "media id too long", primitive: "file", code: "media.invalid_uri", value: { uri: "briar-media://" + "a".repeat(129), mime: "image/png" } },
  { label: "uppercase mime", primitive: "image", code: "media.invalid_mime", value: { uri: png.uri, mime: "Image/PNG" } },
  { label: "mime with parameters", primitive: "image", code: "media.invalid_mime", value: { uri: png.uri, mime: "image/png; q=1" } },
  { label: "mime without slash", primitive: "file", code: "media.invalid_mime", value: { uri: png.uri, mime: "png" } },
  { label: "video mime for image", primitive: "image", code: "media.kind_mismatch", value: { uri: png.uri, mime: "video/mp4" } },
  { label: "image mime for video", primitive: "video", code: "media.kind_mismatch", value: { uri: png.uri, mime: "image/png" } },
  { label: "image mime for audio", primitive: "audio", code: "media.kind_mismatch", value: { uri: png.uri, mime: "image/png" } },
  { label: "image mime for model3d", primitive: "model3d", code: "media.kind_mismatch", value: { uri: png.uri, mime: "image/png" } },
  { label: "negative bytes", primitive: "image", code: "media.invalid_ref", value: { ...png, bytes: -1 } },
  { label: "fractional bytes", primitive: "image", code: "media.invalid_ref", value: { ...png, bytes: 1.5 } },
  { label: "uppercase hash", primitive: "image", code: "media.invalid_ref", value: { ...png, hash: HELLO_SHA256.toUpperCase() } },
  { label: "short hash", primitive: "image", code: "media.invalid_ref", value: { ...png, hash: "abc" } },
  { label: "zero width", primitive: "image", code: "media.invalid_ref", value: { ...png, meta: { width: 0 } } },
  { label: "fractional height", primitive: "image", code: "media.invalid_ref", value: { ...png, meta: { height: 1.5 } } },
  { label: "negative duration", primitive: "image", code: "media.invalid_ref", value: { ...png, meta: { durationSec: -1 } } },
  { label: "zero fps", primitive: "image", code: "media.invalid_ref", value: { ...png, meta: { fps: 0 } } },
  { label: "meta not an object", primitive: "image", code: "media.invalid_ref", value: { ...png, meta: "big" } },
  { label: "unknown top-level key", primitive: "image", code: "media.invalid_ref", value: { ...png, url: "https://x" } },
];
