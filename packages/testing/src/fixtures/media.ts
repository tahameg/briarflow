/**
 * In-memory blob store (`MediaStore`) for tests and sample media values (types.md §8).
 */
import { MediaError, type BlobRef, type MediaPrimitiveName, type MediaStore, type PutMediaInfo, type StoredMedia } from "@briarflow/core";

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
  const items = new Map<string, { ref: BlobRef; bytes: Uint8Array }>();
  let counter = 0;

  const idOf = (ref: BlobRef | string): string | undefined => {
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
      const ref: BlobRef = { uri: MEDIA_SCHEME + id, mime, bytes: bytes.length, hash: await sha256(bytes) };
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

/** A media value for a primitive. */
export interface MediaRefCase {
  label: string;
  primitive: MediaPrimitiveName;
  value: unknown;
}

/** An invalid media value and the expected code (types.md §8). */
export interface InvalidMediaRefCase extends MediaRefCase {
  code: "media.invalid_ref";
}

/** Media values that must validate (types.md §8): the shape only, the entry is not looked up. */
export const validMediaRefs: readonly MediaRefCase[] = [
  { label: "registry id", primitive: "image", value: { mediaId: "med_abc" } },
  { label: "128-char id", primitive: "file", value: { mediaId: "a".repeat(128) } },
  { label: "blob-store id", primitive: "video", value: { mediaId: "a7ffa0806cd81f7d6955b2e6ecd7f2781bbf9a5aacb9e72217e15f9066a6c4cf" } },
  { label: "id with - and _", primitive: "audio", value: { mediaId: "m_a-1" } },
];

/** Media values that must fail with `media.invalid_ref` (types.md §8). */
export const invalidMediaRefs: readonly InvalidMediaRefCase[] = [
  { label: "old uri shape", primitive: "image", code: "media.invalid_ref", value: { uri: "briar-media://m_abc", mime: "image/png" } },
  { label: "empty id", primitive: "image", code: "media.invalid_ref", value: { mediaId: "" } },
  { label: "id with a space", primitive: "image", code: "media.invalid_ref", value: { mediaId: "m a" } },
  { label: "id too long", primitive: "file", code: "media.invalid_ref", value: { mediaId: "a".repeat(129) } },
  { label: "id not text", primitive: "image", code: "media.invalid_ref", value: { mediaId: 7 } },
  { label: "extra key", primitive: "image", code: "media.invalid_ref", value: { mediaId: "med_abc", mime: "image/png" } },
  { label: "a string", primitive: "image", code: "media.invalid_ref", value: "med_abc" },
  { label: "a list", primitive: "image", code: "media.invalid_ref", value: [{ mediaId: "med_abc" }] },
];
