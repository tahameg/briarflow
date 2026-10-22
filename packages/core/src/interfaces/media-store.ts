/**
 * Media storage contract (docs/specs/storage.md §2). Conformance suite: `describeMediaStore`.
 */
import { MediaError } from "../errors.js";
import { MEDIA_URI_SCHEME, mediaIdFromUri } from "../types/media.js";
import type { MediaRef } from "../types/ir.js";

/** Info for {@link MediaStore.put}. */
export interface PutMediaInfo {
  /** Normalized by the store (lowercased, parameters stripped). Invalid → `media.invalid_mime`. */
  mime: string;
  /** Stored as `meta.filename`. */
  filename?: string;
  /** Copied into `MediaRef.meta` (storage.md Deviation 2). */
  meta?: Record<string, unknown>;
}

/** A stored media item with a fresh body stream. */
export interface StoredMedia {
  ref: MediaRef;
  body: ReadableStream<Uint8Array>;
}

/**
 * Stores binary media and hands out `briar-media://<id>` refs.
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
  put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<MediaRef>;
  /** Accepts a ref, a `briar-media://` uri or a bare id; other uris → `undefined`. */
  get(ref: MediaRef | string): Promise<StoredMedia | undefined>;
  /** `true` if it existed. */
  delete(ref: MediaRef | string): Promise<boolean>;
  /** Public or signed URL when available. */
  resolveUrl?(ref: MediaRef): Promise<string | undefined>;
}

/** Options of {@link readMedia}. */
export interface ReadMediaOptions {
  /** Used for `briar-media://` refs and bare ids. */
  media: MediaStore;
  /** Used for `https://` / `http://` refs. Default: global `fetch`. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Fail with `media.too_large` above this size. Default: no limit. */
  maxBytes?: number;
}

/**
 * Reads the bytes of any MediaRef: from the store for `briar-media://` (or a bare id), via
 * `fetch` for http(s) uris. Throws `MediaError("media.not_found")` when the store has no such
 * item or the fetch answers 404, `MediaError("media.fetch_failed")` (`details: { status }`) for
 * other non-2xx answers, `MediaError("media.too_large")` (`details: { maxBytes }`) above
 * `maxBytes`, and `MediaError("media.invalid_uri")` for other schemes. Network errors from
 * `fetch` propagate unchanged; an aborted `signal` rejects with its reason.
 *
 * @example
 * ```ts
 * const bytes = await readMedia(inputs.image, { media: ctx.media, fetch: ctx.fetch, signal: ctx.signal });
 * ```
 */
export async function readMedia(ref: MediaRef | string, options: ReadMediaOptions): Promise<Uint8Array> {
  const uri = typeof ref === "string" ? ref : ref?.uri;
  if (typeof uri !== "string") throw new MediaError("media.invalid_uri", "readMedia needs a MediaRef or a media uri.");
  options.signal?.throwIfAborted();
  const maxBytes = options.maxBytes;
  if (uri.startsWith(MEDIA_URI_SCHEME) || (!uri.includes(":") && mediaIdFromUri(uri) !== undefined)) {
    const stored = await options.media.get(ref);
    if (!stored) throw notFound(uri);
    return readStream(stored.body, maxBytes, options.signal);
  }
  if (/^https?:\/\//i.test(uri)) {
    const doFetch = options.fetch ?? globalThis.fetch;
    const init: RequestInit = {};
    if (options.signal) init.signal = options.signal;
    const res = await doFetch(uri, init);
    if (res.status === 404) throw notFound(uri);
    if (!res.ok) {
      throw new MediaError("media.fetch_failed", `Fetching media ${uri} failed with HTTP ${res.status}.`, {
        details: { status: res.status, uri },
      });
    }
    const length = Number(res.headers.get("content-length"));
    if (maxBytes !== undefined && Number.isFinite(length) && length > maxBytes) throw tooLarge(uri, maxBytes);
    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw tooLarge(uri, maxBytes);
      return bytes;
    }
    return readStream(res.body, maxBytes, options.signal, uri);
  }
  throw new MediaError(
    "media.invalid_uri",
    `Cannot read media "${uri}": use a briar-media:// uri, a media id or an http(s) URL.`,
    { details: { uri } },
  );
}

function notFound(uri: string): MediaError {
  return new MediaError("media.not_found", `Media ${uri} was not found. It may have been deleted.`, { details: { uri } });
}

function tooLarge(uri: string, maxBytes: number): MediaError {
  return new MediaError("media.too_large", `Media ${uri} is larger than the limit of ${maxBytes} bytes.`, {
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
