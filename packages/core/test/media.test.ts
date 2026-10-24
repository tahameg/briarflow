/**
 * Media registry, loader and media values (media.md §2–§4, types.md §8).
 */
import { describe, expect, it, vi } from "vitest";
import {
  MediaError,
  checkMediaEntry,
  createMedia,
  createMemoryMediaRegistry,
  findMedia,
  imageSize,
  isMediaRef,
  typeHasMedia,
  validateMediaRef,
  type MediaRegistry,
} from "@briarflow/core";
import { expectBriarRejection, memoryMediaStore, streamOf, utf8 } from "@briarflow/testing";

const PNG_1X1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const image = { kind: "primitive", name: "image" } as const;

function setup(options: { fetch?: typeof fetch; blobs?: boolean; memoryBytes?: number } = {}) {
  let n = 0;
  const registry = createMemoryMediaRegistry({ idGenerator: (p) => `${p}_${++n}` });
  const blobs = options.blobs ? memoryMediaStore() : undefined;
  const media = createMedia({
    registry,
    ...(blobs ? { blobs } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.memoryBytes === undefined ? {} : { memoryBytes: options.memoryBytes }),
  });
  return { registry, blobs, media };
}

describe("media values", () => {
  it("are { mediaId } and nothing else", () => {
    expect(isMediaRef({ mediaId: "med_1" })).toBe(true);
    expect(isMediaRef({ mediaId: "med_1", mime: "image/png" })).toBe(false);
    expect(isMediaRef({ uri: "briar-media://m_1", mime: "image/png" })).toBe(false);
    expect(validateMediaRef({ mediaId: "med_1" }, "image", "inputs.photo")).toEqual([]);
    const [old] = validateMediaRef({ uri: "briar-media://m_1", mime: "image/png" }, "image", "inputs.photo");
    expect(old?.code).toBe("media.invalid_ref");
    expect(old?.message).toContain("upload the file again");
  });

  it("are found inside values by type, and by shape where the type is a var", () => {
    const struct = { kind: "struct", id: "ty_c", name: "C", fields: [{ name: "portrait", type: image }, { name: "name", type: { kind: "primitive", name: "text" } }] } as const;
    const getType = (id: string) => (id === "ty_c" ? struct : undefined);
    const value = [{ portrait: { mediaId: "a" }, name: "x" }, { portrait: { mediaId: "b" }, name: "y" }];
    const found = findMedia(value, { kind: "list", of: { kind: "named", id: "ty_c" } }, getType);
    expect(found.map((f) => [f.ref.mediaId, f.path])).toEqual([
      ["a", "[0].portrait"],
      ["b", "[1].portrait"],
    ]);
    expect(findMedia({ any: [{ mediaId: "c" }] }, { kind: "var", name: "T" }, getType).map((f) => f.ref.mediaId)).toEqual(["c"]);
    expect(typeHasMedia({ kind: "named", id: "ty_c" }, getType)).toBe(true);
    expect(typeHasMedia({ kind: "primitive", name: "text" }, getType)).toBe(false);
  });

  it("entries are checked against the port type", () => {
    expect(checkMediaEntry({ mime: "image/png" }, image, "inputs.a")).toEqual([]);
    expect(checkMediaEntry({ mime: "video/mp4" }, image, "inputs.a")[0]?.code).toBe("media.kind_mismatch");
    const small = { kind: "primitive", name: "image", constraints: { maxWidth: 10, formats: ["png"] } } as const;
    expect(checkMediaEntry({ mime: "image/png", meta: { width: 20 } }, small, "inputs.a")[0]?.message).toBe("inputs.a must be at most 10 px wide.");
    expect(checkMediaEntry({ mime: "image/jpeg" }, small, "inputs.a")[0]?.message).toContain("formats png");
  });
});

