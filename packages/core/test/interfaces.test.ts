/**
 * Extension interfaces and helpers: cursors, the blob-store fixture, logger (phase-1.md §5.11; storage.md).
 * The media registry and loader are tested in media.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  InvalidCursorError,
  MediaError,
  decodeCursor,
  encodeCursor,
  noopLogger,
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
