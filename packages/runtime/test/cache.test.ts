/**
 * runtime.md §6, phase-3.md §4.5: cache keys, hits, `useCache`, `cache: false`, what is not
 * stored, cache errors, the memory LRU.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type LogData, type RunEvent } from "@briarflow/core";
import { computeCacheKey, createMemoryCache, type CacheKeyInput, type RunCache } from "@briarflow/runtime";
import { ir } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, ofNode, probe } from "./support.js";

beforeEach(() => probe.reset());

type Completed = Extract<RunEvent, { type: "node.completed" }>;

const keyInput = (): CacheKeyInput => ({
  nodeType: "mock.llm",
  pack: "mock@0.1.0",
  cacheVersion: "1",
  config: {},
  typeBindings: {},
  inputs: { prompt: "hi", seed: 0 },
});

describe("computeCacheKey", () => {
  it("is the lowercase sha-256 hex of the canonical JSON with v: 1", async () => {
    const input = keyInput();
    const expected = await sha256Hex(canonicalJson({ v: 1, ...input }));
    const key = await computeCacheKey(input);
    expect(key).toBe(expected);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", async () => {
    const a = await computeCacheKey({ ...keyInput(), inputs: { prompt: "hi", seed: 0 }, config: { a: 1, b: 2 } });
    const b = await computeCacheKey({ ...keyInput(), inputs: { seed: 0, prompt: "hi" }, config: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("changes with every field", async () => {
    const base = await computeCacheKey(keyInput());
    const variants: Partial<CacheKeyInput>[] = [
      { nodeType: "mock.image" },
      { pack: "mock@0.1.1" },
      { cacheVersion: "2" },
      { config: { x: 1 } },
      { typeBindings: { T: { kind: "primitive", name: "text" } } },
      { inputs: { prompt: "hi", seed: 1 } },
    ];
    const keys = await Promise.all(variants.map((v) => computeCacheKey({ ...keyInput(), ...v })));
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("createMemoryCache", () => {
  it("is an LRU with maxEntries; get refreshes recency; clear empties it", async () => {
    const cache = createMemoryCache({ maxEntries: 2 });
    await cache.set("a", { v: 1 });
    await cache.set("b", { v: 2 });
    expect(await cache.get("a")).toEqual({ v: 1 }); // a is now most recent
    await cache.set("c", { v: 3 });
    expect(cache.size).toBe(2);
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("a")).toEqual({ v: 1 });
    expect(await cache.get("c")).toEqual({ v: 3 });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.get("a")).toBeUndefined();
  });

  it("defaults to 500 entries", async () => {
    const cache = createMemoryCache();
    for (let i = 0; i < 501; i++) await cache.set(`k${i}`, { i });
    expect(cache.size).toBe(500);
    expect(await cache.get("k0")).toBeUndefined();
  });
});

/** A RunCache that records calls. */
function spyCache(inner: RunCache = createMemoryCache()) {
  const gets: string[] = [];
  const sets: string[] = [];
  const cache: RunCache = {
    async get(key) {
      gets.push(key);
      return inner.get(key);
    },
    async set(key, outputs) {
      sets.push(key);
      return inner.set(key, outputs);
    },
  };
  return { cache, gets, sets };
}

const countDoc = (value = "v", nodeId = "n_c", extra: object = {}) =>
  doc({
    outputs: [{ name: "out", type: ir.text() }],
    nodes: [n(nodeId, "probe.count", { values: { value }, ...extra })],
    edges: [e(`${nodeId}.value`, "n_out.out")],
  });

