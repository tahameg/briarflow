import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCatalog, type RunEvent, type RunResult } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { createEngine } from "@briarflow/runtime";
import { collect, context, edge, field, flow, ir, node, secretsOf, steppingClock, testEngine, testMediaStore, trace } from "./helpers.js";
import { probe, tkPack } from "./tk-pack.js";

const packs = [stdPack, mockPack, tkPack];

function engineWith(extra: Parameters<typeof testEngine>[0] = {}) {
  return testEngine({ packs, ...extra });
}

async function runToEnd(engine: ReturnType<typeof testEngine>["engine"], doc: ReturnType<typeof context>, inputs?: Record<string, unknown>, extra: object = {}) {
  const run = engine.run({ context: doc, flowId: "flow_t", ...(inputs ? { inputs } : {}), ...extra });
  const [result, events] = await Promise.all([run.result, collect(run.events())]);
  return { run, result, events };
}

function ofType<T extends RunEvent["type"]>(events: RunEvent[], type: T): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
}

beforeEach(() => probe.reset());

describe("engine.run arguments", () => {
  it("throws run.invalid_call for programmer errors", () => {
    const { engine } = engineWith();
    expect(() => engine.run(undefined as never)).toThrow(expect.objectContaining({ code: "run.invalid_call" }));
    expect(() => engine.run({ context: undefined as never, flowId: "flow_t" })).toThrow(expect.objectContaining({ code: "run.invalid_call" }));
    expect(() => engine.run({ context: context([]), flowId: "" })).toThrow(expect.objectContaining({ code: "run.invalid_call" }));
  });

  it("rejects invalid engine options", () => {
    expect(() => createEngine({ catalog: createCatalog([]), media: testMediaStore(), secrets: secretsOf({}), concurrency: 0 })).toThrow(
      expect.objectContaining({ code: "engine.invalid_options" }),
    );
  });
});

describe("start sequence", () => {
  it("fails with run.invalid_flow for an unknown flow", async () => {
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({})]), flowId: "flow_nope" });
    const [result, events] = await Promise.all([run.result, collect(run.events())]);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("run.invalid_flow");
    expect(trace(events)).toEqual(["run.started", "run.completed"]);
  });

  it("fails with run.invalid_flow and diagnostics when validation has errors", async () => {
    const { engine } = engineWith();
    const doc = context([flow({ nodes: [node("n_pos", "tk.positive", { values: { value: -1 } })] })]);
    const { result, events } = await runToEnd(engine, doc);
    expect(result.error?.code).toBe("run.invalid_flow");
    expect(result.error?.message).toMatch(/^Flow "Test flow" has 1 error: /);
    expect((result.error?.details as { diagnostics: { code: string }[] }).diagnostics[0]?.code).toBe("node.invalid_value");
    expect(trace(events)).toEqual(["run.started", "run.completed"]);
    expect(result.startedAt <= result.finishedAt).toBe(true);
  });

  it("gives an empty input the empty value of its type instead of rejecting the run", async () => {
    const { engine } = engineWith();
    const doc = context([
      flow({ outputs: [field("v", ir.int())], nodes: [node("n_pos", "tk.positive")], edges: [edge("n_pos.value", "n_out.v")] }),
    ]);
    const { result } = await runToEnd(engine, doc);
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ v: 0 });
  });

  it("validates and normalizes inputs", async () => {
    const { engine } = engineWith();
    const doc = context([
      flow({
        inputs: [field("a", ir.int({ min: 0 })), field("b", ir.text(), { default: "dflt" }), field("c", ir.optional(ir.text()))],
        outputs: [field("a", ir.int()), field("b", ir.text()), field("c", ir.optional(ir.text()))],
        edges: [edge("n_in.a", "n_out.a"), edge("n_in.b", "n_out.b"), edge("n_in.c", "n_out.c")],
      }),
    ]);
    const ok = await runToEnd(engine, doc, { a: 1 });
    expect(ok.result.outputs).toEqual({ a: 1, b: "dflt", c: null });

    const bad = await runToEnd(engine, doc, { a: -1, zzz: 1 });
    expect(bad.result.error?.code).toBe("run.invalid_inputs");
    expect(bad.result.error?.message).toMatch(/^Flow "Test flow" received 2 invalid inputs\. First: /);
    const diags = (bad.result.error?.details as { diagnostics: { message: string; path: { valuePath?: string } }[] }).diagnostics;
    expect(diags.map((d) => d.path.valuePath).sort()).toEqual(["inputs.a", "inputs.zzz"]);
    expect(trace(bad.events)).toEqual(["run.started", "run.completed"]);

    const missing = await runToEnd(engine, doc, {});
    expect(missing.result.error?.code).toBe("run.invalid_inputs");
    expect(missing.result.error?.message).toMatch(/^Flow "Test flow" received 1 invalid input: /);
  });

  it("returns queued synchronously and never rejects result", async () => {
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({})]), flowId: "flow_t" });
    expect(run.status).toBe("queued");
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    expect(run.status).toBe("succeeded");
    run.cancel();
    expect(run.status).toBe("succeeded");
    expect(result.outputs).toEqual({});
  });
});

