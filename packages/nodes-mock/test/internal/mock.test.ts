import { describe, expect, it } from "vitest";
import { noopLogger, type AnyNodeDefinition, type ExecContext, type MediaRef, type TypeDecl } from "@briarflow/core";
import { mockDelay, mockFail, mockFlaky, mockHash, mockImage, mockLlm, mockModel3d, mockPack, mockStructured } from "@briarflow/nodes-mock";

interface Harness {
  ctx: ExecContext & { resolveType?: (id: string) => TypeDecl | undefined };
  stored: { bytes: Uint8Array; mime: string; meta?: Record<string, unknown> }[];
  progress: [number, string | undefined][];
  controller: AbortController;
}

function harness(attempt = 1, types: TypeDecl[] = []): Harness {
  const stored: Harness["stored"] = [];
  const progress: Harness["progress"] = [];
  const controller = new AbortController();
  const ctx = {
    signal: controller.signal,
    runId: "run_1",
    flowId: "flow_1",
    nodeId: "n_1",
    attempt,
    progress: (f: number, m?: string) => progress.push([f, m]),
    log: noopLogger,
    media: {
      kind: "test",
      put: async (data: Uint8Array | ReadableStream<Uint8Array>, info: { mime: string; meta?: Record<string, unknown> }) => {
        stored.push({ bytes: data as Uint8Array, mime: info.mime, ...(info.meta ? { meta: info.meta } : {}) });
        const ref: MediaRef = { uri: `briar-media://m_${stored.length}`, mime: info.mime };
        if (info.meta) ref.meta = info.meta;
        return ref;
      },
      get: async () => undefined,
      delete: async () => false,
    },
    secrets: { get: async () => "" },
    globals: { get: () => undefined },
    variables: { get: () => undefined },
    fetch: globalThis.fetch,
    resolveType: (id: string) => types.find((t) => t.id === id),
  };
  return { ctx, stored, progress, controller };
}

function call(def: unknown, inputs: Record<string, unknown>, h: Harness, config: Record<string, unknown> = {}) {
  const d = def as AnyNodeDefinition;
  return d.run({ inputs: inputs as never, config: config as never, node: { id: "n_1", type: d.type, position: { x: 0, y: 0 } }, ctx: h.ctx });
}

describe("mockPack", () => {
  it("contains every §10 node", () => {
    expect(mockPack).toMatchObject({ name: "mock", version: "0.1.0" });
    expect(mockPack.nodes.map((n) => n.type)).toEqual(["mock.llm", "mock.structured", "mock.image", "mock.model3d", "mock.delay", "mock.flaky", "mock.fail"]);
    const byType = Object.fromEntries(mockPack.nodes.map((n) => [n.type, n]));
    expect(byType["mock.delay"]?.cache).toBe(false);
    expect(byType["mock.flaky"]).toMatchObject({ cache: false, retry: { maxAttempts: 4 } });
  });
});

