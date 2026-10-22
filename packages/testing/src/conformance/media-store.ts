/**
 * `describeMediaStore`: the MediaStore conformance suite of docs/specs/storage.md §3
 * (MediaStore checks 1–8).
 *
 * ```ts
 * describeMediaStore("fs", async () => {
 *   const dir = await mkdtemp(join(tmpdir(), "media-"));
 *   return { store: new FsMediaStore({ dir }), cleanup: () => rm(dir, { recursive: true }) };
 * });
 * ```
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBriarError, type MediaRef, type MediaStore } from "@briarflow/core";
import { HELLO_SHA256, streamOf, utf8 } from "../fixtures/media.js";

/** What the factory of {@link describeMediaStore} returns: a fresh, empty store. */
export interface MediaStoreFixture {
  store: MediaStore;
  /** Called after each test. */
  cleanup?: () => void | Promise<void>;
  /**
   * The store derives ids from content (storage.md §2.1), so identical puts return the same
   * ref. Default: `store.contentAddressed === true`.
   */
  contentAddressed?: boolean;
}

/** Options of {@link describeMediaStore}. */
export interface MediaStoreSuiteOptions {
  /** Timeout for the 5 MB and 1000-put checks. Default 60 000 ms. */
  slowTimeoutMs?: number;
}

const URI_PATTERN = /^briar-media:\/\/[A-Za-z0-9_-]{1,128}$/;

