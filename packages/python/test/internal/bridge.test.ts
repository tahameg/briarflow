import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeError, definePack, defineNode, isBriarError, noopLogger, t } from "@briarflow/core";
import type { ExecContext, LogData, MediaRef, MediaStore, NodeDescriptor, NodeInstance, PutMediaInfo, StoredMedia } from "@briarflow/core";
import { pythonPack, spawnPythonWorker } from "../../src/index.js";
import type { PythonNodePack, PythonWorker } from "../../src/index.js";
import { PackRuntime, fetchManifest } from "../../src/bridge.js";
import type { Connection, PythonManifest } from "../../src/bridge.js";

const PYTHON_DIR = fileURLToPath(new URL("../../../../python/", import.meta.url));
const PYTHON = `${PYTHON_DIR}.venv/bin/python`;
const EXAMPLE = `${PYTHON_DIR}examples/imaging_nodes.py`;
const hasVenv = existsSync(PYTHON);
const TOKEN = "test-token-123";

/** True once core's defineNode/definePack are implemented (they are phase-1 stubs at first). */
const coreReady = (() => {
  try {
    const def = defineNode({ type: "probe.n", outputs: { x: t.int() }, run: () => ({ x: 1 }) });
    definePack({ name: "probe", version: "0.0.0", nodes: [def] });
    return true;
  } catch (err) {
    return !(isBriarError(err) && err.code === "not_implemented");
  }
})();

// ------------------------------------------------------------------ test doubles

class MemoryMediaStore implements MediaStore {
  readonly kind = "memory";
  readonly items = new Map<string, { ref: MediaRef; data: Uint8Array }>();
  #n = 0;
  constructor(readonly urlResolver?: (ref: MediaRef, data: Uint8Array) => string) {
    if (urlResolver) {
      this.resolveUrl = async (ref) => {
        const item = this.items.get(ref.uri);
        return item ? urlResolver(ref, item.data) : undefined;
      };
    }
  }
  resolveUrl?: (ref: MediaRef) => Promise<string | undefined>;

  async put(data: Uint8Array | ReadableStream<Uint8Array>, info: PutMediaInfo): Promise<MediaRef> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
    const uri = `briar-media://m_${++this.#n}`;
    const meta = { ...info.meta, ...(info.filename !== undefined ? { filename: info.filename } : {}) };
    const ref: MediaRef = {
      uri,
      mime: info.mime,
      bytes: bytes.byteLength,
      hash: createHash("sha256").update(bytes).digest("hex"),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
    this.items.set(uri, { ref, data: bytes });
    return ref;
  }

  async get(ref: MediaRef | string): Promise<StoredMedia | undefined> {
    const uri = typeof ref === "string" ? (ref.startsWith("briar-media://") ? ref : `briar-media://${ref}`) : ref.uri;
    const item = this.items.get(uri);
    if (!item) return undefined;
    return { ref: item.ref, body: new Blob([item.data as Uint8Array<ArrayBuffer>]).stream() };
  }

  async delete(ref: MediaRef | string): Promise<boolean> {
    return this.items.delete(typeof ref === "string" ? ref : ref.uri);
  }
}

interface FakeCtx {
  ctx: ExecContext;
  controller: AbortController;
  progress: [number, string | undefined][];
  logs: [string, string, LogData | undefined][];
}

function fakeCtx(media: MediaStore, secrets: Record<string, string> = {}): FakeCtx {
  const controller = new AbortController();
  const progress: FakeCtx["progress"] = [];
  const logs: FakeCtx["logs"] = [];
  const logAt = (level: string) => (message: string, data?: LogData) => void logs.push([level, message, data]);
  const ctx: ExecContext = {
    signal: controller.signal,
    runId: "run_1",
    resolveType: () => undefined,
    flowId: "flow_1",
    nodeId: "n_1",
    attempt: 1,
    progress: (fraction, message) => void progress.push([fraction, message]),
    log: { ...noopLogger, debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") },
    media,
    secrets: {
      get: async (name) => {
        const value = secrets[name];
        if (value === undefined) throw new NodeError("node.missing_secret", `Secret ${name} is not configured.`);
        return value;
      },
    },
    globals: { get: () => undefined },
    variables: { get: () => undefined },
    fetch: globalThis.fetch,
  };
  return { ctx, controller, progress, logs };
}

const NODE: NodeInstance = { id: "n_1", type: "imaging.x", position: { x: 0, y: 0 } } as unknown as NodeInstance;

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

async function caught(promise: Promise<unknown>): Promise<NodeError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NodeError) return err;
    throw err;
  }
  throw new Error("expected the promise to reject");
}

