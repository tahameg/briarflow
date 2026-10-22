import { afterEach, describe, expect, it } from "vitest";
import { isBriarError } from "@briarflow/core";
import type { MediaRef, MediaStore, StoredMedia } from "@briarflow/core";
import { LoopbackMediaServer } from "../../src/media-server.js";

const REF: MediaRef = { uri: "briar-media://m1", mime: "text/plain", bytes: 2 };

const store: MediaStore = {
  kind: "fake",
  put: () => Promise.reject(new Error("unused")),
  delete: () => Promise.resolve(false),
  get: (): Promise<StoredMedia> =>
    Promise.resolve({
      ref: REF,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("hi"));
          c.close();
        },
      }),
    }),
};

describe("LoopbackMediaServer publicUrl (REQ-18)", () => {
  const servers: LoopbackMediaServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("defaults the advertised base to the bound host and port", async () => {
    const server = new LoopbackMediaServer();
    servers.push(server);
    const { url, token } = await server.register(REF, store);
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/media/${token}$`));
    const res = await fetch(url);
    expect(await res.text()).toBe("hi");
  });

  it("uses publicUrl (trailing slashes dropped, path prefix kept) in place of the bind address", async () => {
    const server = new LoopbackMediaServer({ host: "127.0.0.1", publicUrl: "http://briar-host.internal:8790/prefix/" });
    servers.push(server);
    const { url, token } = await server.register(REF, store);
    expect(url).toBe(`http://briar-host.internal:8790/prefix/media/${token}`);
  });

  it.each(["not a url", "ftp://x", "http://x/?q=1", "http://x/#f"])("rejects publicUrl %j with python.invalid_options", (publicUrl) => {
    let error: unknown;
    try {
      new LoopbackMediaServer({ publicUrl });
    } catch (err) {
      error = err;
    }
    expect(isBriarError(error) && error.code).toBe("python.invalid_options");
  });
});
