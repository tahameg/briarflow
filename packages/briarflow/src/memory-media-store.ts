/**
 * In-memory MediaStore (docs/specs/storage.md §2). Portable: web-standard APIs only.
 */
import { MEDIA_URI_SCHEME, MediaError, canonicalJson, mediaIdFromUri, normalizeMime, sha256Hex } from "@briarflow/core";
import type { BlobRef, MediaStore, PutMediaInfo, StoredMedia } from "@briarflow/core";

/** Options of {@link MemoryMediaStore}. */
export interface MemoryMediaStoreOptions {
  /** Reject bodies larger than this with `media.too_large`. Default: no limit. */
  maxBytes?: number;
  /** Creates media ids (`^[A-Za-z0-9_-]{1,128}$`). Default: `m_` + 24 random base62 chars. */
  idGenerator?: () => string;
}

const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomMediaId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let id = "m_";
  for (const b of bytes) id += BASE62[b % 62];
  return id;
}

/**
 * Keeps media bytes in memory. Ids are random and never reused (not content-addressed).
 * `resolveUrl` is not implemented: serve media through the REST API (`/media/:id`).
 *
 * @example
 * ```ts
 * const media = new MemoryMediaStore();
 * const ref = await media.put(new TextEncoder().encode("hello"), { mime: "text/plain" });
 * ```
 */
export class MemoryMediaStore implements MediaStore {
  readonly kind = "memory";
  /** Equal content gets a new id on every put (for the conformance suite). */
  readonly contentAddressed = false;
  readonly #maxBytes: number | undefined;
  readonly #newId: () => string;
  #items = new Map<string, { ref: BlobRef; bytes: Uint8Array }>();
  #used = new Set<string>();

  constructor(options: MemoryMediaStoreOptions = {}) {
    this.#maxBytes = options.maxBytes;
    this.#newId = options.idGenerator ?? randomMediaId;
  }

  async put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<BlobRef> {
    const mime = normalizeMime(info?.mime);
    const meta: Record<string, unknown> = { ...(info.meta ?? {}) };
    if (info.filename !== undefined) meta["filename"] = info.filename;
    const hasMeta = Object.keys(meta).length > 0;
    if (hasMeta) canonicalJson(meta); // throws json.invalid for non-JSON meta
    const bytes = data instanceof Uint8Array ? data.slice() : await this.#readAll(data);
    if (this.#maxBytes !== undefined && bytes.byteLength > this.#maxBytes) throw this.#tooLarge();
    const id = this.#allocateId();
    const ref: BlobRef = { uri: MEDIA_URI_SCHEME + id, mime, bytes: bytes.byteLength, hash: await sha256Hex(bytes) };
    if (hasMeta) ref.meta = structuredClone(meta);
    this.#items.set(id, { ref, bytes });
    return cloneRef(ref);
  }

  async get(ref: BlobRef | string): Promise<StoredMedia | undefined> {
    const id = idOf(ref);
    const item = id === undefined ? undefined : this.#items.get(id);
    if (!item) return undefined;
    const copy = item.bytes.slice();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (copy.byteLength > 0) controller.enqueue(copy);
        controller.close();
      },
    });
    return { ref: cloneRef(item.ref), body };
  }

  async delete(ref: BlobRef | string): Promise<boolean> {
    const id = idOf(ref);
    return id !== undefined && this.#items.delete(id);
  }

  #allocateId(): string {
    for (let i = 0; i < 100; i++) {
      const id = this.#newId();
      if (!MEDIA_ID_PATTERN.test(id)) {
        throw new MediaError("media.invalid_id", `MemoryMediaStore idGenerator returned "${id}"; ids must match ${MEDIA_ID_PATTERN}.`);
      }
      if (!this.#used.has(id)) {
        this.#used.add(id);
        return id;
      }
    }
    throw new MediaError("media.invalid_id", "MemoryMediaStore idGenerator keeps returning ids that were already used.");
  }

  async #readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (this.#maxBytes !== undefined && total > this.#maxBytes) {
          await reader.cancel().catch(() => {});
          throw this.#tooLarge();
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

  #tooLarge(): MediaError {
    return new MediaError("media.too_large", `Media is larger than the limit of ${this.#maxBytes} bytes.`, {
      details: { maxBytes: this.#maxBytes },
    });
  }
}

function cloneRef(ref: BlobRef): BlobRef {
  return ref.meta ? { ...ref, meta: structuredClone(ref.meta) } : { ...ref };
}


function idOf(ref: BlobRef | string): string | undefined {
  const uri = typeof ref === "string" ? ref : typeof ref === "object" && ref !== null ? ref.uri : undefined;
  if (typeof uri !== "string") return undefined;
  if (typeof ref !== "string" && !uri.startsWith(MEDIA_URI_SCHEME)) return undefined;
  return mediaIdFromUri(uri);
}