// ------------------------------------------------------------------ suites

describe.skipIf(!hasVenv)("python bridge against the example worker", () => {
  let worker: PythonWorker;
  let manifest: PythonManifest;
  let runtime: PackRuntime;

  beforeAll(async () => {
    worker = await spawnPythonWorker({ command: PYTHON, args: [EXAMPLE], cwd: PYTHON_DIR, token: TOKEN });
    manifest = await fetchManifest(worker.url, { token: TOKEN });
    runtime = new PackRuntime({ token: TOKEN, fetch: globalThis.fetch, acquire: async () => ({ url: worker.url }) }, manifest, undefined);
  }, 30_000);

  afterAll(async () => {
    await runtime?.close();
    await worker?.stop();
  });

  function desc(type: string): NodeDescriptor {
    const found = manifest.nodes.find((n) => n.type === type);
    if (!found) throw new Error(`no node ${type}`);
    return found;
  }

  function exec(type: string, inputs: Record<string, unknown>, c: FakeCtx): Promise<Record<string, unknown>> {
    return runtime.execute(desc(type), { inputs, config: {}, node: NODE, ctx: c.ctx });
  }

  it("spawns the worker and reads the manifest", () => {
    expect(worker.status).toBe("ready");
    expect(worker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(manifest.protocol).toBe(1);
    expect(manifest.pack).toMatchObject({ name: "imaging", version: "0.1.0" });
    expect(manifest.nodes.map((n) => n.type)).toEqual([
      "imaging.uppercase",
      "imaging.solidImage",
      "imaging.imageInfo",
      "imaging.repeat",
      "imaging.countSlowly",
      "imaging.sign",
    ]);
    expect(manifest.types.map((d) => d.id)).toEqual(["imaging.Swatch", "imaging.Color"]);
  });

  it("runs a plain node", async () => {
    const c = fakeCtx(new MemoryMediaStore());
    expect(await exec("imaging.uppercase", { text: "briar" }, c)).toEqual({ result: "BRIAR" });
  });

  it("forwards progress and logs and stores $media outputs", async () => {
    const media = new MemoryMediaStore();
    const c = fakeCtx(media);
    const out = await exec("imaging.solidImage", { swatch: { color: "briar", width: 3, height: 2 } }, c);
    expect(c.progress).toEqual([
      [0.1, "encoding"],
      [1, "done"],
    ]);
    expect(c.logs).toHaveLength(1);
    expect(c.logs[0]?.[0]).toBe("info");
    expect(c.logs[0]?.[1]).toBe("encoded png");
    expect(c.logs[0]?.[2]).toMatchObject({ bytes: expect.any(Number) });
    const ref = out.result as MediaRef;
    expect(ref.uri).toMatch(/^briar-media:\/\//);
    expect(ref).toMatchObject({ mime: "image/png", meta: { width: 3, height: 2, filename: "briar.png" } });
    const stored = media.items.get(ref.uri);
    expect(stored && [...stored.data.slice(0, 8)]).toEqual([...pngBytes().slice(0, 8)]);
  });

  it("serves input media through the loopback media server and passes refs through", async () => {
    const media = new MemoryMediaStore();
    const ref = await media.put(pngBytes(), { mime: "image/png" });
    const c = fakeCtx(media);
    const out = await exec("imaging.imageInfo", { image: ref }, c);
    expect(out).toEqual({ image: ref, mime: "image/png", bytes: 12, is_png: true });
  });

  it("uses MediaStore.resolveUrl when the store provides one", async () => {
    const media = new MemoryMediaStore((ref, data) => `data:${ref.mime};base64,${Buffer.from(data).toString("base64")}`);
    const ref = await media.put(pngBytes(), { mime: "image/png" });
    const out = await exec("imaging.imageInfo", { image: ref }, fakeCtx(media));
    expect(out.is_png).toBe(true);
  });

  it("maps a worker error line to NodeError", async () => {
    const err = await caught(exec("imaging.repeat", { text: "x", times: 0, separator: " " }, fakeCtx(new MemoryMediaStore())));
    expect(err.code).toBe("imaging.nothing_to_repeat");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("nothing to output");
  });

  it("maps a 422 input rejection to node.invalid_input", async () => {
    const err = await caught(exec("imaging.repeat", { text: "x", times: 5000, separator: " " }, fakeCtx(new MemoryMediaStore())));
    expect(err.code).toBe("node.invalid_input");
    expect(err.details).toEqual({ path: "inputs.times" });
  });

  it("sends only declared secrets", async () => {
    const c = fakeCtx(new MemoryMediaStore(), { IMAGING_KEY: "k", OTHER: "nope" });
    const out = await exec("imaging.sign", { text: "hi" }, c);
    expect(out.result).toBe(createHash("sha256").update("khi").digest("hex"));
    const missing = await caught(exec("imaging.sign", { text: "hi" }, fakeCtx(new MemoryMediaStore())));
    expect(missing.code).toBe("node.missing_secret");
  });

  it("cancels the HTTP request on ctx.signal and the worker stops the node", async () => {
    const c = fakeCtx(new MemoryMediaStore());
    const started = Date.now();
    const pending = exec("imaging.countSlowly", { steps: 1000, delay_ms: 20 }, c);
    while (c.progress.length < 2) await new Promise((r) => setTimeout(r, 10));
    c.controller.abort();
    const err = await caught(pending);
    expect(err.code).toBe("node.cancelled");
    expect(Date.now() - started).toBeLessThan(5_000);
    // the worker is still usable afterwards
    expect(await exec("imaging.uppercase", { text: "ok" }, fakeCtx(new MemoryMediaStore()))).toEqual({ result: "OK" });
  });

  it("a signal aborted before the call never reaches the worker", async () => {
    const c = fakeCtx(new MemoryMediaStore());
    c.controller.abort();
    expect((await caught(exec("imaging.uppercase", { text: "x" }, c))).code).toBe("node.cancelled");
  });

  it("reports a wrong token as python.protocol_error naming the worker code", async () => {
    await expect(fetchManifest(worker.url, { token: "wrong" })).rejects.toMatchObject({
      code: "python.protocol_error",
      details: { status: 401, workerCode: "protocol.unauthorized" },
    });
  });

  describe.skipIf(!coreReady)("as a core NodePack (needs core defineNode/definePack)", () => {
    let pack: PythonNodePack;

    beforeAll(async () => {
      pack = await pythonPack({ url: worker.url, token: TOKEN });
    });
    afterAll(async () => {
      await pack?.close();
    });

    it("converts the manifest into a NodePack", () => {
      expect(pack.kind).toBe("nodePack");
      expect(pack.name).toBe("imaging");
      expect(pack.version).toBe("0.1.0");
      expect(pack.types.map((d) => d.id)).toEqual(["imaging.Swatch", "imaging.Color"]);
      const sign = pack.nodes.find((n) => n.type === "imaging.sign");
      expect(sign?.secrets).toEqual(["IMAGING_KEY"]);
      const repeat = pack.nodes.find((n) => n.type === "imaging.repeat");
      expect(repeat?.cache).toBe(false);
    });

    it("runs nodes through definition.run", async () => {
      const def = pack.nodes.find((n) => n.type === "imaging.uppercase");
      const out = await def?.run({ inputs: { text: "abc" }, config: {}, node: NODE, ctx: fakeCtx(new MemoryMediaStore()).ctx });
      expect(out).toEqual({ result: "ABC" });
    });

    it("worker.pack() follows a restart", async () => {
      const own = await spawnPythonWorker({ command: PYTHON, args: [EXAMPLE], cwd: PYTHON_DIR });
      try {
        const p = await own.pack();
        const def = p.nodes.find((n) => n.type === "imaging.uppercase");
        await own.restart();
        expect(own.status).toBe("ready");
        const out = await def?.run({ inputs: { text: "re" }, config: {}, node: NODE, ctx: fakeCtx(new MemoryMediaStore()).ctx });
        expect(out).toEqual({ result: "RE" });
        await own.stop();
        const err = await caught(
          Promise.resolve(def?.run({ inputs: { text: "x" }, config: {}, node: NODE, ctx: fakeCtx(new MemoryMediaStore()).ctx })),
        );
        expect(err.code).toBe("python.worker_exited");
        expect(err.retryable).toBe(false);
      } finally {
        await own.stop();
      }
    }, 30_000);
  });
});

const CRASHY = [
  "import os, sys, threading",
  "sys.path.insert(0, os.environ['EXAMPLES'])",
  "import imaging_nodes",
  "from briarflow import serve",
  "marker = os.environ.get('CRASH_MARKER')",
  "if os.environ.get('CRASH_ALWAYS') or (marker and not os.path.exists(marker)):",
  "    if marker: open(marker, 'w').close()",
  "    threading.Timer(float(os.environ['CRASH_AFTER']), lambda: os._exit(1)).start()",
  "serve(imaging_nodes.imaging)",
].join("\n");

interface WorkerInternals {
  connection(): Connection;
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!hasVenv)("spawnPythonWorker lifecycle", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "briar-py-"));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("restarts after a crash; in-flight executions fail with retryable python.worker_exited", async () => {
    const worker = await spawnPythonWorker({
      command: PYTHON,
      args: ["-c", CRASHY],
      cwd: PYTHON_DIR,
      env: { EXAMPLES: `${PYTHON_DIR}examples`, CRASH_MARKER: join(tmp, "crashed"), CRASH_AFTER: "0.8" },
      restartDelayMs: 50,
    });
    try {
      const connection = (worker as unknown as WorkerInternals).connection();
      const manifest = await fetchManifest(worker.url, { token: connection.token });
      const runtime = new PackRuntime(connection, manifest, undefined);
      const count = manifest.nodes.find((n) => n.type === "imaging.countSlowly")!;
      const upper = manifest.nodes.find((n) => n.type === "imaging.uppercase")!;

      const err = await caught(
        runtime.execute(count, { inputs: { steps: 1000, delay_ms: 20 }, config: {}, node: NODE, ctx: fakeCtx(new MemoryMediaStore()).ctx }),
      );
      expect(err.code).toBe("python.worker_exited");
      expect(err.retryable).toBe(true);

      // executions issued while restarting wait for the new process
      const out = await runtime.execute(upper, { inputs: { text: "back" }, config: {}, node: NODE, ctx: fakeCtx(new MemoryMediaStore()).ctx });
      expect(out).toEqual({ result: "BACK" });
      expect(worker.status).toBe("ready");
      expect(worker.url).not.toBe("");
      await runtime.close();
    } finally {
      await worker.stop();
    }
    expect(worker.status).toBe("stopped");
    await worker.stop(); // idempotent
  }, 30_000);

  it("gives up after maxRestarts; executions then fail with non-retryable python.worker_exited", async () => {
    const worker = await spawnPythonWorker({
      command: PYTHON,
      args: ["-c", CRASHY],
      cwd: PYTHON_DIR,
      env: { EXAMPLES: `${PYTHON_DIR}examples`, CRASH_ALWAYS: "1", CRASH_AFTER: "0.2" },
      restartDelayMs: 10,
      maxRestarts: 1,
    });
    try {
      await waitFor(() => worker.status === "failed");
      const connection = (worker as unknown as WorkerInternals).connection();
      const err = await connection.acquire(new AbortController().signal).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "python.worker_exited", retryable: false });
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("restart() replaces the process and stop() ends it", async () => {
    const worker = await spawnPythonWorker({ command: PYTHON, args: [EXAMPLE], cwd: PYTHON_DIR, token: false });
    try {
      await worker.restart();
      expect(worker.status).toBe("ready");
      const health = await fetch(`${worker.url}/briarflow/health`);
      expect(await health.json()).toMatchObject({ ok: true, protocol: 1, pack: { name: "imaging" } });
    } finally {
      await worker.stop();
    }
    expect(worker.status).toBe("stopped");
  }, 30_000);

  it("rejects with python.worker_not_ready when the process exits early", async () => {
    const err = await spawnPythonWorker({
      command: PYTHON,
      args: ["-c", "import sys; sys.stderr.write('boom happened\\n'); sys.exit(3)"],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "python.worker_not_ready" });
    expect((err as Error).message).toContain("boom happened");
  });

  it("rejects with python.worker_not_ready after readyTimeoutMs", async () => {
    const started = Date.now();
    await expect(
      spawnPythonWorker({ command: PYTHON, args: ["-c", "import time; time.sleep(30)"], readyTimeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "python.worker_not_ready" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("pythonPack without a worker", () => {
  it("reports python.unreachable", async () => {
    await expect(pythonPack({ url: "http://127.0.0.1:1", manifestTimeoutMs: 2_000 })).rejects.toMatchObject({
      code: "python.unreachable",
    });
  });

  it("rejects other protocol versions", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ protocol: 2, pack: { name: "x", version: "1.0.0" }, types: [], nodes: [] }))) as typeof fetch;
    await expect(pythonPack({ url: "http://worker", fetch: fakeFetch })).rejects.toMatchObject({
      code: "python.unsupported_protocol",
    });
  });

  it("rejects a malformed manifest with pack.invalid", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ protocol: 1, pack: { name: "x" }, nodes: {} }))) as typeof fetch;
    await expect(pythonPack({ url: "http://worker", fetch: fakeFetch })).rejects.toMatchObject({ code: "pack.invalid" });
  });
});