describe("media registry (memory)", () => {
  it("adds data entries with their bytes and checks entries", async () => {
    const { registry } = setup();
    const e = await registry.add({ mime: "Text/Plain", source: { kind: "data" }, owner: { runId: "run_1", flowId: "flow_a" } }, utf8("hi"));
    expect(e).toMatchObject({ id: "med_1", mime: "text/plain", bytes: 2, owner: { runId: "run_1", flowId: "flow_a" } });
    expect(await registry.data(e.id)).toEqual(utf8("hi"));
    await expectBriarRejection(registry.add({ mime: "text/plain", source: { kind: "data" } }), "media.invalid_entry", MediaError);
    await expectBriarRejection(registry.add({ mime: "image/png", source: { kind: "link", url: "ftp://x" } }), "media.invalid_entry", MediaError);
    await expectBriarRejection(registry.add({ id: e.id, mime: "image/png", source: { kind: "link", url: "https://x.test/a.png" } }), "media.exists", MediaError);
  });

  it("adopts and deletes transient entries by owner", async () => {
    const { registry } = setup();
    const a = await registry.add({ mime: "image/png", source: { kind: "data" }, owner: { runId: "run_1", flowId: "f" } }, PNG_1X1);
    const b = await registry.add({ mime: "image/png", source: { kind: "data" }, owner: { runId: "run_1", flowId: "f" } }, PNG_1X1);
    const kept = await registry.add({ mime: "image/png", source: { kind: "link", url: "https://x.test/a.png" } });
    await registry.adopt([a.id, kept.id], { runId: "run_2", flowId: "f" });
    expect((await registry.get(a.id))?.owner?.runId).toBe("run_2");
    expect((await registry.get(kept.id))?.owner).toBeUndefined();
    expect((await registry.owners()).map((o) => o.runId).sort()).toEqual(["run_1", "run_2"]);
    expect(await registry.deleteOwned({ runId: "run_1" })).toEqual([b.id]);
    expect(await registry.get(b.id)).toBeUndefined();
    expect(await registry.get(kept.id)).toBeDefined();
  });
});

