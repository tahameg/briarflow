import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeContextStore, describeMediaStore } from "@briarflow/testing";
import { FsContextStore, FsMediaStore } from "@briarflow/storage-fs";

describeContextStore("FsContextStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "briar-conf-ctx-"));
  const store = new FsContextStore({ dir, durable: false });
  return { store, writeRaw: (id, text) => store.writeRaw(id, text), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

describeMediaStore("FsMediaStore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "briar-conf-media-"));
  return { store: new FsMediaStore({ dir, durable: false }), cleanup: () => rm(dir, { recursive: true, force: true }) };
});
