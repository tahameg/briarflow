import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeContext } from "@briarflow/core";
import { FsContextStore } from "../../src/index.js";
import { caught, makeDoc } from "./helpers.js";

describe("FsContextStore specifics", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "briar-fs-ctx-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes one serializeContext file per context and leaves no temp files", async () => {
    const store = new FsContextStore({ dir });
    const doc = makeDoc("ctx_a", { flows: [{ id: "flow_a", name: "A" }] });
    await store.save(doc);
    await store.save({ ...doc, revision: 2 });
    expect(await readdir(dir)).toEqual(["ctx_a.json"]);
    expect(await readFile(join(dir, "ctx_a.json"), "utf8")).toBe(serializeContext({ ...doc, revision: 2 }));
    expect(store.pathFor("ctx_a")).toBe(join(dir, "ctx_a.json"));
  });

  it("creates the directory and rebuilds the index from existing files on open", async () => {
    const nested = join(dir, "a", "b");
    const first = new FsContextStore({ dir: nested, durable: false });
    await first.save(makeDoc("ctx_a", { name: "Alpha", flows: [{ id: "flow_a", name: "A" }] }));
    await first.save(makeDoc("ctx_b", { updatedAt: "2026-10-22T00:00:00.000Z" }));
    await first.close();
    await writeFile(join(nested, "notes.txt"), "ignored");
    await writeFile(join(nested, ".ctx_a.123.tmp"), "half written");
    const second = new FsContextStore({ dir: nested });
    expect((await second.list()).items.map((s) => s.id)).toEqual(["ctx_b", "ctx_a"]);
    expect(await second.locateFlow("flow_a")).toBe("ctx_a");
    expect((await caught(second.save(makeDoc("ctx_c", { flows: [{ id: "flow_a", name: "A" }] })))).code).toBe("store.flow_id_conflict");
  });

  it("load and the revision check read the file; refresh() picks up other writers for list/locateFlow", async () => {
    const a = new FsContextStore({ dir, durable: false });
    const b = new FsContextStore({ dir, durable: false });
    await a.save(makeDoc("ctx_a", { revision: 1 }));
    expect(await b.load("ctx_a")).toMatchObject({ revision: 1 });
    await b.save(makeDoc("ctx_a", { revision: 2, flows: [{ id: "flow_b", name: "B" }] }), { expectedRevision: 1 });
    expect((await caught(a.save(makeDoc("ctx_a", { revision: 2 }), { expectedRevision: 1 }))).details).toEqual({
      id: "ctx_a",
      expected: 1,
      actual: 2,
    });
    expect(await a.locateFlow("flow_b")).toBeUndefined(); // documented limitation
    await a.refresh();
    expect(await a.locateFlow("flow_b")).toBe("ctx_a");
  });

  it("a file holding another context's id is corrupt", async () => {
    const store = new FsContextStore({ dir, durable: false });
    await writeFile(join(dir, "ctx_x.json"), serializeContext(makeDoc("ctx_y")));
    expect((await caught(store.load("ctx_x"))).code).toBe("store.corrupt");
  });

  it("ids that are not context ids never touch the file system", async () => {
    const store = new FsContextStore({ dir, durable: false });
    expect(await store.load("../x")).toBeUndefined();
    expect(await store.delete("../x")).toBe(false);
  });

  it("pathFor and writeRaw reject a malformed id with document.invalid_id (REQ-15)", async () => {
    const store = new FsContextStore({ dir, durable: false });
    let error: unknown;
    try {
      store.pathFor("../x");
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "document.invalid_id" });
    const e = await caught(store.writeRaw("ctx bad", "{}"));
    expect(e.code).toBe("document.invalid_id");
    expect(e.message).toBe('Context id "ctx bad" is invalid: expected ctx_ followed by 1–60 of A–Z, a–z, 0–9, _ or -.');
    expect(await readdir(dir)).toEqual([]);
  });
});
