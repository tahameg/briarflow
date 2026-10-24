/**
 * The media registry (docs/specs/media.md §2): a database of media entries. A media value
 * (`{ mediaId }`) is the id of one entry; the entry says what the media is and where its bytes
 * are. Conformance suite: `describeMediaRegistry`.
 */
import { MediaError } from "../errors.js";
import type { MediaMeta } from "../types/ir.js";
import { MEDIA_ID_PATTERN, MEDIA_URI_SCHEME, describe, isValidMediaUri, mediaMetaProblems, normalizeMime } from "../types/media.js";
import { createIdGenerator, type Clock, type IdGenerator } from "../util/ids.js";

/**
 * Where an entry's bytes are:
 * - `data`: in the registry itself (transient run artifacts);
 * - `stored`: in a blob store, `briar-media://<id>` (uploads);
 * - `link`: on the web, fetched from `url`.
 */
export type MediaSource = { kind: "data" } | { kind: "stored"; uri: string } | { kind: "link"; url: string };

/** The run a transient entry belongs to. Transient entries go away with their run (media.md §3). */
export interface MediaOwner {
  runId: string;
  flowId?: string;
  contextId?: string;
}

/** One entry of the media registry. */
export interface MediaEntry {
  id: string;
  /** Lowercase mime type without parameters. */
  mime: string;
  source: MediaSource;
  /** Size of the content. */
  bytes?: number;
  /** SHA-256 of the content, lowercase hex. */
  hash?: string;
  meta?: MediaMeta;
  /** Set on transient entries; absent on kept ones (uploads, links). */
  owner?: MediaOwner;
  createdAt: string;
}

/** What {@link MediaRegistry.add} takes. The registry picks `id` when it is absent. */
export interface NewMediaEntry {
  id?: string;
  mime: string;
  source: MediaSource;
  bytes?: number;
  hash?: string;
  meta?: MediaMeta;
  owner?: MediaOwner;
}

/**
 * Stores media entries, and the bytes of `data` entries.
 *
 * @example
 * ```ts
 * const entry = await registry.add({ mime: "image/png", source: { kind: "data" }, owner: { runId } }, bytes);
 * const again = await registry.get(entry.id);
 * ```
 */
export interface MediaRegistry {
  readonly kind: string;
  /**
   * Adds an entry. `data` is required with (and only allowed with) `source.kind: "data"`.
   * Invalid entries → `media.invalid_entry`; an id in use → `media.exists`.
   */
  add(entry: NewMediaEntry, data?: Uint8Array): Promise<MediaEntry>;
  get(id: string): Promise<MediaEntry | undefined>;
  /** Bytes of a `data` entry; `undefined` for other kinds and unknown ids. */
  data(id: string): Promise<Uint8Array | undefined>;
  /** `true` if it existed. */
  delete(id: string): Promise<boolean>;
  /** Moves transient entries to a new owner (carry-over to a new run). Unknown and kept entries are skipped. */
  adopt(ids: readonly string[], owner: MediaOwner): Promise<void>;
  /** The owners of transient entries, each once. */
  owners(): Promise<MediaOwner[]>;
  /** Deletes the transient entries whose owner has every field of `match`. Returns their ids. */
  deleteOwned(match: Partial<MediaOwner>): Promise<string[]>;
  close?(): void | Promise<void>;
}

function invalidEntry(problem: string): MediaError {
  return new MediaError("media.invalid_entry", `Invalid media entry: ${problem}.`, { details: { problem } });
}

/**
 * Checks and normalizes a new entry (mime lowercased, owner fields trimmed to what is set).
 * Throws `MediaError("media.invalid_entry")`. For registry implementations.
 */