describe("scheduling", () => {
  it("starts ready nodes in (depth, id) order and honours engine concurrency", async () => {
    const { engine } = engineWith({ concurrency: 2 });
    const doc = context([
      flow({
        nodes: ["n_d", "n_a", "n_c", "n_b"].map((id) => node(id, "tk.wait")).concat([node("n_z", "tk.wait")]),
        edges: [edge("n_a.value", "n_z.value")],
      }),
    ]);
    const { result } = await runToEnd(engine, doc);
    expect(result.status).toBe("succeeded");
    expect(probe.startOrder).toEqual(["n_a", "n_b", "n_c", "n_d", "n_z"]);
    expect(probe.maxRunning).toBe(2);
  });

  it("honours per-type concurrency across runs", async () => {
    const { engine } = engineWith({ concurrency: 8 });
    const doc = context([flow({ nodes: [node("n_1", "tk.limited"), node("n_2", "tk.limited")] })]);
    const results = await Promise.all([engine.run({ context: doc, flowId: "flow_t" }).result, engine.run({ context: doc, flowId: "flow_t" }).result]);
    expect(results.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    expect(probe.maxRunning).toBe(1);
  });

  it("queues runs above maxConcurrentRuns", async () => {
    const { engine } = engineWith({ maxConcurrentRuns: 1 });
    const doc = context([flow({ nodes: [node("n_w", "tk.wait")] })]);
    const a = engine.run({ context: doc, flowId: "flow_t" });
    const b = engine.run({ context: doc, flowId: "flow_t" });
    await new Promise((r) => setTimeout(r, 5));
    expect(a.status).toBe("running");
    expect(b.status).toBe("queued");
    await a.result;
    expect((await b.result).status).toBe("succeeded");
  });

  it("checks inputs against constraints at run time (node.invalid_input, no retry)", async () => {
    const { engine } = engineWith();
    const doc = context([
      flow({
        nodes: [node("n_num", "tk.num", { values: { n: -5 } }), node("n_pos", "tk.positive")],
        edges: [edge("n_num.value", "n_pos.value")],
      }),
    ]);
    const { result, events } = await runToEnd(engine, doc);
    expect(result.error?.code).toBe("run.node_failed");
    expect(result.error?.cause?.code).toBe("node.invalid_input");
    expect(result.error?.cause?.message).toContain("inputs.value must be >= 0");
    expect(ofType(events, "node.retrying")).toHaveLength(0);
  });

  it.each([
    ["missing", "did not return its output \"value\""],
    ["extra", "unknown output \"other\""],
    ["constraint", "outputs.value must be >= 0"],
    ["notObject", "instead of an object"],
  ])("rejects invalid outputs (%s) with node.invalid_output, not retried", async (mode, text) => {
    const { engine } = engineWith();
    const doc = context([flow({ nodes: [node("n_bad", "tk.badOut", { values: { mode } })] })]);
    const { result } = await runToEnd(engine, doc);
    expect(result.error?.cause).toMatchObject({ code: "node.invalid_output", nodeId: "n_bad", retryable: false });
    expect(result.error?.cause?.message).toContain(text);
    expect(probe.runCalls).toBe(1);
  });

  it("fills omitted optional outputs with null", async () => {
    const { engine } = engineWith();
    const doc = context([flow({ nodes: [node("n_bad", "tk.badOut", { values: { mode: "ok" } })] })]);
    const { events } = await runToEnd(engine, doc);
    expect(ofType(events, "node.completed").find((e) => e.nodeId === "n_bad")?.outputs).toEqual({ value: 1, note: null });
  });
});

describe("failure and skip", () => {
  it("skips dependents, finishes independent branches, reports the first failure", async () => {
    const { engine } = engineWith();
    const doc = context([
      flow({
        outputs: [field("ok", ir.text())],
        nodes: [
          node("n_fail", "tk.fail"),
          node("n_after", "tk.text"),
          node("n_after2", "tk.text"),
          node("n_free", "tk.text", { values: { value: "free" } }),
        ],
        edges: [edge("n_fail.value", "n_after.value"), edge("n_after.value", "n_after2.value"), edge("n_free.value", "n_out.ok")],
      }),
    ]);
    const { result, events } = await runToEnd(engine, doc);
    expect(result.status).toBe("failed");
    expect(result.outputs).toBeUndefined();
    expect(result.error).toEqual({
      code: "run.node_failed",
      message: "Node Fail failed: boom",
      nodeId: "n_fail",
      cause: { code: "tk.boom", message: "boom", details: { why: "test" }, retryable: false, nodeId: "n_fail" },
    });
    const skipped = ofType(events, "node.skipped");
    expect(skipped.map((e) => [e.nodeId, e.reason, e.cause])).toEqual([
      ["n_after", "upstream_failed", "n_fail"],
      ["n_after2", "upstream_failed", "n_fail"],
    ]);
    const failedSeq = ofType(events, "node.failed")[0]?.seq ?? -1;
    expect(skipped.every((e) => e.seq > failedSeq)).toBe(true);
    expect(ofType(events, "node.completed").map((e) => e.nodeId)).toContain("n_out");
  });

  it("wraps plain exceptions as node.failed (not retried)", async () => {
    const { engine } = engineWith();
    const { result, events } = await runToEnd(engine, context([flow({ nodes: [node("n_x", "tk.throwPlain")] })]));
    expect(result.error?.cause).toMatchObject({ code: "node.failed", message: "plain failure", retryable: false });
    expect(ofType(events, "node.started")).toHaveLength(3);
    expect(ofType(events, "node.retrying")).toHaveLength(0);
  });
});

describe("retries", () => {
  it("retries retryable errors with backoff and emits node.retrying", async () => {
    const { engine } = engineWith();
    const doc = context([flow({ outputs: [field("attempt", ir.int())], nodes: [node("n_f", "tk.flaky")], edges: [edge("n_f.attempt", "n_out.attempt")] })]);
    const { result, events } = await runToEnd(engine, doc);
    expect(result.outputs).toEqual({ attempt: 3 });
    const forNode = events.filter((e) => "nodeId" in e && e.nodeId === "n_f");
    expect(forNode.map((e) => (e.type === "node.started" ? `started ${e.attempt}` : e.type))).toEqual([
      "started 1",
      "node.retrying",
      "started 2",
      "node.retrying",
      "started 3",
      "node.completed",
    ]);
    const retrying = ofType(events, "node.retrying");
    expect(retrying.map((e) => [e.attempt, e.nextAttempt, e.delayMs, e.error.code])).toEqual([
      [1, 2, 10, "node.unavailable"],
      [2, 3, 20, "node.unavailable"],
    ]);
  });

  it("fails after the last attempt", async () => {
    const { engine } = engineWith();
    const doc = context([flow({ nodes: [node("n_f", "tk.flaky", { values: { failures: 5 } })] })]);
    const { result } = await runToEnd(engine, doc);
    expect(result.error?.cause).toMatchObject({ code: "node.unavailable", message: "down 3", retryable: true });
  });

  it("uses retryAfterMs capped at maxDelayMs × 3", async () => {
    const { engine } = engineWith();
    const { events } = await runToEnd(engine, context([flow({ nodes: [node("n_r", "tk.rateLimited")] })]));
    expect(ofType(events, "node.retrying")[0]?.delayMs).toBe(60);
  });

  it("mock.flaky succeeds within its default retry policy (fake timers, jitter from random)", async () => {
    vi.useFakeTimers();
    try {
      const { engine } = engineWith();
      const doc = context([flow({ outputs: [field("v", ir.text())], nodes: [node("n_f", "mock.flaky", { values: { failures: 2 } })], edges: [edge("n_f.value", "n_out.v")] })]);
      const run = engine.run({ context: doc, flowId: "flow_t" });
      const eventsP = collect(run.events());
      await vi.runAllTimersAsync();
      const result = await run.result;
      expect(result.outputs).toEqual({ v: "ok" });
      expect(ofType(await eventsP, "node.retrying").map((e) => e.delayMs)).toEqual([375, 750]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps TypeErrors from ctx.fetch as retryable node.unavailable", async () => {
    const fetchCalls: unknown[] = [];
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      fetchCalls.push(init?.signal);
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { engine } = engineWith({ fetch: fakeFetch });
    const { result, events } = await runToEnd(engine, context([flow({ nodes: [node("n_f", "tk.fetcher")] })]));
    expect(result.error?.cause).toMatchObject({ code: "node.unavailable", retryable: true });
    expect(ofType(events, "node.retrying")).toHaveLength(1);
    expect(fetchCalls[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("timeouts and cancellation", () => {
  it("times out an attempt with node.timeout and retries it", async () => {
    const { engine } = engineWith();
    const { result, events } = await runToEnd(engine, context([flow({ nodes: [node("n_h", "tk.hang")] })]));
    expect(result.error?.cause).toMatchObject({ code: "node.timeout", retryable: true });
    expect(ofType(events, "node.retrying")[0]?.error.code).toBe("node.timeout");
    expect(probe.reasons.length).toBeGreaterThan(0);
    expect(probe.reasons[0]).toMatchObject({ code: "node.timeout" });
  });

  it("cancels: running nodes fail node.cancelled, not-started nodes are skipped", async () => {
    const { engine } = engineWith();
    const doc = context([
      flow({
        nodes: [node("n_slow", "mock.delay", { values: { ms: 5000, value: "x" } }), node("n_next", "tk.text")],
        edges: [edge("n_slow.value", "n_next.value")],
      }),
    ]);
    const run = engine.run({ context: doc, flowId: "flow_t" });
    const eventsP = collect(run.events());
    for await (const e of run.events()) if (e.type === "node.started" && e.nodeId === "n_slow") break;
    run.cancel("Stop it");
    expect(run.status).toBe("running");
    const result = await run.result;
    const events = await eventsP;
    expect(result).toMatchObject({ status: "cancelled", error: { code: "run.cancelled", message: "Stop it" } });
    expect(run.status).toBe("cancelled");
    expect(ofType(events, "node.skipped").map((e) => [e.nodeId, e.reason])).toEqual([["n_next", "cancelled"]]);
    expect(ofType(events, "node.failed").map((e) => [e.nodeId, e.error.code])).toEqual([["n_slow", "node.cancelled"]]);
  });

  it("stops waiting for nodes that ignore the signal after cancelGraceMs", async () => {
    const { engine } = engineWith({ cancelGraceMs: 20 });
    const run = engine.run({ context: context([flow({ nodes: [node("n_i", "tk.ignore", { values: { ms: 2000 } })] })]), flowId: "flow_t" });
    for await (const e of run.events()) if (e.type === "node.started") break;
    const t0 = Date.now();
    run.cancel();
    const result = await run.result;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(result.error).toEqual({ code: "run.cancelled", message: "The run was cancelled." });
  });

  it("cancel while queued emits only run.completed", async () => {
    const { engine } = engineWith({ maxConcurrentRuns: 1 });
    const doc = context([flow({ nodes: [node("n_w", "tk.wait")] })]);
    const a = engine.run({ context: doc, flowId: "flow_t" });
    const b = engine.run({ context: doc, flowId: "flow_t" });
    b.cancel();
    expect(b.status).toBe("cancelled");
    const events = await collect(b.events());
    expect(trace(events)).toEqual(["run.completed"]);
    expect(events[0]?.seq).toBe(0);
    const result = await b.result;
    expect(result.startedAt).toBe(result.finishedAt);
    expect((await a.result).status).toBe("succeeded");
  });

  it("an aborted signal cancels the run", async () => {
    const { engine } = engineWith();
    const controller = new AbortController();
    const run = engine.run({ context: context([flow({ nodes: [node("n_w", "tk.wait", { values: { ms: 5000 } })] })]), flowId: "flow_t", signal: controller.signal });
    for await (const e of run.events()) if (e.type === "node.started" && e.nodeId === "n_w") break;
    controller.abort("user left");
    expect((await run.result).error).toEqual({ code: "run.cancelled", message: "user left" });
  });

  it("a run timeout fails the run with run.timeout", async () => {
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({ nodes: [node("n_w", "tk.wait", { values: { ms: 5000 } })] })]), flowId: "flow_t", timeoutMs: 20 });
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("run.timeout");
  });

  it("cancellation during a retry wait ends the node cancelled", async () => {
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({ nodes: [node("n_f", "tk.flaky", { values: { failures: 5 } })] })]), flowId: "flow_t" });
    for await (const e of run.events()) if (e.type === "node.retrying") break;
    run.cancel();
    const events = await collect(run.events());
    expect(ofType(events, "node.failed").map((e) => e.error.code)).toEqual(["node.cancelled"]);
    expect((await run.result).status).toBe("cancelled");
  });
});

describe("events", () => {
  it("replays after a seq, supports many consumers and break", async () => {
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({ nodes: [node("n_a", "tk.text"), node("n_b", "tk.text")] })]), flowId: "flow_t" });
    const all = await collect(run.events());
    const after = await collect(run.events({ after: 2 }));
    expect(after.map((e) => e.seq)).toEqual(all.slice(3).map((e) => e.seq));
    let first: RunEvent | undefined;
    for await (const e of run.events()) {
      first = e;
      break;
    }
    expect(first?.type).toBe("run.started");
    const ats = all.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
    const completed = all.at(-1) as Extract<RunEvent, { type: "run.completed" }>;
    expect(completed.result).toEqual(await run.result);
  });

  it("throttles progress, clamps fractions, truncates messages, ignores NaN (fake timers)", async () => {
    vi.useFakeTimers();
    const { engine } = engineWith();
    const run = engine.run({ context: context([flow({ nodes: [node("n_p", "tk.progress")] })]), flowId: "flow_t" });
    const eventsP = collect(run.events());
    await vi.runAllTimersAsync();
    await run.result;
    const events = await eventsP;
    const progress = ofType(events, "node.progress");
    expect(progress).toHaveLength(3);
    expect(progress[0]).toMatchObject({ fraction: 0.1, message: "step 1" });
    expect(progress[1]).toMatchObject({ fraction: 1, message: "step 10" });
    expect(progress[2]?.fraction).toBe(1);
    expect(progress[2]?.message?.length).toBe(200);
    const completedSeq = ofType(events, "node.completed").find((e) => e.nodeId === "n_p")?.seq ?? 0;
    expect(progress.every((p) => p.seq < completedSeq)).toBe(true);
  });

  it("emits nothing after run.completed and seq is gap-free", async () => {
    const { engine } = engineWith();
    const { events } = await runToEnd(engine, context([flow({ nodes: [node("n_f", "tk.fail"), node("n_a", "tk.text")] })]));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.filter((e) => e.type === "run.completed")).toHaveLength(1);
  });
});