describe("NDJSON stream handling (fake worker)", () => {
  const manifest: PythonManifest = {
    protocol: 1,
    pack: { name: "fake", version: "1.0.0" },
    types: [
      { kind: "struct", id: "fake.Pic", name: "Pic", fields: [{ name: "img", type: { kind: "primitive", name: "image" } }] },
    ],
    nodes: [
      {
        type: "fake.node",
        pack: { name: "fake", version: "1.0.0" },
        title: "Node",
        description: "",
        category: "Fake",
        icon: null,
        color: null,
        inputs: [{ name: "pics", type: { kind: "list", of: { kind: "named", id: "fake.Pic" } }, title: "Pics" }],
        outputs: [{ name: "result", type: { kind: "optional", of: { kind: "primitive", name: "image" } }, title: "Result" }],
        config: [],
        dynamicPorts: false,
        secrets: [],
        cache: true,
        timeoutMs: 1000,
        retry: { maxAttempts: 1 },
        concurrency: null,
        deprecated: null,
      },
    ],
  };

  function fakeWorker(chunks: string[], status = 200): { runtime: PackRuntime; requests: unknown[] } {
    const requests: unknown[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { status });
    }) as typeof fetch;
    const runtime = new PackRuntime({ fetch: fakeFetch, acquire: async () => ({ url: "http://fake/" }) }, manifest, undefined);
    return { runtime, requests };
  }

  const run = (runtime: PackRuntime, c: FakeCtx, inputs: Record<string, unknown> = { pics: [] }) =>
    runtime.execute(manifest.nodes[0]!, { inputs, config: {}, node: NODE, ctx: c.ctx });

  it("reassembles lines split across chunks and ignores unknown line types", async () => {
    const { runtime } = fakeWorker(['{"type":"progr', 'ess","fraction":0.5}\n{"type":"future"}\n{"type":"result","outp', 'uts":{"result":null}}\n']);
    const c = fakeCtx(new MemoryMediaStore());
    expect(await run(runtime, c)).toEqual({ result: null });
    expect(c.progress).toEqual([[0.5, undefined]]);
  });

  it("adds urls to nested input media and converts $media outputs", async () => {
    const media = new MemoryMediaStore((ref) => `https://cdn.example/${ref.uri.slice(-3)}`);
    const ref = await media.put(pngBytes(), { mime: "image/png" });
    const b64 = Buffer.from("hello").toString("base64");
    const { runtime, requests } = fakeWorker([
      `{"type":"result","outputs":{"result":{"$media":{"mime":"text/plain","base64":"${b64}","filename":"h.txt"}}}}\n`,
    ]);
    const out = await run(runtime, fakeCtx(media), { pics: [{ img: ref }] });
    expect((requests[0] as { inputs: unknown }).inputs).toEqual({ pics: [{ img: { ...ref, url: "https://cdn.example/m_1" } }] });
    const stored = media.items.get((out.result as MediaRef).uri);
    expect(new TextDecoder().decode(stored?.data)).toBe("hello");
    expect(stored?.ref.meta).toEqual({ filename: "h.txt" });
  });

  it("maps node.cancelled from the worker to a NodeError", async () => {
    const { runtime } = fakeWorker(['{"type":"error","code":"node.cancelled","message":"stopped","retryable":false,"details":{}}\n']);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "node.cancelled", message: "stopped", retryable: false });
  });

  it("keeps retryable and details of error lines", async () => {
    const { runtime } = fakeWorker(['{"type":"error","code":"node.rate_limited","message":"slow down","retryable":true,"details":{"ms":5}}\n']);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "node.rate_limited", retryable: true, details: { ms: 5 } });
  });

  it("fails with python.protocol_error on a stream without a terminal line", async () => {
    const { runtime } = fakeWorker(['{"type":"progress","fraction":0.1}\n']);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err.code).toBe("python.protocol_error");
    expect(err.message).toContain("Worker closed the stream without a result.");
  });

  it("fails with python.protocol_error on a malformed line", async () => {
    const { runtime } = fakeWorker(["not json\n"]);
    expect((await caught(run(runtime, fakeCtx(new MemoryMediaStore())))).code).toBe("python.protocol_error");
  });

  it("maps pre-stream HTTP errors other than 422 to python.protocol_error", async () => {
    const { runtime } = fakeWorker(['{"error":{"code":"protocol.unknown_node","message":"no such node"}}'], 404);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "python.protocol_error", retryable: false, details: { status: 404, workerCode: "protocol.unknown_node" } });
    expect(err.message).toContain("protocol.unknown_node");
  });

  it.each([502, 503, 504])("maps a gateway HTTP %i on execute to retryable python.unreachable", async (status) => {
    const { runtime } = fakeWorker(['{"error":{"code":"proxy.down","message":"bad gateway"}}'], status);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "python.unreachable", retryable: true, details: { status, workerCode: "proxy.down" } });
  });

  it("maps a gateway error without a JSON body to python.unreachable", async () => {
    const { runtime } = fakeWorker(["<html>Service Unavailable</html>"], 503);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "python.unreachable", retryable: true, details: { status: 503 } });
  });

  it.each([500, 501, 505])("keeps other 5xx (%i) as non-retryable python.protocol_error", async (status) => {
    const { runtime } = fakeWorker(['{"error":{"code":"internal","message":"oops"}}'], status);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "python.protocol_error", retryable: false, details: { status, workerCode: "internal" } });
  });

  it("rejects malformed $media values", async () => {
    const { runtime } = fakeWorker(['{"type":"result","outputs":{"result":{"$media":{"mime":"image/png"}}}}\n']);
    const err = await caught(run(runtime, fakeCtx(new MemoryMediaStore())));
    expect(err).toMatchObject({ code: "python.protocol_error", details: { path: "outputs.result" } });
  });
});
