/**
 * node-api.md §10, phase-3.md §4.10: the deterministic offline mock pack.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, isBriarError, noopLogger, sha256Hex, type ExecContext, type MediaRef, type MediaStore } from "@briarflow/core";
import {
  mockDelay,
  mockFail,
  mockFlaky,
  mockHash,
  mockImage,
  mockLlm,
  mockModel3d,
  mockPack,
  mockStructured,
  PACKAGE_NAME,
} from "@briarflow/nodes-mock";
import { context, describeNodePack, enumType, field, flow, ir, memoryMediaStore, readStream, runNode, struct } from "@briarflow/testing";

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string; retryable?: boolean }> {
  try {
    await p;
  } catch (error) {
    expect(isBriarError(error), String(error)).toBe(true);
    return error as { code: string; message: string };
  }
  throw new Error("expected a rejection");
}

async function text(media: MediaStore, ref: MediaRef): Promise<string> {
  const got = await media.get(ref);
  expect(got).toBeDefined();
  return new TextDecoder().decode(await readStream(got!.body));
}

const structCtx = () =>
  context({
    types: [
      enumType("ty_mood", "Mood", ["calm", "angry", "sad"]),
      struct("ty_inner", "Inner", [field("flag", ir.boolean())]),
      struct("ty_all", "All", [
        field("title", ir.text()),
        field("short", ir.text({ maxLength: 3 })),
        field("long", ir.text({ minLength: 30 })),
        field("count", ir.int()),
        field("ranged", ir.int({ min: 10, max: 12 })),
        field("ratio", ir.float({ min: 0, max: 1 })),
        field("ok", ir.boolean()),
        field("mood", ir.named("ty_mood")),
        field("tags", ir.list(ir.text())),
        field("three", ir.list(ir.int(), { minItems: 3 })),
        field("maybe", ir.optional(ir.text())),
        field("inner", ir.named("ty_inner")),
        field("image", ir.image()),
        field("doc", ir.file()),
        field("model", ir.model3d()),
        field("sound", ir.audio()),
        field("clip", ir.optional(ir.video())),
        field("clips", ir.list(ir.optional(ir.video()), { minItems: 1 })),
      ]),
      struct("ty_video", "WithVideo", [field("clip", ir.video())]),
      struct("ty_simple", "Simple", [field("name", ir.text())]),
    ],
  });

describe("mockPack", () => {
  it("is pack mock 0.1.0 with the seven §10 nodes", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/nodes-mock");
    expect(mockPack).toMatchObject({ kind: "nodePack", name: "mock", version: "0.1.0", namespaces: ["mock"] });
    expect(mockPack.nodes.map((d) => d.type).sort()).toEqual(
      ["mock.delay", "mock.fail", "mock.flaky", "mock.image", "mock.llm", "mock.model3d", "mock.structured"].sort(),
    );
    for (const d of mockPack.nodes) expect(d.secrets).toEqual([]);
  });

  it("delay and flaky are cache: false; flaky has retry 3", () => {
    expect(mockDelay.cache).toBe(false);
    expect(mockFlaky.cache).toBe(false);
    expect(mockFlaky.retry.maxAttempts).toBe(4);
  });
});

describeNodePack(mockPack, {
  requireSamples: true,
  context: structCtx(),
  samples: {
    "mock.llm": [{ inputs: { prompt: "hi" } }],
    "mock.structured": [{ config: { typeId: "ty_simple" }, inputs: { prompt: "p" } }],
    "mock.image": [{ inputs: { prompt: "a cat", width: 8, height: 8 } }],
    "mock.model3d": [{ inputs: { prompt: "cube" } }],
    "mock.delay": [{ inputs: { value: "v", ms: 0 }, outputs: { value: "v" } }],
    "mock.flaky": [{ inputs: { failures: 1 }, errorCode: "node.unavailable" }, { inputs: { failures: 1 }, attempt: 2, outputs: { value: "ok" } }],
    "mock.fail": [{ errorCode: "mock.failed" }],
  },
});

describe("mockHash", () => {
  it("is sha-256 hex of the canonical JSON", async () => {
    const value = { prompt: "a cat", seed: 0, system: null };
    expect(await mockHash(value)).toBe(await sha256Hex(canonicalJson(value)));
    expect(await mockHash({ b: 1, a: 2 })).toBe(await mockHash({ a: 2, b: 1 }));
    expect(await mockHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mock.llm", () => {
  it('replies "Mock reply " + hash({system,prompt,seed}).slice(0,8) + ": " + first 200 chars', async () => {
    const prompt = "p".repeat(150) + "é".repeat(100);
    const r = await runNode(mockLlm, { prompt, system: "be brief", seed: 3 });
    const hash = await mockHash({ system: "be brief", prompt, seed: 3 });
    expect(r.outputs).toEqual({ text: `Mock reply ${hash.slice(0, 8)}: ${Array.from(prompt).slice(0, 200).join("")}` });
  });

  it("defaults system to null and seed to 0; is deterministic; different seeds differ", async () => {
    const a = await runNode(mockLlm, { prompt: "hello" });
    const b = await runNode(mockLlm, { prompt: "hello" });
    const c = await runNode(mockLlm, { prompt: "hello", seed: 1 });
    const hash = await mockHash({ system: null, prompt: "hello", seed: 0 });
    expect(a.outputs.text).toBe(`Mock reply ${hash.slice(0, 8)}: hello`);
    expect(b.outputs).toEqual(a.outputs);
    expect(c.outputs).not.toEqual(a.outputs);
  });

  it("reports progress 0.5 then 1", async () => {
    const r = await runNode(mockLlm, { prompt: "x", delayMs: 4 });
    expect(r.progress.map((p) => p.fraction)).toEqual([0.5, 1]);
  });

  it("respects ctx.signal", async () => {
    const controller = new AbortController();
    const pending = runNode(mockLlm, { prompt: "x", delayMs: 10_000 }, { signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    const already = new AbortController();
    already.abort(new Error("early"));
    await expect(runNode(mockLlm, { prompt: "x" }, { signal: already.signal })).rejects.toThrow("early");
  });

  it("validates delayMs >= 0", async () => {
    expect((await rejects(runNode(mockLlm, { prompt: "x", delayMs: -1 }))).code).toBe("node.invalid_input");
  });
});

describe("mock.image", () => {
  it("stores a deterministic SVG via ctx.media with meta.width/height", async () => {
    const media = memoryMediaStore();
    const r = await runNode(mockImage, { prompt: "A <cat> & dog", width: 100, height: 50, seed: 2 }, { media });
    const ref = r.outputs.image;
    expect(ref).toMatchObject({ mime: "image/svg+xml", meta: { width: 100, height: 50 } });
    const svg = await text(media, ref);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="100"');
    expect(svg).toContain('height="50"');
    expect(svg).toContain("A &lt;cat&gt; &amp; dog");
    expect((svg.match(/<rect /g) ?? []).length).toBe(4); // background + 3 rectangles
    const hex = await mockHash({ prompt: "A <cat> & dog", seed: 2 });
    expect(svg).toContain(`fill="#${hex.slice(0, 6)}"`);
    const again = await runNode(mockImage, { prompt: "A <cat> & dog", width: 100, height: 50, seed: 2 }, { media });
    expect(again.outputs.image.hash).toBe(ref.hash);
    expect(await text(media, again.outputs.image)).toBe(svg);
  });

  it("writes only the first 60 characters of the prompt; defaults 512×512", async () => {
    const media = memoryMediaStore();
    const prompt = "x".repeat(59) + "YZ";
    const r = await runNode(mockImage, { prompt }, { media });
    expect(r.outputs.image.meta).toMatchObject({ width: 512, height: 512 });
    const svg = await text(media, r.outputs.image);
    expect(svg).toContain("x".repeat(59) + "Y<");
    expect(svg).not.toContain("YZ");
  });

  it("different prompts or seeds give different images", async () => {
    const a = await runNode(mockImage, { prompt: "a", width: 8, height: 8 });
    const b = await runNode(mockImage, { prompt: "a", width: 8, height: 8, seed: 1 });
    const c = await runNode(mockImage, { prompt: "b", width: 8, height: 8 });
    expect(new Set([a.outputs.image.hash, b.outputs.image.hash, c.outputs.image.hash]).size).toBe(3);
  });

  it("validates width/height 1–4096", async () => {
    for (const width of [0, 4097]) expect((await rejects(runNode(mockImage, { prompt: "x", width }))).code).toBe("node.invalid_input");
  });
});

describe("mock.model3d", () => {
  it("stores a minimal glTF 2.0 cube colored from the hash", async () => {
    const media = memoryMediaStore();
    const r = await runNode(mockModel3d, { prompt: "box", seed: 1 }, { media });
    expect(r.outputs.model.mime).toBe("model/gltf+json");
    const gltf = JSON.parse(await text(media, r.outputs.model)) as {
      asset: { version: string };
      meshes: unknown[];
      materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    };
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.meshes).toHaveLength(1);
    const color = gltf.materials[0]!.pbrMetallicRoughness.baseColorFactor;
    expect(color).toHaveLength(4);
    for (const c of color) expect(c >= 0 && c <= 1).toBe(true);
    const again = await runNode(mockModel3d, { prompt: "box", seed: 1 });
    expect(again.outputs.model.hash).toBe(r.outputs.model.hash);
    const other = await runNode(mockModel3d, { prompt: "box", seed: 2 });
    expect(other.outputs.model.hash).not.toBe(r.outputs.model.hash);
  });
});

describe("mock.delay", () => {
  it("passes the value through after ms and reports progress up to 1", async () => {
    const r = await runNode(mockDelay, { value: { any: "thing" }, ms: 250 });
    expect(r.outputs).toEqual({ value: { any: "thing" } });
    expect(r.progress.map((p) => p.fraction)).toEqual([0.4, 0.8, 1]);
    expect(r.progress.at(-1)?.message).toBe("250 / 250 ms");
  });

  it("ms defaults to 1000; honours cancellation", async () => {
    expect(mockDelay.inputs.ms).toMatchObject({ default: 1000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = runNode(mockDelay, { value: 1, ms: 60_000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled")), 5);
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("mock.flaky", () => {
  it("fails attempts 1…failures with retryable node.unavailable, then succeeds", async () => {
    for (const attempt of [1, 2]) {
      const err = await rejects(runNode(mockFlaky, { failures: 2, value: "yay" }, { attempt }));
      expect(err.code).toBe("node.unavailable");
      expect(err.retryable).toBe(true);
      expect(err.message).toBe(`Mock outage on attempt ${attempt}: this node fails its first 2 attempts.`);
    }
    expect((await runNode(mockFlaky, { failures: 2, value: "yay" }, { attempt: 3 })).outputs).toEqual({ value: "yay" });
    expect((await runNode(mockFlaky, { failures: 0 })).outputs).toEqual({ value: "ok" });
  });
});

describe("mock.fail", () => {
  it("always throws mock.failed with the message", async () => {
    const err = await rejects(runNode(mockFail, {}));
    expect(err).toMatchObject({ code: "mock.failed", message: "Mock failure", retryable: false });
    expect((await rejects(runNode(mockFail, { message: "custom" }))).message).toBe("custom");
  });
});

describe("mock.structured", () => {
  it("fills every field kind deterministically and the result validates against the struct", async () => {
    const media = memoryMediaStore();
    const opts = { config: { typeId: "ty_all" }, context: structCtx(), media };
    const r = await runNode(mockStructured, { prompt: "hero", seed: 1 }, opts);
    const v = r.outputs.value as Record<string, unknown>;
    expect(v["title"]).toMatch(/^title [0-9a-f]{4}$/);
    expect(Array.from(v["short"] as string).length).toBeLessThanOrEqual(3);
    expect(Array.from(v["long"] as string).length).toBeGreaterThanOrEqual(30);
    expect(Number.isInteger(v["count"]) && (v["count"] as number) >= 0 && (v["count"] as number) <= 99).toBe(true);
    expect([10, 11, 12]).toContain(v["ranged"]);
    expect((v["ratio"] as number) >= 0 && (v["ratio"] as number) <= 1).toBe(true);
    expect(typeof v["ok"]).toBe("boolean");
    expect(["calm", "angry", "sad"]).toContain(v["mood"]);
    expect(v["tags"]).toHaveLength(2);
    expect(v["three"]).toHaveLength(3);
    expect(typeof v["maybe"]).toBe("string");
    expect(typeof (v["inner"] as { flag: unknown }).flag).toBe("boolean");
    expect(v["image"]).toMatchObject({ mime: "image/svg+xml" });
    expect(v["doc"]).toMatchObject({ mime: "image/svg+xml" });
    expect(v["model"]).toMatchObject({ mime: "model/gltf+json" });
    expect(v["sound"]).toMatchObject({ mime: "audio/wav" });
    expect(v["clip"]).toBeNull();
    expect(v["clips"]).toEqual([null]);
    for (const key of ["image", "doc", "model", "sound"]) expect(await media.get(v[key] as MediaRef)).toBeDefined();
    const again = await runNode(mockStructured, { prompt: "hero", seed: 1 }, { ...opts, media: memoryMediaStore() });
    const strip = (x: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(x).map(([k, val]) => [k, val && typeof val === "object" && "uri" in val ? (val as MediaRef).hash : val]));
    expect(strip(again.outputs.value as Record<string, unknown>)).toEqual(strip(v));
    const other = await runNode(mockStructured, { prompt: "hero", seed: 2 }, { ...opts, media: memoryMediaStore() });
    expect(strip(other.outputs.value as Record<string, unknown>)).not.toEqual(strip(v));
  });

  it("a required video field → mock.unsupported_type with the spec message", async () => {
    const err = await rejects(runNode(mockStructured, { prompt: "x" }, { config: { typeId: "ty_video" }, context: structCtx() }));
    expect(err.code).toBe("mock.unsupported_type");
    expect(err.message).toBe("mock.structured cannot invent video values (field value.clip). Make the field optional (it will be null) or use another type.");
  });

  it("the struct port follows config.typeId; an unknown struct cannot resolve ports", async () => {
    const r = await runNode(mockStructured, { prompt: "x" }, { config: { typeId: "ty_simple" }, context: structCtx() });
    expect(r.ports.outputs[0]?.type).toEqual({ kind: "named", id: "ty_simple" });
    await expect(runNode(mockStructured, { prompt: "x" }, { config: { typeId: "ty_nope" }, context: structCtx() })).rejects.toBeDefined();
  });

  it("run with a type id the lookup does not know → mock.unknown_type", async () => {
    const ctx = fakeCtx({ resolveType: () => undefined });
    const err = await rejects(Promise.resolve().then(() => mockStructured.run({ inputs: { prompt: "x", seed: 0 }, config: { typeId: "ty_gone" }, node: { id: "n", type: "mock.structured", position: { x: 0, y: 0 } }, ctx })));
    expect(err.code).toBe("mock.unknown_type");
  });

  it("run without ctx.resolveType → mock.no_type_lookup", async () => {
    const ctx = fakeCtx({});
    delete (ctx as { resolveType?: unknown }).resolveType;
    const err = await rejects(Promise.resolve().then(() => mockStructured.run({ inputs: { prompt: "x", seed: 0 }, config: { typeId: "ty_simple" }, node: { id: "n", type: "mock.structured", position: { x: 0, y: 0 } }, ctx })));
    expect(err.code).toBe("mock.no_type_lookup");
  });

  it("works with pack types via runNode packs", async () => {
    const d = context({ flows: [flow({ id: "flow_m", name: "M", builtins: false })] });
    const r = await runNode(mockStructured, { prompt: "x" }, { config: { typeId: "ty_simple" }, context: { ...d, types: structCtx().types } });
    expect(r.outputs.value).toEqual({ name: expect.stringMatching(/^name [0-9a-f]{4}$/) });
  });
});

function fakeCtx(extra: Partial<ExecContext>): ExecContext {
  return {
    signal: new AbortController().signal,
    runId: "run_1",
    flowId: "flow_1",
    nodeId: "n_1",
    attempt: 1,
    progress() {},
    log: noopLogger,
    media: memoryMediaStore(),
    secrets: { get: async () => "", read: async () => "" },
    settings: { get: async () => undefined },
    globals: { get: () => undefined },
    variables: { get: () => undefined },
    fetch: globalThis.fetch,
    resolveType: () => undefined,
    ...extra,
  };
}
