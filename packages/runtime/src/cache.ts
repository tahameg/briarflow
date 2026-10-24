/**
 * Node result cache (docs/specs/runtime.md §6).
 */
import { canonicalJson, sha256Hex, type MediaRef, type TypeDecl, type TypeRef } from "@briarflow/core";

/**
 * Stores successful node outputs by cache key. Errors thrown by an implementation are logged
 * by the engine and treated as misses.
 *
 * @example
 * ```ts
 * const cache: RunCache = { get: async (key) => map.get(key), set: async (key, outputs) => void map.set(key, outputs) };
 * ```
 */
export interface RunCache {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, outputs: Record<string, unknown>): Promise<void>;
}

/** The in-memory LRU cache returned by {@link createMemoryCache}. */
export interface MemoryCache extends RunCache {
  /** Number of stored entries. */
  readonly size: number;
  /** Removes every entry. */
  clear(): void;
}

/** Options of {@link createMemoryCache}. */
export interface MemoryCacheOptions {
  /** Least recently used entries are evicted above this count. Default 500. */
  maxEntries?: number;
}

/**
 * In-memory LRU cache, the engine default (500 entries, shared by all runs of an engine).
 *
 * @example
 * ```ts
 * const engine = createEngine({ catalog, media, secrets, cache: createMemoryCache({ maxEntries: 50 }) });
 * ```
 */
export function createMemoryCache(options: MemoryCacheOptions = {}): MemoryCache {
  const maxEntries = options.maxEntries ?? 500;
  const entries = new Map<string, Record<string, unknown>>();
  return {
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    async get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    async set(key, outputs) {
      entries.delete(key);
      entries.set(key, outputs);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/** What a cache key is computed from (runtime.md §6). */
export interface CacheKeyInput {
  nodeType: string;
  /** Variant of a node type with variants. */
  variant?: string;
  /** `"<pack name>@<pack version>"`. */
  pack: string;
  cacheVersion: string;
  config: Record<string, unknown>;
  typeBindings: Record<string, TypeRef>;
  /** Resolved inputs with every MediaRef replaced by `{ $media: hash ?? uri }`. */
  inputs: Record<string, unknown>;
}

/**
 * Cache key: lowercase hex sha-256 of the canonical JSON of
 * `{ v: 1, nodeType, variant?, pack, cacheVersion, config, typeBindings, inputs }`.
 *
 * @example
 * ```ts
 * await computeCacheKey({ nodeType: "mock.llm", pack: "mock@0.1.0", cacheVersion: "1", config: {}, typeBindings: {}, inputs: { prompt: "hi" } });
 * ```
 */
export function computeCacheKey(input: CacheKeyInput): Promise<string> {
  return sha256Hex(
    canonicalJson({
      v: 1,
      nodeType: input.nodeType,
      ...(input.variant === undefined ? {} : { variant: input.variant }),
      pack: input.pack,
      cacheVersion: input.cacheVersion,
      config: input.config,
      typeBindings: input.typeBindings,
      inputs: input.inputs,
    }),
  );
}

const MEDIA_KINDS = new Set(["image", "video", "audio", "model3d", "file"]);
const MEDIA_REF_KEYS = new Set(["uri", "mime", "bytes", "hash", "meta"]);

function mediaKey(ref: MediaRef): { $media: string } {
  return { $media: typeof ref.hash === "string" ? ref.hash : ref.uri };
}

function looksLikeMediaRef(value: Record<string, unknown>): boolean {
  return typeof value["uri"] === "string" && typeof value["mime"] === "string" && Object.keys(value).every((k) => MEDIA_REF_KEYS.has(k));
}

function untyped(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(untyped);
  const rec = value as Record<string, unknown>;
  if (looksLikeMediaRef(rec)) return mediaKey(rec as unknown as MediaRef);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = untyped(v);
  return out;
}

/**
 * Internal: replaces MediaRefs inside a value by `{ $media }`, guided by the value's type
 * (unbound generics fall back to recognising MediaRef-shaped objects).
 */
export function replaceMedia(value: unknown, type: TypeRef | undefined, getType: (id: string) => TypeDecl | undefined): unknown {
  if (value === null || typeof value !== "object") return value;
  if (type === undefined || type.kind === "var") return untyped(value);
  switch (type.kind) {
    case "optional":
      return replaceMedia(value, type.of, getType);
    case "primitive":
      return MEDIA_KINDS.has(type.name) ? mediaKey(value as MediaRef) : value;
    case "list":
      return Array.isArray(value) ? value.map((item) => replaceMedia(item, type.of, getType)) : value;
    case "named": {
      const decl = getType(type.id);
      if (!decl || decl.kind !== "struct" || Array.isArray(value)) return decl?.kind === "enum" ? value : untyped(value);
      const rec = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        const field = decl.fields.find((f) => f.name === k);
        out[k] = replaceMedia(v, field?.type, getType);
      }
      return out;
    }
  }
}
