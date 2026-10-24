import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMedia, createMemoryMediaRegistry } from "@briarflow/core";
import type { BlobRef } from "@briarflow/core";
import { FsMediaStore } from "../../src/index.js";
import { caught } from "./helpers.js";

const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const enc = new TextEncoder();

function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

async function bytesOf(store: FsMediaStore, ref: BlobRef | string): Promise<Uint8Array | undefined> {
  const got = await store.get(ref);
  return got ? new Uint8Array(await new Response(got.body).arrayBuffer()) : undefined;
}

describe("FsMediaStore (storage.md §3 MediaStore checks)", () => {
  let dir: string;
  let store: FsMediaStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "briar-fs-media-"));
    store = new FsMediaStore({ dir: join(dir, "media"), durable: false });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("1. put returns a briar-media uri, bytes, hash and normalized mime", async () => {
    const ref = await store.put(enc.encode("hello"), { mime: "Text/Plain; charset=utf-8" });
    expect(ref.uri).toMatch(/^briar-media:\/\/[A-Za-z0-9_-]{1,128}$/);
    expect(ref).toEqual({ uri: ref.uri, mime: "text/plain", bytes: 5, hash: HELLO_SHA });
    expect((await caught(store.put(enc.encode("x"), { mime: "not a mime" }))).code).toBe("media.invalid_mime");
    expect((await caught(store.put(enc.encode("x"), { mime: "" }))).code).toBe("media.invalid_mime");
  });

  it("2. Uint8Array and chunked ReadableStream give identical results", async () => {
    const data = new Uint8Array(100_000).map((_, i) => i % 251);
    const a = await store.put(data, { mime: "application/octet-stream" });
    const b = await store.put(chunked(data, 7_777), { mime: "application/octet-stream" });
    expect(b).toEqual(a);
    expect(Buffer.from((await bytesOf(store, b))!).equals(Buffer.from(data))).toBe(true);
  });

  it("3. get by ref, uri and id; unknown and https are undefined", async () => {
    const ref = await store.put(enc.encode("hello"), { mime: "text/plain" });
    const id = ref.uri.slice("briar-media://".length);
    for (const key of [ref, ref.uri, id]) {
      const got = await store.get(key);
      expect(got?.ref).toEqual(ref);
      expect(new TextDecoder().decode(await new Response(got!.body).arrayBuffer())).toBe("hello");
    }
    expect(await store.get("briar-media://" + "0".repeat(64))).toBeUndefined();
    expect(await store.get("m_unknown")).toBeUndefined();
    expect(await store.get("https://example.com/" + id)).toBeUndefined();
    expect(await store.get({ ...ref, uri: "https://example.com/x" })).toBeUndefined();
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    // each get is a fresh stream
    const one = await store.get(ref);
    const two = await store.get(ref);
    expect(one!.body).not.toBe(two!.body);
    // The media loader reads a blob as a stored entry, found by its blob id.
    expect(await createMedia({ registry: createMemoryMediaRegistry(), blobs: store }).read(id)).toEqual(enc.encode("hello"));
    await one!.body.cancel();
    await two!.body.cancel();
  });

  it("4. empty and 5 MB payloads round-trip", async () => {
    const empty = await store.put(new Uint8Array(0), { mime: "application/octet-stream" });
    expect(empty.bytes).toBe(0);
    expect(empty.hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await bytesOf(store, empty)).toEqual(new Uint8Array(0));
    const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => (i * 31) % 256);
    const ref = await store.put(chunked(big, 64 * 1024), { mime: "video/mp4" });
    expect(ref.bytes).toBe(big.byteLength);
    const back = await bytesOf(store, ref);
    expect(back?.byteLength).toBe(big.byteLength);
    expect(Buffer.from(back!).equals(Buffer.from(big))).toBe(true); // toEqual on 5 MB is very slow
  });

  it("5. delete then get", async () => {
    const ref = await store.put(enc.encode("bye"), { mime: "text/plain" });
    expect(await store.delete(ref.uri)).toBe(true);
    expect(await store.delete(ref)).toBe(false);
    expect(await store.get(ref)).toBeUndefined();
    expect(await store.delete("https://example.com/x")).toBe(false);
    expect((await readdir(join(dir, "media"))).filter((n) => !n.startsWith("."))).toEqual([]);
  });

  it("6. content-addressed: identical content and info give the same ref; info changes the id", async () => {
    expect(store.contentAddressed).toBe(true);
    const refs = await Promise.all(Array.from({ length: 50 }, () => store.put(enc.encode("same"), { mime: "text/plain" })));
    expect(new Set(refs.map((r) => r.uri)).size).toBe(1);
    const other = await store.put(enc.encode("same"), { mime: "text/markdown" });
    const named = await store.put(enc.encode("same"), { mime: "text/plain", filename: "a.txt" });
    expect(new Set([refs[0]!.uri, other.uri, named.uri]).size).toBe(3);
    expect(other.hash).toBe(refs[0]!.hash);
    expect((await store.get(named))?.ref.meta).toEqual({ filename: "a.txt" });
    expect((await store.get(refs[0]!))?.ref.meta).toBeUndefined();
    expect((await readdir(join(dir, "media"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("7. meta and filename are preserved", async () => {
    const ref = await store.put(enc.encode("png"), { mime: "image/png", filename: "cat.png", meta: { width: 4, height: 3 } });
    expect(ref.meta).toEqual({ width: 4, height: 3, filename: "cat.png" });
    expect((await store.get(ref))?.ref).toEqual(ref);
    ref.meta!["width"] = 99; // the returned ref is not shared with the store
    expect((await store.get(ref.uri))?.ref.meta).toEqual({ width: 4, height: 3, filename: "cat.png" });
  });

  it("8. resolveUrl is not implemented", () => {
    expect((store as { resolveUrl?: unknown }).resolveUrl).toBeUndefined();
  });

  it("maxBytes rejects large bodies and leaves no files", async () => {
    const limited = new FsMediaStore({ dir: join(dir, "limited"), maxBytes: 10 });
    await limited.put(new Uint8Array(10), { mime: "application/octet-stream" });
    const err = await caught(limited.put(chunked(new Uint8Array(100), 3), { mime: "application/octet-stream" }));
    expect(err).toMatchObject({ code: "media.too_large", details: { maxBytes: 10 } });
    expect((await readdir(join(dir, "limited"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("a failing input stream rejects and leaves no files", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.error(new Error("network down"));
      },
    });
    await expect(store.put(failing, { mime: "image/png" })).rejects.toThrow("network down");
    expect(await readdir(join(dir, "media"))).toEqual([]);
  });

  it("a stream obtained before delete still yields the bytes", async () => {
    const ref = await store.put(enc.encode("still here"), { mime: "text/plain" });
    const got = await store.get(ref);
    await store.delete(ref);
    expect(new TextDecoder().decode(await new Response(got!.body).arrayBuffer())).toBe("still here");
  });
});
