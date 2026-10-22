/**
 * Extension interfaces and helpers: cursors, readMedia, logger (phase-1.md §5.11; storage.md).
 */
import { describe, expect, it, vi } from "vitest";
import {
  InvalidCursorError,
  MediaError,
  decodeCursor,
  encodeCursor,
  noopLogger,
  readMedia,
  type CursorPosition,
} from "@briarflow/core";
import { expectBriarError, expectBriarRejection, memoryMediaStore, streamOf, utf8 } from "@briarflow/testing";

const position: CursorPosition = { updatedAt: "2026-01-01T00:00:00.000Z", id: "ctx_abc", search: "mark" };

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("encodeCursor / decodeCursor", () => {
  it("round-trips", () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(decodeCursor(encodeCursor(position), "mark")).toEqual(position);
    const empty = { ...position, search: "" };
    expect(decodeCursor(encodeCursor(empty), "")).toEqual(empty);
  });

  it("round-trips unicode searches and ids", () => {
    const p = { updatedAt: "2026-10-21T12:00:00.000Z", id: "ctx_x-_9", search: "märkéting ✨" };
    expect(decodeCursor(encodeCursor(p), "märkéting ✨")).toEqual(p);
  });

  it("is base64url without padding", () => {
    for (const search of ["", "a", "ab", "abc", "???>>>", "märk"]) {
      expect(encodeCursor({ ...position, search })).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("is deterministic", () => {
    expect(encodeCursor(position)).toBe(encodeCursor({ ...position }));
  });

  it.each([
    ["not base64url", "!!!"],
    ["empty", ""],
    ["base64 of non-JSON", b64url("hello")],
    ["JSON array", b64url("[1,2]")],
    ["missing id", b64url(JSON.stringify({ updatedAt: position.updatedAt, search: "" }))],
    ["wrong field types", b64url(JSON.stringify({ updatedAt: 1, id: 2, search: 3 }))],
  ])("%s → InvalidCursorError", (_label, cursor) => {
    expectBriarError(() => decodeCursor(cursor), "store.invalid_cursor", InvalidCursorError);
  });

  it("a cursor from another search → InvalidCursorError", () => {
    expectBriarError(() => decodeCursor(encodeCursor(position), "other"), "store.invalid_cursor", InvalidCursorError);
    expectBriarError(() => decodeCursor(encodeCursor(position), ""), "store.invalid_cursor", InvalidCursorError);
  });

  it("compares normalized (trimmed) searches", () => {
    expect(decodeCursor(encodeCursor(position), "  mark ")).toEqual(position);
  });
});

describe("readMedia", () => {
  async function setup() {
    const media = memoryMediaStore();
    const ref = await media.put(utf8("hello"), { mime: "text/plain" });
    return { media, ref };
  }

  it("reads store refs, briar-media uris and bare ids", async () => {
    const { media, ref } = await setup();
    const id = ref.uri.slice("briar-media://".length);
    for (const input of [ref, ref.uri, id]) {
      expect(new TextDecoder().decode(await readMedia(input, { media }))).toBe("hello");
    }
  });

  it("reads streamed puts byte-exactly", async () => {
    const media = memoryMediaStore();
    const bytes = new Uint8Array(1000).map((_v, i) => i % 256);
    const ref = await media.put(streamOf(bytes, 7), { mime: "application/octet-stream" });
    expect(await readMedia(ref, { media })).toEqual(bytes);
  });

  it("https uses the injected fetch with the signal", async () => {
    const { media } = await setup();
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(utf8("remote"), { status: 200 }));
    const bytes = await readMedia({ uri: "https://cdn.example.com/a.txt", mime: "text/plain" }, {
      media,
      fetch: fetchMock as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(new TextDecoder().decode(bytes)).toBe("remote");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://cdn.example.com/a.txt");
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("http uris use fetch as well", async () => {
    const { media } = await setup();
    const fetchMock = vi.fn(async () => new Response(utf8("x")));
    await readMedia("http://localhost:1/a", { media, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unknown store items → media.not_found", async () => {
    const { media } = await setup();
    await expectBriarRejection(readMedia("briar-media://m_ghost", { media }), "media.not_found", MediaError);
    await expectBriarRejection(readMedia("m_ghost", { media }), "media.not_found", MediaError);
  });

  it("a 404 → media.not_found", async () => {
    const { media } = await setup();
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    await expectBriarRejection(
      readMedia("https://x.test/a.png", { media, fetch: fetchMock as unknown as typeof fetch }),
      "media.not_found",
      MediaError,
    );
  });

  it("maxBytes → media.too_large (store and fetch)", async () => {
    const { media, ref } = await setup();
    await expectBriarRejection(readMedia(ref, { media, maxBytes: 4 }), "media.too_large", MediaError);
    expect(await readMedia(ref, { media, maxBytes: 5 })).toHaveLength(5);
    const fetchMock = vi.fn(async () => new Response(utf8("123456")));
    await expectBriarRejection(
      readMedia("https://x.test/a", { media, fetch: fetchMock as unknown as typeof fetch, maxBytes: 5 }),
      "media.too_large",
      MediaError,
    );
  });

  it.each(["ftp://x/a.png", "file:///etc/passwd", "data:text/plain,hi", "not a uri"])("%s → media.invalid_uri", async (uri) => {
    const { media } = await setup();
    const fetchMock = vi.fn(async () => new Response(utf8("x")));
    await expectBriarRejection(readMedia(uri, { media, fetch: fetchMock as unknown as typeof fetch }), "media.invalid_uri", MediaError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("memoryMediaStore fixture (sanity)", () => {
  it("follows storage.md §2.2", async () => {
    const media = memoryMediaStore();
    const ref = await media.put(utf8("hello"), { mime: "Image/PNG; q=1", filename: "a.png", meta: { width: 1 } });
    expect(ref).toEqual({
      uri: "briar-media://m_1",
      mime: "image/png",
      bytes: 5,
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      meta: { width: 1, filename: "a.png" },
    });
    expect(await media.get("https://x/y")).toBeUndefined();
    expect(await media.delete(ref)).toBe(true);
    expect(await media.delete(ref)).toBe(false);
  });
});

describe("noopLogger", () => {
  it("accepts every level", () => {
    expect(() => {
      noopLogger.debug("d");
      noopLogger.info("i", { a: 1 });
      noopLogger.warn("w");
      noopLogger.error("e", { err: "x" });
    }).not.toThrow();
  });
});
