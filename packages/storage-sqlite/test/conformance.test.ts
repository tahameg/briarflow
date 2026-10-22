import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeContextStore } from "@briarflow/testing";
import { SqliteContextStore } from "@briarflow/storage-sqlite";

describeContextStore("SqliteContextStore (:memory:)", () => {
  const store = new SqliteContextStore({ file: ":memory:" });
  return { store, writeRaw: (id, text) => store.writeRaw(id, text) };
});

describeContextStore("SqliteContextStore (file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "briar-conf-sqlite-"));
  const store = new SqliteContextStore({ file: join(dir, "briar.db") });
  return { store, writeRaw: (id, text) => store.writeRaw(id, text), cleanup: () => rm(dir, { recursive: true, force: true }) };
});