describe("media loader", () => {
  it("puts data entries with the image size from the header", async () => {
    const { media } = setup();
    const e = await media.put(PNG_1X1, { mime: "image/png", filename: "dot.png" });
    expect(e).toMatchObject({ mime: "image/png", bytes: PNG_1X1.byteLength, source: { kind: "data" }, meta: { width: 1, height: 1, filename: "dot.png" } });
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await media.read({ mediaId: e.id })).toEqual(PNG_1X1);
  });

  it("reads from memory first, then the registry", async () => {
    const { registry, media } = setup();
    const e = await media.put(utf8("hello"), { mime: "text/plain" });
    const data = vi.spyOn(registry, "data");
    await media.read(e.id);
    expect(data).not.toHaveBeenCalled();
    const cold = createMedia({ registry, memoryBytes: 0 });
    expect(new TextDecoder().decode(await cold.read(e.id))).toBe("hello");
    expect(data).toHaveBeenCalledTimes(1);
  });

  it("drops the least recently used bytes above its memory limit", async () => {
    const { media } = setup({ memoryBytes: 10 });
    await media.put(utf8("123456"), { mime: "text/plain" });
    await media.put(utf8("abcdef"), { mime: "text/plain" });
    expect(media.memoryUsed()).toBe(6);
  });

  it("uploads to the blob store as stored entries", async () => {
    const { media, blobs } = setup({ blobs: true });
    const e = await media.upload(streamOf(PNG_1X1, 5), { mime: "image/png", filename: "dot.png" });
    expect(e.source).toEqual({ kind: "stored", uri: "briar-media://m_1" });
    expect(e.meta).toMatchObject({ width: 1, height: 1, filename: "dot.png" });
    expect(e.owner).toBeUndefined();
    expect(blobs?.size).toBe(1);
    const fresh = createMedia({ registry: media.registry, ...(blobs ? { blobs } : {}), memoryBytes: 0 });
    expect(await fresh.read(e.id)).toEqual(PNG_1X1);
  });

  it("gives public URLs for links and for blobs the store can resolve", async () => {
    const { media, blobs } = setup({ blobs: true });
    const up = await media.upload(utf8("x"), { mime: "text/plain" });
    expect(await media.url(up.id)).toBeUndefined();
    blobs!.resolveUrl = async (ref) => `https://cdn.test/${ref.uri.slice("briar-media://".length)}`;
    expect(await media.url(up.id)).toBe("https://cdn.test/m_1");
    const link = await media.link("https://x.test/a.png", { mime: "image/png" });
    expect(await media.forNode({}).url({ mediaId: link.id })).toBe("https://x.test/a.png");
    const data = await media.put(utf8("y"), { mime: "text/plain" });
    expect(await media.url(data.id)).toBeUndefined();
  });

  it("finds blobs stored before the registry by their blob id", async () => {
    const { media, blobs } = setup({ blobs: true });
    const blob = await blobs!.put(utf8("old"), { mime: "text/plain" });
    const id = blob.uri.slice("briar-media://".length);
    expect(await media.entry(id)).toMatchObject({ id, source: { kind: "stored", uri: blob.uri }, mime: "text/plain" });
    expect(new TextDecoder().decode(await media.read({ mediaId: id }))).toBe("old");
  });

  it("fetches link entries with the given fetch and signal", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(utf8("remote")));
    const { media } = setup({ fetch: fetchMock as unknown as typeof fetch });
    const e = await media.link("https://cdn.example.com/a.txt", { mime: "text/plain" });
    const controller = new AbortController();
    expect(new TextDecoder().decode(await media.read(e.id, { signal: controller.signal }))).toBe("remote");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://cdn.example.com/a.txt");
    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(controller.signal);
    const opened = await media.open(e.id);
    expect("url" in opened && opened.url).toBe("https://cdn.example.com/a.txt");
  });

  it("fails with clear codes", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => new Response("", { status: String(url).includes("missing") ? 404 : 500 }));
    const { media } = setup({ fetch: fetchMock as unknown as typeof fetch });
    await expectBriarRejection(media.read("med_ghost"), "media.not_found", MediaError);
    await expectBriarRejection(media.read({ mediaId: "bad id" }), "media.invalid_ref", MediaError);
    const e = await media.put(utf8("hello"), { mime: "text/plain" });
    await expectBriarRejection(media.read(e.id, { maxBytes: 4 }), "media.too_large", MediaError);
    const missing = await media.link("https://x.test/missing", { mime: "image/png" });
    await expectBriarRejection(media.read(missing.id), "media.not_found", MediaError);
    const broken = await media.link("https://x.test/err", { mime: "image/png" });
    await expectBriarRejection(media.read(broken.id), "media.fetch_failed", MediaError);
    const stored = await media.registry.add({ mime: "image/png", source: { kind: "stored", uri: "briar-media://m_9" } });
    await expectBriarRejection(media.read(stored.id), "media.unavailable", MediaError);
  });

  it("detects a corrupt entry", async () => {
    const registry: MediaRegistry = createMemoryMediaRegistry();
    const e = await registry.add({ mime: "text/plain", source: { kind: "data" }, bytes: 99 }, utf8("hi"));
    // The registry records the real size; a store that lies is caught by the loader.
    const lying: MediaRegistry = { ...registry, get: async (id) => ({ ...(await registry.get(id))!, bytes: 99 }) };
    await expectBriarRejection(createMedia({ registry: lying }).read(e.id), "media.corrupt", MediaError);
  });

  it("scopes node media to the run", async () => {
    const { media } = setup();
    const node = media.forNode({ owner: { runId: "run_7", flowId: "flow_a", contextId: "ctx_a" } });
    const ref = await node.put(utf8("x"), { mime: "text/plain" });
    expect(ref).toEqual({ mediaId: "med_1" });
    expect((await node.entry(ref)).owner).toEqual({ runId: "run_7", flowId: "flow_a", contextId: "ctx_a" });
    await expectBriarRejection(node.entry({ mediaId: "nope" }), "media.not_found", MediaError);
    expect(await media.deleteOwned({ flowId: "flow_a" })).toEqual(["med_1"]);
    await expectBriarRejection(node.read(ref), "media.not_found", MediaError);
  });
});

describe("imageSize", () => {
  it("reads PNG, GIF, JPEG and WebP headers", () => {
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0]);
    expect(imageSize(gif)).toEqual({ width: 3, height: 2 });
    // SOI, APP0 (len 4), SOF0 with height 0x0102 and width 0x0304.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 2, 3, 4, 3, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 0x0304, height: 0x0102 });
    const webp = new Uint8Array(30);
    webp.set([...utf8("RIFF")], 0);
    webp.set([...utf8("WEBPVP8X")], 8);
    webp.set([9, 0, 0, 4, 0, 0], 24);
    expect(imageSize(webp)).toEqual({ width: 10, height: 5 });
    expect(imageSize(utf8("not an image"))).toBeUndefined();
  });
});