describe("ExecContext", () => {
  it("resolves declared secrets and fails missing ones with node.missing_secret", async () => {
    const doc = context([flow({ outputs: [field("v", ir.text())], nodes: [node("n_s", "tk.secret", { title: "Call API" })], edges: [edge("n_s.value", "n_out.v")] })]);
    const ok = await runToEnd(engineWith({ secrets: secretsOf({ API_KEY: "k-1" }) }).engine, doc);
    expect(ok.result.outputs).toEqual({ v: "k-1" });
    const missing = await runToEnd(engineWith().engine, doc);
    expect(missing.result.error?.cause).toMatchObject({
      code: "node.missing_secret",
      message: 'Node Call API needs secret "API_KEY". Set it in your secrets provider (e.g. env var API_KEY).',
      retryable: false,
    });
  });

  it("rejects undeclared secrets", async () => {
    const { result } = await runToEnd(engineWith({ secrets: secretsOf({ OTHER: "x" }) }).engine, context([flow({ nodes: [node("n_s", "tk.undeclaredSecret")] })]));
    expect(result.error?.cause?.code).toBe("node.secret_not_declared");
  });

  it("tags log entries with runId and nodeId", async () => {
    const lines: unknown[] = [];
    const logger = { debug() {}, info: (m: string, d?: object) => lines.push([m, d]), warn() {}, error() {} };
    await runToEnd(engineWith({ logger }).engine, context([flow({ nodes: [node("n_l", "tk.log")] })]));
    expect(lines).toEqual([["hello", { a: 1, runId: "run_1", nodeId: "n_l" }]]);
  });
});

describe("clock", () => {
  it("uses the injected clock for at, startedAt and finishedAt", async () => {
    const { engine } = engineWith({ clock: steppingClock(Date.parse("2030-01-01T00:00:00.000Z")) });
    const { result, events } = await runToEnd(engine, context([flow({})]));
    expect(result.startedAt.startsWith("2030-01-01T00:00:00")).toBe(true);
    expect(events.every((e) => e.at.startsWith("2030-01-01"))).toBe(true);
    const r: RunResult = result;
    expect(r.finishedAt >= r.startedAt).toBe(true);
  });
});

afterEach(() => vi.useRealTimers());
