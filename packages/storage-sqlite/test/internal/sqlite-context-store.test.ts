import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLITE_SCHEMA_VERSION, SqliteContextStore } from "../../src/index.js";
import { caught, makeDoc } from "./helpers.js";

describe("SqliteContextStore specifics", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "briar-sqlite-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records schema migrations and reopens an existing database", async () => {
    const file = join(dir, "db.sqlite");
    const doc = makeDoc("ctx_a", { flows: [{ id: "flow_a", name: "A" }] });
    const first = new SqliteContextStore({ file });
    await first.save(doc);
    await first.close();
    const second = new SqliteContextStore({ file });
    expect(await second.load("ctx_a")).toEqual(doc);
    expect(await second.locateFlow("flow_a")).toBe("ctx_a");
    await second.close();
    const db = new Database(file);
    expect(db.prepare("SELECT version FROM migrations ORDER BY version").all()).toEqual([{ version: SQLITE_SCHEMA_VERSION }]);
    db.close();
  });

  it("refuses a database with a newer schema", () => {
    const file = join(dir, "db.sqlite");
    new SqliteContextStore({ file }).close();
    const db = new Database(file);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(SQLITE_SCHEMA_VERSION + 1, "x");
    db.close();
    expect(() => new SqliteContextStore({ file })).toThrow(expect.objectContaining({ code: "store.unsupported_schema" }));
  });

  it("two connections to one file: revision checks and flow ids hold across them", async () => {
    const file = join(dir, "db.sqlite");
    const a = new SqliteContextStore({ file });
    const b = new SqliteContextStore({ file });
    await a.save(makeDoc("ctx_a", { revision: 1, flows: [{ id: "flow_a", name: "A" }] }));
    await b.save(makeDoc("ctx_a", { revision: 2, flows: [{ id: "flow_a", name: "A" }] }), { expectedRevision: 1 });
    expect((await caught(a.save(makeDoc("ctx_a", { revision: 2 }), { expectedRevision: 1 }))).code).toBe("store.revision_conflict");
    expect((await caught(a.save(makeDoc("ctx_b", { flows: [{ id: "flow_a", name: "A" }] })))).code).toBe("store.flow_id_conflict");
    expect(await a.locateFlow("flow_a")).toBe("ctx_a");
    await a.close();
    await b.close();
  });

  it("search treats LIKE wildcards literally", async () => {
    const store = new SqliteContextStore({ file: ":memory:" });
    await store.save(makeDoc("ctx_a", { name: "100% done_ok" }));
    await store.save(makeDoc("ctx_b", { name: "100 x done" }));
    expect((await store.list({ search: "100%" })).items.map((s) => s.id)).toEqual(["ctx_a"]);
    expect((await store.list({ search: "e_o" })).items.map((s) => s.id)).toEqual(["ctx_a"]);
    await store.close();
  });

  it("writeRaw rejects a malformed id with document.invalid_id (REQ-15)", async () => {
    const store = new SqliteContextStore({ file: ":memory:" });
    const e = await caught(store.writeRaw("nope", "{}"));
    expect(e.code).toBe("document.invalid_id");
    expect(e.message).toContain('Context id "nope" is invalid');
    expect((await store.list()).items).toEqual([]);
    await store.close();
  });
});