export function normalizeMediaEntry(entry: NewMediaEntry, data: Uint8Array | undefined): Omit<NewMediaEntry, "id"> & { id?: string } {
  if (typeof entry !== "object" || entry === null) throw invalidEntry("expected an object");
  if (entry.id !== undefined && (typeof entry.id !== "string" || !MEDIA_ID_PATTERN.test(entry.id))) {
    throw invalidEntry(`id must be 1–128 of A–Z, a–z, 0–9, _ or - (got ${describe(entry.id)})`);
  }
  let mime: string;
  try {
    mime = normalizeMime(entry.mime);
  } catch {
    throw invalidEntry(`mime must be a type like image/png (got ${describe(entry.mime)})`);
  }
  const source = entry.source as Record<string, unknown> | undefined;
  switch (source?.["kind"]) {
    case "data":
      if (!(data instanceof Uint8Array)) throw invalidEntry("a data entry needs its bytes");
      break;
    case "stored":
      if (typeof source["uri"] !== "string" || !source["uri"].startsWith(MEDIA_URI_SCHEME) || !isValidMediaUri(source["uri"])) {
        throw invalidEntry(`source.uri must be briar-media://<id> (got ${describe(source["uri"])})`);
      }
      break;
    case "link":
      if (typeof source["url"] !== "string" || source["url"].startsWith(MEDIA_URI_SCHEME) || !isValidMediaUri(source["url"])) {
        throw invalidEntry(`source.url must be an http(s) URL (got ${describe(source["url"])})`);
      }
      break;
    default:
      throw invalidEntry(`source.kind must be data, stored or link (got ${describe(source?.["kind"])})`);
  }
  if (source["kind"] !== "data" && data !== undefined) throw invalidEntry("only data entries carry bytes");
  const bytes = data !== undefined ? data.byteLength : entry.bytes;
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) throw invalidEntry(`bytes must be a whole number >= 0 (got ${describe(bytes)})`);
  if (entry.hash !== undefined && (typeof entry.hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.hash))) {
    throw invalidEntry("hash must be 64 lowercase hex characters (sha-256)");
  }
  const metaProblem = mediaMetaProblems(entry.meta)[0];
  if (metaProblem) throw invalidEntry(metaProblem);
  const owner = entry.owner;
  if (owner !== undefined && (typeof owner !== "object" || owner === null || typeof owner.runId !== "string" || owner.runId === "")) {
    throw invalidEntry("owner.runId must be a run id");
  }
  return {
    ...(entry.id === undefined ? {} : { id: entry.id }),
    mime,
    source: { ...(entry.source as MediaSource) },
    ...(bytes === undefined ? {} : { bytes }),
    ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    ...(entry.meta === undefined ? {} : { meta: { ...entry.meta } }),
    ...(owner === undefined ? {} : { owner: ownerOf(owner) }),
  };
}

/** An owner with only the fields that are set. */
export function ownerOf(owner: MediaOwner): MediaOwner {
  return {
    runId: owner.runId,
    ...(owner.flowId === undefined ? {} : { flowId: owner.flowId }),
    ...(owner.contextId === undefined ? {} : { contextId: owner.contextId }),
  };
}

/** Does `owner` have every field of `match`? */
export function ownerMatches(owner: MediaOwner, match: Partial<MediaOwner>): boolean {
  return (
    (match.runId === undefined || owner.runId === match.runId) &&
    (match.flowId === undefined || owner.flowId === match.flowId) &&
    (match.contextId === undefined || owner.contextId === match.contextId)
  );
}

export function mediaExists(id: string): MediaError {
  return new MediaError("media.exists", `Media "${id}" already exists. Leave the id out to get a new one.`, { details: { mediaId: id } });
}

/** Options of {@link createMemoryMediaRegistry}. */
export interface MemoryMediaRegistryOptions {
  clock?: Clock;
  /** Ids are `idGenerator("med")`. */
  idGenerator?: IdGenerator;
}

/**
 * A media registry in memory: for tests and for `createBriar()` without storage.
 *
 * @example
 * ```ts
 * const registry = createMemoryMediaRegistry();
 * ```
 */
export function createMemoryMediaRegistry(options: MemoryMediaRegistryOptions = {}): MediaRegistry {
  const clock = options.clock ?? (() => new Date());
  const ids = options.idGenerator ?? createIdGenerator();
  const items = new Map<string, { entry: MediaEntry; data?: Uint8Array }>();
  const copy = (e: MediaEntry): MediaEntry => ({
    ...e,
    source: { ...e.source },
    ...(e.meta ? { meta: { ...e.meta } } : {}),
    ...(e.owner ? { owner: { ...e.owner } } : {}),
  });
  return {
    kind: "memory",
    async add(input, data) {
      const n = normalizeMediaEntry(input, data);
      const id = n.id ?? ids("med");
      if (items.has(id)) throw mediaExists(id);
      const entry: MediaEntry = { ...n, id, createdAt: clock().toISOString() };
      items.set(id, data === undefined ? { entry } : { entry, data: data.slice() });
      return copy(entry);
    },
    async get(id) {
      const item = items.get(id);
      return item ? copy(item.entry) : undefined;
    },
    async data(id) {
      return items.get(id)?.data?.slice();
    },
    async delete(id) {
      return items.delete(id);
    },
    async adopt(list, owner) {
      for (const id of list) {
        const item = items.get(id);
        if (item?.entry.owner) item.entry = { ...item.entry, owner: ownerOf(owner) };
      }
    },
    async owners() {
      const seen = new Map<string, MediaOwner>();
      for (const { entry } of items.values()) {
        if (entry.owner) seen.set(JSON.stringify([entry.owner.runId, entry.owner.flowId, entry.owner.contextId]), { ...entry.owner });
      }
      return [...seen.values()];
    },
    async deleteOwned(match) {
      const gone: string[] = [];
      for (const [id, { entry }] of items) {
        if (entry.owner && ownerMatches(entry.owner, match)) {
          items.delete(id);
          gone.push(id);
        }
      }
      return gone;
    },
  };
}