describe("mock.llm", () => {
  it("answers with the spec formula and reports progress 0.5 then 1", async () => {
    const h = harness();
    const prompt = "p".repeat(250);
    const out = await call(mockLlm, { prompt, system: null, seed: 3, delayMs: 0 }, h);
    const hash = await mockHash({ system: null, prompt, seed: 3 });
    expect(out).toEqual({ text: `Mock reply ${hash.slice(0, 8)}: ${"p".repeat(200)}` });
    expect(h.progress.map(([f]) => f)).toEqual([0.5, 1]);
  });

  it("respects the signal while waiting", async () => {
    const h = harness();
    const p = call(mockLlm, { prompt: "x", system: null, seed: 0, delayMs: 5000 }, h);
    h.controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});

describe("mock.image and mock.model3d", () => {
  it("stores a deterministic SVG with meta width/height", async () => {
    const h = harness();
    const a = await call(mockImage, { prompt: "A <cat> & dog", width: 100, height: 50, seed: 1 }, h);
    await call(mockImage, { prompt: "A <cat> & dog", width: 100, height: 50, seed: 1 }, h);
    expect(a).toEqual({ image: { uri: "briar-media://m_1", mime: "image/svg+xml", meta: { width: 100, height: 50 } } });
    const svg = new TextDecoder().decode(h.stored[0]?.bytes);
    expect(svg).toBe(new TextDecoder().decode(h.stored[1]?.bytes));
    expect(svg).toContain("A &lt;cat&gt; &amp; dog");
    expect(svg.match(/<rect /g)).toHaveLength(4);
    const hash = await mockHash({ prompt: "A <cat> & dog", seed: 1 });
    expect(svg).toContain(`fill="#${hash.slice(0, 6)}"`);
  });

  it("stores a glTF 2.0 cube", async () => {
    const h = harness();
    const out = (await call(mockModel3d, { prompt: "cube", seed: 0 }, h)) as { model: MediaRef };
    expect(out.model.mime).toBe("model/gltf+json");
    const gltf = JSON.parse(new TextDecoder().decode(h.stored[0]?.bytes));
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.accessors[1].count).toBe(36);
    expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    expect(gltf.buffers[0].byteLength).toBe(168);
  });
});

describe("mock.structured", () => {
  const types: TypeDecl[] = [
    { kind: "enum", id: "ty_mood", name: "Mood", members: [{ value: "happy" }, { value: "sad" }] },
    {
      kind: "struct",
      id: "ty_char",
      name: "Character",
      fields: [
        { name: "name", type: { kind: "primitive", name: "text", constraints: { maxLength: 6 } } },
        { name: "age", type: { kind: "primitive", name: "int", constraints: { min: 10, max: 12 } } },
        { name: "score", type: { kind: "primitive", name: "float" } },
        { name: "alive", type: { kind: "primitive", name: "boolean" } },
        { name: "mood", type: { kind: "named", id: "ty_mood" } },
        { name: "tags", type: { kind: "list", of: { kind: "primitive", name: "text" }, minItems: 3 } },
        { name: "nick", type: { kind: "optional", of: { kind: "primitive", name: "text" } } },
        { name: "avatar", type: { kind: "primitive", name: "image" } },
      ],
    },
  ];

  it("fills the struct deterministically within constraints", async () => {
    const h = harness(1, types);
    const a = (await call(mockStructured, { prompt: "hero", seed: 0 }, h, { typeId: "ty_char" })) as { value: Record<string, unknown> };
    const b = (await call(mockStructured, { prompt: "hero", seed: 0 }, harness(1, types), { typeId: "ty_char" })) as { value: Record<string, unknown> };
    expect(a).toEqual(b);
    const v = a.value;
    expect(v["name"]).toMatch(/^name [0-9a-f]$/);
    expect(v["age"]).toBeGreaterThanOrEqual(10);
    expect(v["age"]).toBeLessThanOrEqual(12);
    expect(typeof v["score"]).toBe("number");
    expect(typeof v["alive"]).toBe("boolean");
    expect(["happy", "sad"]).toContain(v["mood"]);
    expect(v["tags"]).toHaveLength(3);
    expect(typeof v["nick"]).toBe("string");
    expect(v["avatar"]).toMatchObject({ mime: "image/svg+xml" });
    const hex = await mockHash({ prompt: "hero", seed: 0, path: "value.tags[0]" });
    expect((v["tags"] as string[])[0]).toBe(`tags ${hex.slice(0, 4)}`);
  });

  it("needs the engine's type lookup", async () => {
    const h = harness();
    delete (h.ctx as { resolveType?: unknown }).resolveType;
    await expect(call(mockStructured, { prompt: "x", seed: 0 }, h, { typeId: "ty_char" })).rejects.toMatchObject({ code: "mock.no_type_lookup" });
  });

  it("reports mock.unknown_type for a type id that does not exist", async () => {
    await expect(call(mockStructured, { prompt: "x", seed: 0 }, harness(1, types), { typeId: "ty_nope" })).rejects.toMatchObject({
      code: "mock.unknown_type",
    });
  });

  it("leaves optional video fields null (also inside lists) and rejects required video", async () => {
    const video = { kind: "primitive", name: "video" } as const;
    const withVideo: TypeDecl[] = [
      {
        kind: "struct",
        id: "ty_clip",
        name: "Clip",
        fields: [
          { name: "maybe", type: { kind: "optional", of: video } },
          { name: "many", type: { kind: "list", of: { kind: "optional", of: video } } },
        ],
      },
      { kind: "struct", id: "ty_req", name: "Req", fields: [{ name: "clip", type: video }] },
    ];
    const ok = (await call(mockStructured, { prompt: "x", seed: 0 }, harness(1, withVideo), { typeId: "ty_clip" })) as { value: unknown };
    expect(ok.value).toEqual({ maybe: null, many: [null, null] });
    await expect(call(mockStructured, { prompt: "x", seed: 0 }, harness(1, withVideo), { typeId: "ty_req" })).rejects.toMatchObject({
      code: "mock.unsupported_type",
      message: "mock.structured cannot invent video values (field value.clip). Make the field optional (it will be null) or use another type.",
    });
  });
});

describe("mock.delay, mock.flaky, mock.fail", () => {
  it("delay passes the value through, reports progress and honours cancellation", async () => {
    const h = harness();
    expect(await call(mockDelay, { value: "v", ms: 250 }, h)).toEqual({ value: "v" });
    expect(h.progress.map(([f]) => f)).toEqual([0.4, 0.8, 1]);
    const h2 = harness();
    const p = call(mockDelay, { value: "v", ms: 10_000 }, h2);
    h2.controller.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });

  it("flaky fails the first attempts with retryable node.unavailable", async () => {
    await expect(Promise.resolve().then(() => call(mockFlaky, { failures: 2, value: "ok" }, harness(2)))).rejects.toMatchObject({
      code: "node.unavailable",
      retryable: true,
      message: "Mock outage on attempt 2: this node fails its first 2 attempts.",
    });
    expect(await call(mockFlaky, { failures: 2, value: "ok" }, harness(3))).toEqual({ value: "ok" });
  });

  it("fail always throws mock.failed", async () => {
    await expect(Promise.resolve().then(() => call(mockFail, { message: "nope" }, harness()))).rejects.toMatchObject({ code: "mock.failed", message: "nope" });
  });
});
