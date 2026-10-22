import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { computeCacheKey, createMemoryCache, type RunCache } from "@briarflow/runtime";
import { collect, context, edge, field, flow, ir, node, testEngine } from "./helpers.js";
import { probe, tkPack } from "./tk-pack.js";

const packs = [stdPack, mockPack, tkPack];
beforeEach(() => probe.reset());

function cachedIds(events: RunEvent[]): string[] {
  return events.filter((e) => e.type === "node.completed" && e.cached).map((e) => (e as { nodeId: string }).nodeId);
}

describe("computeCacheKey", () => {
  it("is the sha-256 of the canonical JSON with v: 1", async () => {
    const input = { nodeType: "tk.text", pack: "tk@1.0.0", cacheVersion: "1", config: { b: 1, a: 2 }, typeBindings: {}, inputs: { value: "a" } };
    const key = await computeCacheKey(input);
    expect(key).toBe(await sha256Hex(canonicalJson({ v: 1, ...input })));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeCacheKey({ ...input, config: { a: 2, b: 1 } })).toBe(key);
    expect(await computeCacheKey({ ...input, inputs: { value: "b" } })).not.toBe(key);
  });
});

describe("createMemoryCache", () => {
  it("evicts the least recently used entry", async () => {
    const cache = createMemoryCache({ maxEntries: 2 });
    await cache.set("a", { v: 1 });
    await cache.set("b", { v: 2 });
    await cache.get("a");
    await cache.set("c", { v: 3 });
    expect(cache.size).toBe(2);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toEqual({ v: 1 });
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("engine cache", () => {
  const textFlow = (nodeId: string) =>
    context([flow({ outputs: [field("v", ir.text())], nodes: [node(nodeId, "tk.text", { title: nodeId, values: { value: "hello" } })], edges: [edge(`${nodeId}.value`, "n_out.v")] })]);

  it("hits across runs regardless of node id and title; useCache:false bypasses it", async () => {
    const { engine } = testEngine({ packs });
    await engine.run({ context: textFlow("n_a"), flowId: "flow_t" }).result;
    const run2 = engine.run({ context: textFlow("n_b"), flowId: "flow_t" });
    const events = await collect(run2.events());
    expect(cachedIds(events)).toEqual(["n_b"]);
    const started = events.filter((e) => e.type === "node.started" && e.nodeId === "n_b");
    expect(started).toHaveLength(1);
    expect(probe.runCalls).toBe(1);
    const run3 = engine.run({ context: textFlow("n_b"), flowId: "flow_t", useCache: false });
    expect(cachedIds(await collect(run3.events()))).toEqual([]);
    expect(probe.runCalls).toBe(2);
  });

  it("keys media inputs by hash, not uri", async () => {
    const { engine } = testEngine({ packs });
    const doc = context([flow({ inputs: [field("img", ir.image())], nodes: [node("n_m", "tk.media")], edges: [edge("n_in.img", "n_m.image")] })]);
    const hash = "a".repeat(64);
    await engine.run({ context: doc, flowId: "flow_t", inputs: { img: { uri: "briar-media://m_1", mime: "image/png", hash } } }).result;
    const run = engine.run({ context: doc, flowId: "flow_t", inputs: { img: { uri: "briar-media://m_2", mime: "image/png", hash } } });
    expect(cachedIds(await collect(run.events()))).toEqual(["n_m"]);
    const run3 = engine.run({ context: doc, flowId: "flow_t", inputs: { img: { uri: "briar-media://m_3", mime: "image/png" } } });
    expect(cachedIds(await collect(run3.events()))).toEqual([]);
  });

  it("treats cache errors as misses and logs a warning", async () => {
    const warnings: string[] = [];
    const broken: RunCache = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
    };
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const { engine } = testEngine({ packs, cache: broken, logger });
    const result = await engine.run({ context: textFlow("n_a"), flowId: "flow_t" }).result;
    expect(result.outputs).toEqual({ v: "hello" });
    expect(warnings).toEqual(["Cache read failed; treating it as a miss.", "Cache write failed; treating it as a miss."]);
  });

  it("never caches failures or cache:false nodes", async () => {
    const { engine } = testEngine({ packs });
    const doc = context([flow({ nodes: [node("n_w", "tk.wait", { values: { ms: 1 } })] })]);
    await engine.run({ context: doc, flowId: "flow_t" }).result;
    const run = engine.run({ context: doc, flowId: "flow_t" });
    expect(cachedIds(await collect(run.events()))).toEqual([]);
  });
});
