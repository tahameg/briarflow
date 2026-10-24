/**
 * The media service (docs/specs/media.md §4): the loader that turns a media value into bytes,
 * whatever its entry's source, with an in-memory copy of recent items in front of the registry.
 */
import { MediaError } from "../errors.js";
import { readAll, tooLarge, type MediaStore, type PutMediaInfo } from "../interfaces/media-store.js";
import { ownerOf, type MediaEntry, type MediaOwner, type MediaRegistry } from "../interfaces/media-registry.js";
import type { MediaMeta, MediaRef } from "../types/ir.js";
import { MEDIA_ID_PATTERN, describe, normalizeMime } from "../types/media.js";
import { sha256Hex } from "../util/hash.js";
import { imageSize } from "./sniff.js";

/** What a node sees as `ctx.media`. New media belongs to the node's run (transient, media.md §3). */
export interface NodeMedia {
  /** Keeps `data` as a new transient entry (raw bytes in the registry, and in memory). */
  put(data: Uint8Array, info: PutMediaInfo): Promise<MediaRef>;
  /** A transient entry for media on the web; the bytes are fetched when read. */
  link(url: string, info: PutMediaInfo): Promise<MediaRef>;
  /** The entry of a media value. Unknown → `MediaError("media.not_found")`. */
  entry(ref: MediaRef | string): Promise<MediaEntry>;
  /**
   * The bytes of a media value, from memory, the registry, the blob store or the web. Treat the
   * result as read-only: it may be shared. Errors: `media.not_found`, `media.too_large`,
   * `media.fetch_failed`, `media.corrupt`, `media.unavailable`.
   */
  read(ref: MediaRef | string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  /**
   * A URL others can GET without credentials: a link's own URL, or the blob store's public or
   * signed URL (`MediaStore.resolveUrl`) for stored media. `undefined` otherwise.
   */
  url(ref: MediaRef | string): Promise<string | undefined>;
}

/** Options of {@link Media.read}. */
export interface MediaReadOptions {
  /** Fail with `media.too_large` above this size. Default: no limit. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Used for `link` entries. Default: the service's `fetch`. */
  fetch?: typeof fetch;
}

/** What {@link Media.open} returns: a stream of the bytes, or the URL of a `link` entry. */
export type MediaBody = { entry: MediaEntry; body: ReadableStream<Uint8Array> } | { entry: MediaEntry; url: string };

/** Options of {@link createMedia}. */
export interface MediaOptions {
  registry: MediaRegistry;
  /** Where `stored` entries keep their bytes (uploads). Without it uploads become `data` entries. */
  blobs?: MediaStore;
  /** For `link` entries. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Bytes kept in memory across runs, least recently used dropped first. Default 256 MB; 0 keeps none. */
  memoryBytes?: number;
  /** Larger items are not kept in memory. Default 64 MB. */
  memoryItemBytes?: number;
}

/**
 * Media for the engine, the facade and the REST API. Entries are immutable (only the owner of
 * a transient entry changes), so in-memory copies never go stale.
 *
 * @example
 * ```ts
 * const media = createMedia({ registry: createMemoryMediaRegistry() });
 * const entry = await media.put(pngBytes, { mime: "image/png", filename: "cat.png" });
 * const bytes = await media.read({ mediaId: entry.id });
 * ```
 */
export interface Media {
  readonly registry: MediaRegistry;
  readonly blobs: MediaStore | undefined;
  /** The entry, or `undefined`. */
  entry(ref: MediaRef | string): Promise<MediaEntry | undefined>;
  read(ref: MediaRef | string, options?: MediaReadOptions): Promise<Uint8Array>;
  /** For downloads: the bytes as a stream, or the URL of a `link` entry. Unknown → `media.not_found`. */
  open(ref: MediaRef | string, options?: { signal?: AbortSignal }): Promise<MediaBody>;
  /** A `data` entry; with `owner` it is transient. Images get their width and height from the header. */
  put(data: Uint8Array, info: PutMediaInfo & { owner?: MediaOwner }): Promise<MediaEntry>;
  /** A kept entry for an uploaded file: `stored` in the blob store when there is one, else `data`. */
  upload(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo & { maxBytes?: number }): Promise<MediaEntry>;
  /** A `link` entry; with `owner` it is transient. */
  link(url: string, info: PutMediaInfo & { owner?: MediaOwner }): Promise<MediaEntry>;
  /** Deletes the entry (not the blob of a `stored` entry: blobs are shared by content). */
  delete(ref: MediaRef | string): Promise<boolean>;
  adopt(ids: readonly string[], owner: MediaOwner): Promise<void>;
  deleteOwned(match: Partial<MediaOwner>): Promise<string[]>;
  /** See {@link NodeMedia.url}. */
  url(ref: MediaRef | string): Promise<string | undefined>;
  /** The `ctx.media` of one node execution. */
  forNode(scope: { owner?: MediaOwner; fetch?: typeof fetch; signal?: AbortSignal }): NodeMedia;
  /** Bytes held in memory now. */
  memoryUsed(): number;
  /** Closes the registry and the blob store when they have `close()`. */
  close(): Promise<void>;
}

function notFound(id: string): MediaError {
  return new MediaError("media.not_found", `Media "${id}" was not found. It may have been removed with an earlier run; run the flow again.`, {
    details: { mediaId: id },
  });
}

function corrupt(id: string, problem: string): MediaError {
  return new MediaError("media.corrupt", `Media "${id}" cannot be read: ${problem}.`, { details: { mediaId: id } });
}

/** The id of a media value or a bare id. Throws `media.invalid_ref`. */
export function mediaIdOf(ref: MediaRef | string): string {
  const id = typeof ref === "string" ? ref : (ref as MediaRef | undefined)?.mediaId;
  if (typeof id !== "string" || !MEDIA_ID_PATTERN.test(id)) {
    throw new MediaError("media.invalid_ref", `${describe(ref)} is not a media value: expected { mediaId }.`, { details: { ref } });
  }
  return id;
}

class MemoryBytes {
  readonly #items = new Map<string, Uint8Array>();
  #used = 0;
  constructor(
    readonly max: number,
    readonly itemMax: number,
  ) {}
  get used(): number {
    return this.#used;
  }
  get(id: string): Uint8Array | undefined {
    const hit = this.#items.get(id);
    if (hit) {
      this.#items.delete(id);
      this.#items.set(id, hit);
    }
    return hit;
  }
  set(id: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.itemMax || bytes.byteLength > this.max) return;
    this.delete(id);
    this.#items.set(id, bytes);
    this.#used += bytes.byteLength;
    for (const [key, value] of this.#items) {
      if (this.#used <= this.max) break;
      this.#items.delete(key);
      this.#used -= value.byteLength;
    }
  }
  delete(id: string): void {
    const old = this.#items.get(id);
    if (!old) return;
    this.#items.delete(id);
    this.#used -= old.byteLength;
  }
}

const ENTRY_CACHE = 5000;

function metaFor(data: Uint8Array | undefined, info: PutMediaInfo, mime: string): MediaMeta | undefined {
  const meta: MediaMeta = { ...(info.meta ?? {}) };
  if (info.filename !== undefined) meta.filename = info.filename;
  if (data && mime.startsWith("image/") && (meta.width === undefined || meta.height === undefined)) {
    const size = imageSize(data);
    if (size) {
      meta.width ??= size.width;
      meta.height ??= size.height;
    }
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/**
 * Creates the media service.
 *
 * @example
 * ```ts
 * const media = createMedia({ registry: new SqliteMediaRegistry({ file }), blobs: new FsMediaStore({ dir }) });
 * ```
 */
export function createMedia(options: MediaOptions): Media {
  const { registry, blobs } = options;
  const baseFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const memory = new MemoryBytes(options.memoryBytes ?? 256 * 1024 * 1024, options.memoryItemBytes ?? 64 * 1024 * 1024);
  const entries = new Map<string, MediaEntry>();

  const remember = (entry: MediaEntry): MediaEntry => {
    entries.delete(entry.id);
    entries.set(entry.id, entry);
    if (entries.size > ENTRY_CACHE) entries.delete(entries.keys().next().value as string);
    return entry;
  };
  const forget = (id: string) => {
    entries.delete(id);
    memory.delete(id);
  };

  const entry = async (ref: MediaRef | string): Promise<MediaEntry | undefined> => {
    const id = mediaIdOf(ref);
    const cached = entries.get(id);
    if (cached) return cached;
    const found = await registry.get(id);
    if (found) return remember(found);
    // Blobs saved before the registry existed are found by their blob id.
    const blob = blobs ? await blobs.get(id) : undefined;
    if (!blob) return undefined;
    await blob.body.cancel().catch(() => {});
    const { ref: b } = blob;
    return remember(
      await registry.add({
        id,
        mime: b.mime,
        source: { kind: "stored", uri: b.uri },
        ...(b.bytes === undefined ? {} : { bytes: b.bytes }),
        ...(b.hash === undefined ? {} : { hash: b.hash }),
        ...(b.meta === undefined ? {} : { meta: b.meta }),
      }),
    );
  };

  const entryOrThrow = async (ref: MediaRef | string): Promise<MediaEntry> => {
    const e = await entry(ref);
    if (!e) throw notFound(mediaIdOf(ref));
    return e;
  };

  const fetchLink = async (e: MediaEntry & { source: { kind: "link" } }, o: MediaReadOptions): Promise<Uint8Array> => {
    const url = e.source.url;
    const init: RequestInit = o.signal ? { signal: o.signal } : {};
    const res = await (o.fetch ?? baseFetch)(url, init);
    if (res.status === 404) throw new MediaError("media.not_found", `Media "${e.id}" links to ${url}, which answers 404.`, { details: { mediaId: e.id, url } });
    if (!res.ok) {
      throw new MediaError("media.fetch_failed", `Fetching media "${e.id}" from ${url} failed with HTTP ${res.status}.`, { details: { status: res.status, url } });
    }
    const length = Number(res.headers.get("content-length"));
    if (o.maxBytes !== undefined && Number.isFinite(length) && length > o.maxBytes) throw tooLarge(`"${e.id}"`, o.maxBytes);
    if (!res.body) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (o.maxBytes !== undefined && bytes.byteLength > o.maxBytes) throw tooLarge(`"${e.id}"`, o.maxBytes);
      return bytes;
    }
    return readAll(res.body, { ...o, what: `"${e.id}"` });
  };

  const read = async (ref: MediaRef | string, o: MediaReadOptions = {}): Promise<Uint8Array> => {
    o.signal?.throwIfAborted();
    const id = mediaIdOf(ref);
    const hit = memory.get(id);
    if (hit) {
      if (o.maxBytes !== undefined && hit.byteLength > o.maxBytes) throw tooLarge(`"${id}"`, o.maxBytes);
      return hit;
    }
    const e = await entryOrThrow(id);
    if (o.maxBytes !== undefined && e.bytes !== undefined && e.bytes > o.maxBytes) throw tooLarge(`"${id}"`, o.maxBytes);
    let bytes: Uint8Array;
    switch (e.source.kind) {
      case "data": {
        const data = await registry.data(id);
        if (!data) throw corrupt(id, "the registry has no bytes for it");
        bytes = data;
        break;
      }
      case "stored": {
        if (!blobs) {
          throw new MediaError("media.unavailable", `Media "${id}" is in a blob store, and this server has none configured.`, { details: { mediaId: id } });
        }
        const blob = await blobs.get(e.source.uri);
        if (!blob) throw notFound(id);
        bytes = await readAll(blob.body, { ...o, what: `"${id}"` });
        break;
      }
      case "link":
        bytes = await fetchLink(e as MediaEntry & { source: { kind: "link" } }, o);
        break;
      default:
        throw corrupt(id, `its source kind ${describe((e.source as { kind?: unknown }).kind)} is unknown`);
    }
    if (e.source.kind !== "link" && e.bytes !== undefined && bytes.byteLength !== e.bytes) {
      throw corrupt(id, `it has ${bytes.byteLength} bytes, and its entry says ${e.bytes}`);
    }
    if (o.maxBytes !== undefined && bytes.byteLength > o.maxBytes) throw tooLarge(`"${id}"`, o.maxBytes);
    memory.set(id, bytes);
    return bytes;
  };

  const put = async (data: Uint8Array, info: PutMediaInfo & { owner?: MediaOwner }): Promise<MediaEntry> => {
    if (!(data instanceof Uint8Array)) throw new MediaError("media.invalid_entry", "Media bytes must be a Uint8Array.");
    const mime = normalizeMime(info.mime);
    const bytes = data.slice();
    const meta = metaFor(bytes, info, mime);
    const e = await registry.add(
      {
        mime,
        source: { kind: "data" },
        bytes: bytes.byteLength,
        hash: await sha256Hex(bytes),
        ...(meta ? { meta } : {}),
        ...(info.owner ? { owner: ownerOf(info.owner) } : {}),
      },
      bytes,
    );
    memory.set(e.id, bytes);
    return remember(e);
  };

  const link = async (url: string, info: PutMediaInfo & { owner?: MediaOwner }): Promise<MediaEntry> => {
    const meta = metaFor(undefined, info, normalizeMime(info.mime));
    return remember(
      await registry.add({
        mime: info.mime,
        source: { kind: "link", url },
        ...(meta ? { meta } : {}),
        ...(info.owner ? { owner: ownerOf(info.owner) } : {}),
      }),
    );
  };

  const url = async (ref: MediaRef | string): Promise<string | undefined> => {
    const e = await entryOrThrow(ref);
    if (e.source.kind === "link") return e.source.url;
    if (e.source.kind !== "stored" || !blobs?.resolveUrl) return undefined;
    return blobs.resolveUrl({
      uri: e.source.uri,
      mime: e.mime,
      ...(e.bytes === undefined ? {} : { bytes: e.bytes }),
      ...(e.hash === undefined ? {} : { hash: e.hash }),
      ...(e.meta === undefined ? {} : { meta: e.meta }),
    });
  };

  return {
    registry,
    blobs,
    entry,
    read,
    url,
    async open(ref, o = {}) {
      const e = await entryOrThrow(ref);
      if (e.source.kind === "link") return { entry: e, url: e.source.url };
      const hit = memory.get(e.id);
      if (!hit && e.source.kind === "stored" && blobs) {
        const blob = await blobs.get(e.source.uri);
        if (!blob) throw notFound(e.id);
        return { entry: e, body: blob.body };
      }
      const bytes = hit ?? (await read(e.id, o));
      return {
        entry: e,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
    put,
    async upload(data, info) {
      const mime = normalizeMime(info.mime);
      // Images are read whole so their header gives the size; other files stream through.
      let body: Uint8Array | ReadableStream<Uint8Array> = data;
      if (!(data instanceof Uint8Array) && (mime.startsWith("image/") || !blobs)) {
        body = await readAll(data, { ...(info.maxBytes === undefined ? {} : { maxBytes: info.maxBytes }), what: info.filename ?? "upload" });
      }
      if (!blobs) return put(body as Uint8Array, { mime, ...(info.filename === undefined ? {} : { filename: info.filename }), ...(info.meta ? { meta: info.meta } : {}) });
      const size = body instanceof Uint8Array && mime.startsWith("image/") ? imageSize(body) : undefined;
      const meta = info.meta || size ? { ...(size ?? {}), ...(info.meta ?? {}) } : undefined;
      const b = await blobs.put(body, { mime, ...(info.filename === undefined ? {} : { filename: info.filename }), ...(meta ? { meta } : {}) });
      return remember(
        await registry.add({
          mime: b.mime,
          source: { kind: "stored", uri: b.uri },
          ...(b.bytes === undefined ? {} : { bytes: b.bytes }),
          ...(b.hash === undefined ? {} : { hash: b.hash }),
          ...(b.meta === undefined ? {} : { meta: b.meta }),
        }),
      );
    },
    link,
    async delete(ref) {
      const id = mediaIdOf(ref);
      forget(id);
      return registry.delete(id);
    },
    async adopt(ids, owner) {
      await registry.adopt(ids, owner);
      for (const id of ids) entries.delete(id);
    },
    async deleteOwned(match) {
      const gone = await registry.deleteOwned(match);
      for (const id of gone) forget(id);
      return gone;
    },
    forNode(scope) {
      const owner = scope.owner;
      return {
        put: async (data, info) => ({ mediaId: (await put(data, { ...info, ...(owner ? { owner } : {}) })).id }),
        link: async (url, info) => ({ mediaId: (await link(url, { ...info, ...(owner ? { owner } : {}) })).id }),
        entry: entryOrThrow,
        url,
        read: (ref, o = {}) =>
          read(ref, {
            ...(o.maxBytes === undefined ? {} : { maxBytes: o.maxBytes }),
            ...(scope.signal ? { signal: scope.signal } : {}),
            ...(scope.fetch ? { fetch: scope.fetch } : {}),
          }),
      };
    },
    memoryUsed: () => memory.used,
    async close() {
      const errors: unknown[] = [];
      for (const target of [registry, blobs] as { close?: () => unknown }[]) {
        try {
          await target?.close?.();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) throw errors[0];
    },
  };
}