describe("engine cache", () => {
  it("a hit emits node.started then node.completed {cached: true} and does not call run", async () => {
    const { engine } = makeEngine();
    const first = await engine.run({ context: countDoc(), flowId: FLOW_ID }).result;
    const second = engine.run({ context: countDoc(), flowId: FLOW_ID });
    const result = await second.result;
    expect(probe.calls.get("n_c")).toBe(1);
    expect(result.outputs).toEqual(first.outputs);
    const events = ofNode(await collect(second), "n_c");
    expect(events.map((x) => x.type)).toEqual(["node.started", "node.completed"]);
    expect(events[0]).toMatchObject({ attempt: 1 });
    expect((events[1] as Completed).cached).toBe(true);
    expect((events[1] as Completed).outputs).toEqual({ value: "v#1" });
  });

  it("node id, title and position are not part of the key; inputs and config are", async () => {
    const { engine } = makeEngine();
    await engine.run({ context: countDoc("v", "n_c"), flowId: FLOW_ID }).result;
    await engine.run({ context: countDoc("v", "n_other", { title: "Renamed", position: { x: 99, y: 7 } }), flowId: FLOW_ID }).result;
    expect(probe.calls.get("n_other")).toBeUndefined();
    await engine.run({ context: countDoc("w", "n_c"), flowId: FLOW_ID }).result;
    expect(probe.calls.get("n_c")).toBe(2);
    // config differences (text.template) → different keys
    const spy = spyCache();
    const { engine: e2 } = makeEngine({ cache: spy.cache });
    const tpl = (template: string) =>
      doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_t", "text.template", { config: { template } })], edges: [e("n_t.text", "n_out.out")] });
    await e2.run({ context: tpl("A"), flowId: FLOW_ID }).result;
    await e2.run({ context: tpl("B"), flowId: FLOW_ID }).result;
    expect(new Set(spy.gets).size).toBe(2);
  });

  it("the run id is not part of the key: different runs share entries", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    await engine.run({ context: countDoc(), flowId: FLOW_ID, runId: "run_a" }).result;
    await engine.run({ context: countDoc(), flowId: FLOW_ID, runId: "run_b" }).result;
    expect(spy.gets[0]).toBe(spy.gets[1]);
  });

  it("useCache: false neither reads nor writes", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    await engine.run({ context: countDoc(), flowId: FLOW_ID, useCache: false }).result;
    await engine.run({ context: countDoc(), flowId: FLOW_ID, useCache: false }).result;
    expect(spy.gets).toEqual([]);
    expect(spy.sets).toEqual([]);
    expect(probe.calls.get("n_c")).toBe(2);
  });

  it("cache: false definitions, built-ins and variable nodes never touch the cache", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    const d = doc({
      inputs: [{ name: "t", type: ir.text() }],
      outputs: [{ name: "out", type: ir.text() }],
      variables: [{ id: "var_v", name: "v", type: ir.text(), access: "public" }],
      nodes: [
        n("n_set", "briar.variable.set", { config: { variableId: "var_v" } }),
        n("n_get", "briar.variable.get", { config: { variableId: "var_v" } }),
        n("n_ctx", "probe.ctx"),
        n("n_d", "mock.delay", { values: { ms: 0 } }),
      ],
      edges: [e("n_in.t", "n_set.value"), e("n_get.value", "n_d.value"), e("n_d.value", "n_out.out")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID, inputs: { t: "x" } });
    expect((await run.result).status).toBe("succeeded");
    expect(spy.gets).toEqual([]);
    expect(spy.sets).toEqual([]);
  });

  it("a cached node is looked up once per execution and stored once", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    await engine.run({ context: countDoc(), flowId: FLOW_ID }).result;
    expect(spy.gets).toHaveLength(1);
    expect(spy.sets).toEqual(spy.gets);
  });

  it("results of executions that read ctx.globals / ctx.variables are not stored", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    const d = (values: Record<string, unknown>) =>
      doc({
        globals: [{ id: "gv_g", name: "g", type: ir.text(), access: "readonly", value: "G" }],
        variables: [{ id: "var_v", name: "v", type: ir.text(), access: "private", default: "V" }],
        nodes: [n("n_s", "probe.state", { values })],
      });
    await engine.run({ context: d({ global: "g" }), flowId: FLOW_ID }).result;
    await engine.run({ context: d({ global: "g" }), flowId: FLOW_ID }).result;
    await engine.run({ context: d({ variable: "v" }), flowId: FLOW_ID }).result;
    await engine.run({ context: d({ variable: "v" }), flowId: FLOW_ID }).result;
    expect(probe.calls.get("n_s")).toBe(4);
    expect(spy.sets).toEqual([]);
    // Not reading → stored.
    await engine.run({ context: d({}), flowId: FLOW_ID }).result;
    await engine.run({ context: d({}), flowId: FLOW_ID }).result;
    expect(probe.calls.get("n_s")).toBe(5);
    expect(spy.sets).toHaveLength(1);
  });

  it("failed executions are not stored", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    const d = doc({ nodes: [n("n_f", "mock.fail")] });
    await engine.run({ context: d, flowId: FLOW_ID }).result;
    await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(spy.gets).toHaveLength(2);
    expect(spy.sets).toEqual([]);
  });

  it("cache errors are logged as warnings and treated as misses", async () => {
    const warnings: { message: string; data?: LogData }[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (message: string, data?: LogData) => warnings.push(data === undefined ? { message } : { message, data }) };
    const broken: RunCache = {
      get: async () => {
        throw new Error("cache down");
      },
      set: async () => {
        throw new Error("cache down");
      },
    };
    const { engine } = makeEngine({ cache: broken, logger });
    const result = await engine.run({ context: countDoc(), flowId: FLOW_ID }).result;
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ out: "v#1" });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    for (const w of warnings) expect(w.data).toMatchObject({ nodeId: "n_c" });
  });

  it("MediaRefs in inputs are keyed by hash (or uri without hash), not by their other fields", async () => {
    const spy = spyCache();
    const { engine } = makeEngine({ cache: spy.cache });
    const d = doc({
      inputs: [{ name: "img", type: ir.image() }],
      outputs: [{ name: "out", type: ir.text() }],
      nodes: [n("n_t", "convert.toText")],
      edges: [e("n_in.img", "n_t.value"), e("n_t.text", "n_out.out")],
    });
    const hash = "a".repeat(64);
    const run = (img: object) => engine.run({ context: d, flowId: FLOW_ID, inputs: { img } }).result;
    await run({ uri: "briar-media://m_1", mime: "image/png", hash });
    await run({ uri: "briar-media://m_2", mime: "image/jpeg", hash, meta: { width: 3 } });
    expect(spy.gets[0]).toBe(spy.gets[1]);
    await run({ uri: "briar-media://m_3", mime: "image/png" });
    await run({ uri: "briar-media://m_3", mime: "image/jpeg", bytes: 10 });
    expect(spy.gets[2]).toBe(spy.gets[3]);
    expect(spy.gets[2]).not.toBe(spy.gets[0]);
  });
});