/** Reads a stream fully. */
export async function readStream(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Byte-wise equality (cheap for large arrays, unlike deep `toEqual`). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function idOf(ref: MediaRef): string {
  return ref.uri.slice("briar-media://".length);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic pseudo-random bytes. */
function pattern(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/**
 * Registers the MediaStore conformance suite (storage.md §3) as a Vitest `describe` block.
 * `factory` is called before every test and must return a fresh, empty store.
 *
 * @example
 * ```ts
 * describeMediaStore("memory", () => ({ store: new MemoryMediaStore() }));
 * ```
 */
export function describeMediaStore(
  name: string,
  factory: () => MediaStoreFixture | Promise<MediaStoreFixture>,
  options: MediaStoreSuiteOptions = {},
): void {
  const slow = options.slowTimeoutMs ?? 60_000;

  describe(`MediaStore conformance: ${name}`, () => {
    let fixture: MediaStoreFixture;
    let store: MediaStore;
    let contentAddressed = false;

    beforeEach(async () => {
      fixture = await factory();
      store = fixture.store;
      contentAddressed = fixture.contentAddressed ?? (store as { contentAddressed?: unknown }).contentAddressed === true;
    });

    afterEach(async () => {
      await fixture.cleanup?.();
    });

    it("has a non-empty kind", () => {
      expect(typeof store.kind).toBe("string");
      expect(store.kind.length).toBeGreaterThan(0);
    });

    it("1. put returns a briar-media uri, exact bytes, sha-256 hash and a normalized mime", async () => {
      const ref = await store.put(utf8("hello"), { mime: "Text/Plain; charset=utf-8" });
      expect(ref.uri).toMatch(URI_PATTERN);
      expect(ref.bytes).toBe(5);
      expect(ref.hash).toBe(HELLO_SHA256);
      expect(ref.mime).toBe("text/plain");
      const png = await store.put(utf8("png?"), { mime: "Image/PNG; q=1" });
      expect(png.mime).toBe("image/png");
    });

    it("1b. an invalid mime is media.invalid_mime", async () => {
      for (const mime of ["png", "", "image/"]) {
        let caught: unknown;
        try {
          await store.put(utf8("x"), { mime });
        } catch (error) {
          caught = error;
        }
        expect(isBriarError(caught), `put with mime ${JSON.stringify(mime)} should throw a BriarError`).toBe(true);
        expect((caught as { code: string }).code).toBe("media.invalid_mime");
      }
    });

    it("2. put from a Uint8Array and from a chunked ReadableStream give identical results", async () => {
      const bytes = pattern(10_000, 7);
      const fromBytes = await store.put(bytes, { mime: "application/octet-stream", filename: "a.bin" });
      const fromStream = await store.put(streamOf(bytes, 777), { mime: "application/octet-stream", filename: "a.bin" });
      expect(fromStream.bytes).toBe(fromBytes.bytes);
      expect(fromStream.hash).toBe(fromBytes.hash);
      expect(fromStream.hash).toBe(await sha256(bytes));
      expect(fromStream.mime).toBe(fromBytes.mime);
      expect(fromStream.meta).toEqual(fromBytes.meta);
      const got = await store.get(fromStream);
      expect(got).toBeDefined();
      expect(bytesEqual(await readStream(got!.body), bytes)).toBe(true);
    });

    it("2b. put does not keep a reference to the caller's array", async () => {
      const bytes = utf8("hello");
      const ref = await store.put(bytes, { mime: "text/plain" });
      bytes[0] = 0;
      const got = await store.get(ref);
      expect(new TextDecoder().decode(await readStream(got!.body))).toBe("hello");
    });

    it("3. get by ref, by uri and by bare id return the same bytes and the stored ref", async () => {
      const ref = await store.put(utf8("hello"), { mime: "text/plain", meta: { a: 1 } });
      for (const key of [ref, ref.uri, idOf(ref)]) {
        const got = await store.get(key);
        expect(got, `get(${JSON.stringify(key)})`).toBeDefined();
        expect(got!.ref).toEqual(ref);
        expect(new TextDecoder().decode(await readStream(got!.body))).toBe("hello");
      }
      // Each get returns a new stream.
      const a = await store.get(ref);
      const b = await store.get(ref);
      expect(a!.body).not.toBe(b!.body);
      expect(new TextDecoder().decode(await readStream(a!.body))).toBe("hello");
      expect(new TextDecoder().decode(await readStream(b!.body))).toBe("hello");
    });

    it("3b. unknown ids and non-store uris are undefined", async () => {
      expect(await store.get("briar-media://m_doesnotexist")).toBeUndefined();
      expect(await store.get("m_doesnotexist")).toBeUndefined();
      expect(await store.get("https://example.com/a.png")).toBeUndefined();
      expect(await store.get({ uri: "https://example.com/a.png", mime: "image/png" })).toBeUndefined();
    });

    it(
      "4. empty and 5 MB payloads round-trip",
      async () => {
        const empty = await store.put(new Uint8Array(0), { mime: "application/octet-stream" });
        expect(empty.bytes).toBe(0);
        expect(empty.hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        const gotEmpty = await store.get(empty);
        expect((await readStream(gotEmpty!.body)).length).toBe(0);

        const big = pattern(5 * 1024 * 1024, 42);
        const ref = await store.put(big, { mime: "application/octet-stream" });
        expect(ref.bytes).toBe(big.length);
        expect(ref.hash).toBe(await sha256(big));
        const got = await store.get(ref);
        const back = await readStream(got!.body);
        expect(back.length).toBe(big.length);
        expect(bytesEqual(back, big)).toBe(true);
      },
      slow,
    );

    it("5. delete: true then false; get afterwards is undefined", async () => {
      const ref = await store.put(utf8("bye"), { mime: "text/plain" });
      const other = await store.put(utf8("stay"), { mime: "text/plain" });
      expect(await store.delete(ref)).toBe(true);
      expect(await store.delete(ref)).toBe(false);
      expect(await store.get(ref)).toBeUndefined();
      expect(await store.get(ref.uri)).toBeUndefined();
      expect(await store.delete("https://example.com/x")).toBe(false);
      expect(await store.get(other)).toBeDefined();
      // delete accepts a uri and a bare id as well.
      expect(await store.delete(idOf(other))).toBe(true);
      const third = await store.put(utf8("third"), { mime: "text/plain" });
      expect(await store.delete(third.uri)).toBe(true);
    });

    it(
      "6. ids over 1000 puts of identical content: unique (or one ref when content-addressed)",
      async () => {
        const refs: MediaRef[] = [];
        for (let i = 0; i < 1000; i++) refs.push(await store.put(utf8("same"), { mime: "text/plain" }));
        const uris = new Set(refs.map((r) => r.uri));
        if (contentAddressed) {
          expect(uris.size).toBe(1);
          for (const r of refs) expect(r).toEqual(refs[0]);
        } else {
          expect(uris.size).toBe(1000);
        }
        for (const r of refs) expect(r.uri).toMatch(URI_PATTERN);
      },
      slow,
    );

    it("6b. ids are never reused after delete (unless content-addressed)", async () => {
      const first = await store.put(utf8("a"), { mime: "text/plain" });
      await store.delete(first);
      const second = await store.put(utf8("a"), { mime: "text/plain" });
      if (!contentAddressed) expect(second.uri).not.toBe(first.uri);
      expect(await store.get(second)).toBeDefined();
    });

    it("7. meta and filename are preserved", async () => {
      const ref = await store.put(utf8("<svg/>"), {
        mime: "image/svg+xml",
        filename: "logo.svg",
        meta: { width: 64, height: 32, custom: { list: [1, "two"] } },
      });
      expect(ref.meta).toEqual({ width: 64, height: 32, custom: { list: [1, "two"] }, filename: "logo.svg" });
      const got = await store.get(ref.uri);
      expect(got!.ref).toEqual(ref);
      const plain = await store.put(utf8("x"), { mime: "text/plain" });
      expect(plain.meta === undefined || Object.keys(plain.meta).length === 0).toBe(true);
      const named = await store.put(utf8("x"), { mime: "text/plain", filename: "x.txt" });
      expect(named.meta).toEqual({ filename: "x.txt" });
    });

    it("8. resolveUrl, if present, returns a string URL or undefined", async (ctx) => {
      if (typeof store.resolveUrl !== "function") {
        ctx.skip();
        return;
      }
      const ref = await store.put(utf8("hello"), { mime: "text/plain" });
      const url = await store.resolveUrl(ref);
      if (url !== undefined) {
        expect(typeof url).toBe("string");
        expect(() => new URL(url)).not.toThrow();
      }
    });
  });
}
