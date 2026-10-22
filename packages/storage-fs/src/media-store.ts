/**
 * File-system MediaStore (docs/specs/storage.md §2): content-addressed files.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MEDIA_URI_SCHEME, MediaError, canonicalJson, mediaIdFromUri, normalizeMime } from "@briarflow/core";
import type { MediaRef, MediaStore, PutMediaInfo, StoredMedia } from "@briarflow/core";

/** Options of {@link FsMediaStore}. */
export interface FsMediaStoreOptions {
  /** Directory holding `<id>.bin` (content) and `<id>.json` (the MediaRef). Created if missing. */
  dir: string;
  /** Reject bodies larger than this with `media.too_large`. Default: no limit. */
  maxBytes?: number;
  /** `fsync` files before renaming them into place. Default `true`. */
  durable?: boolean;
}

const ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Stores media as files. Ids are **content-addressed**: `id` = sha-256 (hex) of the canonical
 * JSON of `{ hash, mime, meta }`, where `hash` is the sha-256 of the bytes. Putting the same
 * bytes with the same mime and meta twice returns the same ref (and stores one copy);
 * after a delete, putting them again brings the same id back (storage.md §2.1 allows
 * content-addressed ids).
 *
 * Bodies are streamed to a temporary file while hashing and renamed into place, so a
 * partly written item is never visible. `get` streams from the file. `resolveUrl` is not
 * implemented (the REST API serves `/media/:id`).
 *
 * @example
 * ```ts
 * const media = new FsMediaStore({ dir: "./data/media" });
 * const ref = await media.put(bytes, { mime: "image/png", filename: "cat.png" });
 * ```
 */
export class FsMediaStore implements MediaStore {
  readonly kind = "fs";
  /** Equal content and info give equal refs (for the conformance suite). */
  readonly contentAddressed = true;
  readonly dir: string;
  readonly #maxBytes: number | undefined;
  readonly #durable: boolean;
  #ready: Promise<void> | undefined;

  constructor(options: FsMediaStoreOptions) {
    this.dir = options.dir;
    this.#maxBytes = options.maxBytes;
    this.#durable = options.durable ?? true;
  }

  async put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<MediaRef> {
    const mime = normalizeMime(info?.mime);
    const meta: Record<string, unknown> = { ...(info.meta ?? {}) };
    if (info.filename !== undefined) meta["filename"] = info.filename;
    const hasMeta = Object.keys(meta).length > 0;
    if (hasMeta) canonicalJson(meta); // throws json.invalid for non-JSON meta
    await this.#open();

    const tmp = join(this.dir, `.put-${randomBytes(8).toString("hex")}.tmp`);
    let bytes = 0;
    const hasher = createHash("sha256");
    try {
      const fh = await open(tmp, "w");
      try {
        const write = async (chunk: Uint8Array) => {
          bytes += chunk.byteLength;
          if (this.#maxBytes !== undefined && bytes > this.#maxBytes) throw this.#tooLarge();
          hasher.update(chunk);
          await fh.write(chunk);
        };
        if (data instanceof Uint8Array) {
          await write(data);
        } else {
          const reader = data.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await write(value);
            }
          } catch (err) {
            await reader.cancel(err).catch(() => {});
            throw err;
          } finally {
            reader.releaseLock();
          }
        }
        if (this.#durable) await fh.sync();
      } finally {
        await fh.close();
      }
      const hash = hasher.digest("hex");
      const ref: MediaRef = { uri: "", mime, bytes, hash };
      if (hasMeta) ref.meta = meta;
      const id = createHash("sha256")
        .update(canonicalJson({ hash, mime, meta: hasMeta ? meta : null }))
        .digest("hex");
      ref.uri = MEDIA_URI_SCHEME + id;
      await rename(tmp, this.#binPath(id));
      await this.#writeRefAtomic(id, ref);
      return { ...ref, ...(ref.meta ? { meta: structuredClone(ref.meta) } : {}) };
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(ref: MediaRef | string): Promise<StoredMedia | undefined> {
    const id = idOf(ref);
    if (id === undefined) return undefined;
    await this.#open();
    const stored = await this.#readRef(id);
    if (!stored) return undefined;
    let fh: FileHandle;
    try {
      fh = await open(this.#binPath(id), "r");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    const body = Readable.toWeb(fh.createReadStream({ autoClose: true })) as unknown as ReadableStream<Uint8Array>;
    return { ref: stored, body };
  }

  async delete(ref: MediaRef | string): Promise<boolean> {
    const id = idOf(ref);
    if (id === undefined) return false;
    await this.#open();
    let existed = true;
    try {
      await unlink(this.#refPath(id));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      existed = false;
    }
    await rm(this.#binPath(id), { force: true });
    return existed;
  }

  // ------------------------------------------------------------------ internals

  #open(): Promise<void> {
    this.#ready ??= mkdir(this.dir, { recursive: true }).then(() => {});
    return this.#ready;
  }

  #binPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }

  #refPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async #readRef(id: string): Promise<MediaRef | undefined> {
    let text: string;
    try {
      text = await readFile(this.#refPath(id), "utf8");
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
    try {
      return JSON.parse(text) as MediaRef;
    } catch (err) {
      throw new MediaError("media.corrupt", `Stored media ${MEDIA_URI_SCHEME}${id} cannot be read. Delete it and upload it again.`, {
        cause: err,
        details: { uri: MEDIA_URI_SCHEME + id },
      });
    }
  }

  async #writeRefAtomic(id: string, ref: MediaRef): Promise<void> {
    const tmp = join(this.dir, `.ref-${randomBytes(8).toString("hex")}.tmp`);
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify(ref), "utf8");
        if (this.#durable) await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.#refPath(id));
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  #tooLarge(): MediaError {
    return new MediaError("media.too_large", `Media is larger than the limit of ${this.#maxBytes} bytes.`, {
      details: { maxBytes: this.#maxBytes },
    });
  }
}


function idOf(ref: MediaRef | string): string | undefined {
  const uri = typeof ref === "string" ? ref : typeof ref === "object" && ref !== null ? ref.uri : undefined;
  if (typeof uri !== "string") return undefined;
  if (typeof ref !== "string" && !uri.startsWith(MEDIA_URI_SCHEME)) return undefined;
  const id = mediaIdFromUri(uri);
  return id !== undefined && ID_PATTERN.test(id) ? id : undefined;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}
