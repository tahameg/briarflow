/**
 * Blob storage contract (docs/specs/storage.md §2): where the bytes of `stored` media entries
 * live (media.md §2). Conformance suite: `describeMediaStore`.
 */
import { MediaError } from "../errors.js";
import type { MediaMeta } from "../types/ir.js";

/** What a blob store keeps about one blob. */
export interface BlobRef {
  /** `briar-media://<id>`. */
  uri: string;
  /** Lowercase mime type without parameters. */
  mime: string;
  bytes?: number;
  /** SHA-256 of the content, lowercase hex. */
  hash?: string;
  meta?: MediaMeta;
}

/** Info for {@link MediaStore.put}. */
export interface PutMediaInfo {
  /** Normalized by the store (lowercased, parameters stripped). Invalid → `media.invalid_mime`. */
  mime: string;
  /** Stored as `meta.filename`. */
  filename?: string;
  /** Copied into `MediaRef.meta` (storage.md Deviation 2). */
  meta?: Record<string, unknown>;
}

/** A stored blob with a fresh body stream. */
export interface StoredMedia {
  ref: BlobRef;
  body: ReadableStream<Uint8Array>;
}

/**
 * Stores blobs and hands out `briar-media://<id>` refs. The media registry keeps `stored`
 * entries here (uploads); nodes do not use it directly.
 *
 * @example
 * ```ts
 * const ref = await media.put(bytes, { mime: "image/png", filename: "cat.png" });
 * const stored = await media.get(ref);
 * ```
 */
export interface MediaStore {
  readonly kind: string;
  /** Reads the whole body; returns `{ uri, mime, bytes, hash, meta? }`. */
  put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<BlobRef>;
  /** Accepts a ref, a `briar-media://` uri or a bare id; other uris → `undefined`. */
  get(ref: BlobRef | string): Promise<StoredMedia | undefined>;
  /** `true` if it existed. */
  delete(ref: BlobRef | string): Promise<boolean>;
  /** Public or signed URL when available. */
  resolveUrl?(ref: BlobRef): Promise<string | undefined>;
}

/**
 * Reads a stream to the end. Throws `MediaError("media.too_large")` above `maxBytes`; an aborted
 * `signal` rejects with its reason. Internal helper of the media loader.
 */
export async function readAll(body: ReadableStream<Uint8Array>, options: { maxBytes?: number; signal?: AbortSignal; what?: string } = {}): Promise<Uint8Array> {
  return readStream(body, options.maxBytes, options.signal, options.what);
}

export function tooLarge(what: string, maxBytes: number): MediaError {
  return new MediaError("media.too_large", `Media ${what} is larger than the limit of ${maxBytes} bytes.`, {
    details: { maxBytes },
  });
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number | undefined,
  signal: AbortSignal | undefined,
  uri = "",
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(uri, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
