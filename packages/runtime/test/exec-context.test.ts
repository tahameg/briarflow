/**
 * node-api.md §6, phase-3.md §4.8: the ExecContext the engine gives nodes, plus the phase exit
 * flow (Character → struct.break → text.template → mock.llm → mock.image → output).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogData, MediaRef, RunEvent } from "@briarflow/core";
import { mockHash } from "@briarflow/nodes-mock";
import { ir, readStream } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, probe } from "./support.js";

beforeEach(() => probe.reset());

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

function nodeError(events: RunEvent[], nodeId: string) {
  return (events.find((x) => x.type === "node.failed" && x.nodeId === nodeId) as Ev<"node.failed"> | undefined)?.error;
}

describe("ExecContext", () => {
  it("has runId, flowId, nodeId, attempt, an AbortSignal, the engine media and resolveType", async () => {
    const { engine, media } = makeEngine();
    const d = doc({
      types: [{ kind: "struct", id: "ty_char", name: "Character", fields: [{ name: "name", type: ir.text() }] }],
      nodes: [n("n_ctx", "probe.ctx")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID, runId: "run_x" }).result;
    expect(result.status).toBe("succeeded");
    const seen = probe.seen[0]!;
    expect(seen).toMatchObject({ runId: "run_x", flowId: FLOW_ID, nodeId: "n_ctx", attempt: 1 });
    expect(seen["signal"]).toBeInstanceOf(AbortSignal);
    expect((seen["signal"] as AbortSignal).aborted).toBe(false);
    // ctx.media is the engine media scoped to the node: what it puts belongs to the run.
    expect(Object.keys(seen["media"] as object).sort()).toEqual(["entry", "link", "put", "read", "url"]);
    expect(media).toBeDefined();
    expect(seen["resolveType"]).toEqual({ kind: "struct", id: "ty_char", name: "Character", fields: [{ name: "name", type: ir.text() }] });
    expect((seen["node"] as { id: string }).id).toBe("n_ctx");
  });

  it("resolveType looks up local → global → pack types and returns undefined for unknown ids", async () => {
    const { engine } = makeEngine();
    const d = doc({
      localTypes: [{ kind: "struct", id: "ty_char", name: "LocalChar", fields: [] }],
      types: [{ kind: "struct", id: "ty_char", name: "GlobalChar", fields: [] }],
      nodes: [n("n_ctx", "probe.ctx")],
    });
    await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect((probe.seen[0]!["resolveType"] as { name: string } | undefined)?.name).toBe("LocalChar");
    probe.reset();
    await engine.run({ context: doc({ nodes: [n("n_ctx", "probe.ctx")] }), flowId: FLOW_ID }).result;
    expect(probe.seen[0]!["resolveType"]).toBeUndefined();
  });

  it("log lines are tagged with runId and nodeId", async () => {
    const lines: { level: string; message: string; data?: LogData }[] = [];
    const logger = {
      debug: (message: string, data?: LogData) => lines.push(data === undefined ? { level: "debug", message } : { level: "debug", message, data }),
      info: (message: string, data?: LogData) => lines.push(data === undefined ? { level: "info", message } : { level: "info", message, data }),
      warn: (message: string, data?: LogData) => lines.push(data === undefined ? { level: "warn", message } : { level: "warn", message, data }),
      error: (message: string, data?: LogData) => lines.push(data === undefined ? { level: "error", message } : { level: "error", message, data }),
    };
    const { engine } = makeEngine({ logger });
    await engine.run({ context: doc({ nodes: [n("n_ctx", "probe.ctx")] }), flowId: FLOW_ID, runId: "run_log" }).result;
    const line = lines.find((l) => l.message === "hello from probe");
    expect(line).toMatchObject({ level: "info", data: { extra: 1, runId: "run_log", nodeId: "n_ctx" } });
  });

  describe("secrets", () => {
    it("declared secrets are resolved before the first attempt and readable via ctx.secrets.get", async () => {
      const asked: string[] = [];
      const { engine } = makeEngine({
        secrets: {
          get: async (name) => {
            asked.push(name);
            return name === "API_KEY" ? "s3cret" : undefined;
          },
        },
      });
      const d = doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_s", "probe.secret")], edges: [e("n_s.value", "n_out.out")] });
      const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
      expect(result.outputs).toEqual({ out: "key:s3cret" });
      expect(asked).toEqual(["API_KEY"]);
    });

    it("a missing secret fails the node with node.missing_secret and the spec message, not retried", async () => {
      const { engine } = makeEngine();
      const run = engine.run({ context: doc({ nodes: [n("n_s", "probe.secret")] }), flowId: FLOW_ID });
      await run.result;
      const events = await collect(run);
      expect(nodeError(events, "n_s")).toMatchObject({
        code: "node.missing_secret",
        message: 'Node Secret needs secret "API_KEY". Set it in your secrets provider (e.g. env var API_KEY).',
        nodeId: "n_s",
      });
      expect(events.some((x) => x.type === "node.retrying")).toBe(false);
    });

    it("an undeclared secret → node.secret_not_declared", async () => {
      const { engine } = makeEngine({ secrets: { get: async () => "x" } });
      const run = engine.run({ context: doc({ nodes: [n("n_s", "probe.secret", { values: { askOther: true } })] }), flowId: FLOW_ID });
      await run.result;
      expect(nodeError(await collect(run), "n_s")?.code).toBe("node.secret_not_declared");
    });
  });

  describe("fetch", () => {
    it("is the engine fetch, with signal defaulted to ctx.signal", async () => {
      const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
      const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), signal: init?.signal });
        return new Response("pong");
      }) as typeof fetch;
      const { engine } = makeEngine({ fetch: fakeFetch });
      const d = doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_ctx", "probe.ctx", { values: { url: "https://example.test/ping" } })], edges: [e("n_ctx.value", "n_out.out")] });
      const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
      expect(result.outputs).toEqual({ out: "pong" });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://example.test/ping");
      expect(calls[0]!.signal).toBe(probe.seen[0]!["signal"]);
    });

    it("a TypeError thrown by ctx.fetch becomes retryable node.unavailable", async () => {
      vi.useFakeTimers();
      try {
        const fakeFetch = (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch;
        const { engine } = makeEngine({ fetch: fakeFetch });
        const d = doc({ nodes: [n("n_ctx", "probe.ctx", { values: { url: "https://example.test/down" } })] });
        const run = engine.run({ context: d, flowId: FLOW_ID });
        await vi.advanceTimersByTimeAsync(0);
        await run.result;
        const err = nodeError(await collect(run), "n_ctx");
        expect(err).toMatchObject({ code: "node.unavailable", retryable: true });
        expect(err?.message).toContain("fetch failed");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("phase 3 exit flow", () => {
  it("Character → briar.struct.break → text.template → mock.llm → mock.image → output, with in-memory media", async () => {
    const { engine, media } = makeEngine();
    const d = doc({
      types: [
        {
          kind: "struct",
          id: "ty_char",
          name: "Character",
          fields: [
            { name: "name", type: ir.text() },
            { name: "age", type: ir.int(), default: 30 },
          ],
        },
      ],
      inputs: [{ name: "character", type: ir.named("ty_char") }],
      outputs: [
        { name: "reply", type: ir.text() },
        { name: "portrait", type: ir.image() },
      ],
      nodes: [
        n("n_break", "briar.struct.break", { config: { typeId: "ty_char" } }),
        n("n_tpl", "text.template", { config: { template: "Portrait of {{name}}, age {{age}}" } }),
        n("n_llm", "mock.llm"),
        n("n_img", "mock.image", { values: { width: 64, height: 32 } }),
      ],
      edges: [
        e("n_in.character", "n_break.value"),
        e("n_break.name", "n_tpl.name"),
        e("n_break.age", "n_tpl.age"),
        e("n_tpl.text", "n_llm.prompt"),
        e("n_llm.text", "n_img.prompt"),
        e("n_llm.text", "n_out.reply"),
        e("n_img.image", "n_out.portrait"),
      ],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID, inputs: { character: { name: "Aria" } } });
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    const prompt = "Portrait of Aria, age 30";
    const hash = await mockHash({ system: null, prompt, seed: 0 });
    const reply = `Mock reply ${hash.slice(0, 8)}: ${prompt}`;
    expect(result.outputs?.["reply"]).toBe(reply);
    const image = result.outputs?.["portrait"] as MediaRef;
    expect(await media.entry(image)).toMatchObject({ mime: "image/svg+xml", meta: { width: 64, height: 32 } });
    const svg = new TextDecoder().decode(await media.read(image));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(reply.slice(0, 20));
    // Second run is fully cached and deterministic.
    const again = engine.run({ context: d, flowId: FLOW_ID, inputs: { character: { name: "Aria" } } });
    const r2 = await again.result;
    expect(r2.outputs).toEqual(result.outputs);
    const cached = (await collect(again)).filter((x): x is Ev<"node.completed"> => x.type === "node.completed" && x.cached);
    // text.template is not cached (it can read variables); its unchanged text keeps the LLM cached.
    expect(cached.map((x) => x.nodeId).sort()).toEqual(["n_break", "n_img", "n_llm"]);
  });
});
