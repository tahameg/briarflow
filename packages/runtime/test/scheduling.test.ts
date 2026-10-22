/**
 * runtime.md §3, phase-3.md §4.2: dependency order, deterministic start order, concurrency,
 * input resolution and validation, output checks, built-in nodes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, ofNode, probe, started, waitFor } from "./support.js";

beforeEach(() => probe.reset());

function failedError(events: RunEvent[], nodeId: string) {
  const ev = events.find((x) => x.type === "node.failed" && x.nodeId === nodeId) as Extract<RunEvent, { type: "node.failed" }> | undefined;
  return ev?.error;
}

describe("start order", () => {
  const orderDoc = () =>
    doc({
      nodes: [
        n("n_z", "probe.echo", { values: { value: "z" } }),
        n("n_b", "probe.echo", { values: { value: "b" } }),
        n("n_a", "probe.echo", { values: { value: "a" } }),
        n("n_c", "probe.echo", { values: { value: "c" } }),
      ],
      edges: [e("n_b.value", "n_a.value")],
    });

  it.each([1, 8])("ready nodes start by (depth, id) at concurrency %i", async (concurrency) => {
    const { engine } = makeEngine({ concurrency });
    const run = engine.run({ context: orderDoc(), flowId: FLOW_ID, useCache: false });
    expect((await run.result).status).toBe("succeeded");
    expect(probe.started).toEqual(["n_b", "n_c", "n_z", "n_a"]);
    const starts = (await collect(run)).filter((x) => x.type === "node.started").map((x) => (x as { nodeId: string }).nodeId);
    expect(starts.indexOf("n_b")).toBeLessThan(starts.indexOf("n_c"));
    expect(starts.indexOf("n_c")).toBeLessThan(starts.indexOf("n_z"));
    expect(starts.indexOf("n_z")).toBeLessThan(starts.indexOf("n_a"));
  });

  it("is identical across repeated runs (determinism)", async () => {
    const traces: string[][] = [];
    for (let i = 0; i < 3; i++) {
      probe.reset();
      const { engine } = makeEngine({ concurrency: 2 });
      const run = engine.run({ context: orderDoc(), flowId: FLOW_ID, useCache: false });
      traces.push((await collect(run)).map((x) => `${x.type}:${"nodeId" in x ? x.nodeId : ""}`));
    }
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[2]).toEqual(traces[0]);
  });

  it("depth is the longest path: a deep chain node waits even if one dependency is shallow", async () => {
    const { engine } = makeEngine();
    const d = doc({
      nodes: [n("n_1", "probe.echo"), n("n_2", "probe.echo"), n("n_t", "text.template", { config: { template: "{a}{b}" } })],
      edges: [e("n_1.value", "n_2.value"), e("n_1.value", "n_t.a"), e("n_2.value", "n_t.b")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    const events = await collect(run);
    const startT = events.find((x) => x.type === "node.started" && x.nodeId === "n_t")!;
    const done2 = events.find((x) => x.type === "node.completed" && x.nodeId === "n_2")!;
    expect(done2.seq).toBeLessThan(startT.seq);
  });

  it("every node runs, also nodes whose outputs are unused", async () => {
    const { engine } = makeEngine();
    const d = doc({ nodes: [n("n_lonely", "probe.echo")] });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    await run.result;
    expect(probe.started).toEqual(["n_lonely"]);
  });
});

describe("concurrency", () => {
  const waits = (count: number, type = "probe.wait", prefix = "w") =>
    doc({ nodes: Array.from({ length: count }, (_, i) => n(`n_${prefix}${i}`, type)) });

  it("engine-wide concurrency limits running nodes; waiting ones start FIFO", async () => {
    const { engine } = makeEngine({ concurrency: 2 });
    const run = engine.run({ context: waits(4), flowId: FLOW_ID });
    await started(run, "n_w1");
    expect(probe.started).toEqual(["n_w0", "n_w1"]);
    probe.release("n_w1");
    await started(run, "n_w2");
    expect(probe.started).toEqual(["n_w0", "n_w1", "n_w2"]);
    probe.release("n_w0");
    await started(run, "n_w3");
    probe.release("n_w2");
    probe.release("n_w3");
    await run.result;
    expect(probe.maxRunning).toBe(2);
  });

  it("the engine-wide limit holds across runs", async () => {
    const { engine } = makeEngine({ concurrency: 3 });
    const a = engine.run({ context: waits(2, "probe.wait", "a"), flowId: FLOW_ID });
    const b = engine.run({ context: waits(2, "probe.wait", "b"), flowId: FLOW_ID });
    await started(a, "n_a1");
    await started(b, "n_b0");
    expect(probe.started).toEqual(["n_a0", "n_a1", "n_b0"]);
    expect(probe.running).toBe(3);
    for (const k of ["n_a0", "n_a1", "n_b0", "n_b1"]) probe.release(k);
    await Promise.all([a.result, b.result]);
    expect(probe.maxRunning).toBe(3);
  });

  it("per-type concurrency (definition `concurrency`) holds across runs; other types are not blocked", async () => {
    const { engine } = makeEngine({ concurrency: 8 });
    const one = engine.run({ context: doc({ nodes: [n("n_s1", "probe.single"), n("n_s2", "probe.single")] }), flowId: FLOW_ID });
    const two = engine.run({ context: doc({ nodes: [n("n_s3", "probe.single"), n("n_x", "probe.wait")] }), flowId: FLOW_ID });
    await started(one, "n_s1");
    await started(two, "n_x");
    expect(probe.started).toEqual(["n_s1", "n_x"]);
    probe.release("n_s1");
    await started(one, "n_s2");
    probe.release("n_s2");
    await started(two, "n_s3");
    probe.release("n_s3");
    probe.release("n_x");
    await Promise.all([one.result, two.result]);
    expect(probe.started).toEqual(["n_s1", "n_x", "n_s2", "n_s3"]);
  });

  it("built-ins and variable nodes take no slot", async () => {
    const { engine } = makeEngine({ concurrency: 1 });
    const d = doc({
      inputs: [{ name: "t", type: ir.text() }],
      outputs: [{ name: "out", type: ir.text() }],
      variables: [{ id: "var_v", name: "v", type: ir.text(), access: "private" }],
      nodes: [
        n("n_w", "probe.wait"),
        n("n_set", "briar.variable.set", { config: { variableId: "var_v" } }),
        n("n_get", "briar.variable.get", { config: { variableId: "var_v" } }),
      ],
      edges: [e("n_in.t", "n_set.value"), e("n_get.value", "n_out.out")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID, inputs: { t: "hello" } });
    const out = (await waitFor(run, (x) => x.type === "node.completed" && x.nodeId === "n_out")) as Extract<RunEvent, { type: "node.completed" }>;
    expect(out.outputs).toEqual({ out: "hello" });
    expect(run.status).toBe("running"); // n_w still holds the only slot
    probe.release("n_w");
    expect((await run.result).outputs).toEqual({ out: "hello" });
  });
});

describe("input resolution", () => {
  it("edge → constant → port default → null for optional", async () => {
    const { engine } = makeEngine();
    const d = doc({
      outputs: [
        { name: "edge", type: ir.text() },
        { name: "constant", type: ir.text() },
        { name: "default", type: ir.text() },
      ],
      nodes: [
        n("n_src", "probe.echo", { values: { value: "from-edge" } }),
        n("n_edge", "probe.echo", { values: { value: "ignored constant" } }),
        n("n_const", "probe.echo", { values: { value: "from-constant" } }),
        n("n_def", "probe.echo"),
        n("n_llm", "mock.llm", { values: { prompt: "p" } }),
      ],
      edges: [
        e("n_src.value", "n_edge.value"),
        e("n_edge.value", "n_out.edge"),
        e("n_const.value", "n_out.constant"),
        e("n_def.value", "n_out.default"),
      ],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    const result = await run.result;
    expect(result.outputs).toEqual({ edge: "from-edge", constant: "from-constant", default: "x" });
    // mock.llm's optional `system` defaulted to null (shows in the hash input) — it ran fine:
    expect(ofNode(await collect(run), "n_llm").at(-1)?.type).toBe("node.completed");
  });

  it("inputs are validated against port constraints: node.invalid_input, not retried", async () => {
    const { engine } = makeEngine();
    const d = doc({
      nodes: [n("n_parse", "convert.parseInt", { values: { text: "-5" } }), n("n_img", "mock.image", { values: { prompt: "p" } })],
      edges: [e("n_parse.value", "n_img.width")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    const result = await run.result;
    const events = await collect(run);
    const error = failedError(events, "n_img");
    expect(error?.code).toBe("node.invalid_input");
    expect(error?.message).toMatch(/^Node Mock image got an invalid input: .*inputs\.width.*\.$/);
    expect((error?.details as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0);
    expect(error?.nodeId).toBe("n_img");
    expect(events.filter((x) => x.type === "node.retrying")).toEqual([]);
    expect(result.error?.code).toBe("run.node_failed");
  });

  it("struct inputs are normalized (struct defaults filled) before run", async () => {
    const { engine } = makeEngine();
    const d = doc({
      types: [
        {
          kind: "struct",
          id: "ty_char",
          name: "Character",
          fields: [
            { name: "name", type: ir.text() },
            { name: "age", type: ir.int(), default: 30 },
            { name: "nick", type: ir.optional(ir.text()) },
          ],
        },
      ],
      inputs: [{ name: "c", type: ir.named("ty_char") }],
      outputs: [{ name: "c", type: ir.named("ty_char") }],
      nodes: [n("n_k", "briar.constant", { config: { type: ir.named("ty_char") } })],
      edges: [e("n_in.c", "n_k.value"), e("n_k.value", "n_out.c")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID, inputs: { c: { name: "Aria" } } }).result;
    expect(result.outputs).toEqual({ c: { name: "Aria", age: 30, nick: null } });
  });
});

describe("output checks", () => {
  async function badOut(mode: string) {
    const { engine } = makeEngine();
    const run = engine.run({ context: doc({ nodes: [n("n_bad", "probe.badOut", { values: { mode } })] }), flowId: FLOW_ID });
    const events = await collect(run);
    return { events, error: failedError(events, "n_bad"), calls: probe.calls.get("n_bad") };
  }

  it("omitted optional outputs become null", async () => {
    const { events } = await badOut("ok");
    const done = ofNode(events, "n_bad").at(-1) as Extract<RunEvent, { type: "node.completed" }>;
    expect(done.outputs).toEqual({ value: 1, maybe: null });
  });

  it.each(["missing", "wrongType", "constraint", "extra", "notObject"])("%s → node.invalid_output, not retried", async (mode) => {
    const { events, error, calls } = await badOut(mode);
    expect(error?.code).toBe("node.invalid_output");
    expect(error?.nodeId).toBe("n_bad");
    expect(error?.message.startsWith("Node Bad out")).toBe(true);
    expect(calls).toBe(1);
    expect(events.some((x) => x.type === "node.retrying")).toBe(false);
  });

  it("an ill-typed output uses the spec message", async () => {
    const { error } = await badOut("constraint");
    expect(error?.message).toMatch(/^Node Bad out returned an invalid output: .+\.$/);
  });
});

describe("built-in nodes", () => {
  it("briar.input completes with the normalized inputs; briar.output with its inputs = RunResult.outputs", async () => {
    const { engine } = makeEngine();
    const d = doc({
      inputs: [
        { name: "a", type: ir.text() },
        { name: "b", type: ir.int(), default: 2 },
      ],
      outputs: [{ name: "a", type: ir.text() }],
      edges: [e("n_in.a", "n_out.a")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID, inputs: { a: "x" } });
    const result = await run.result;
    const events = await collect(run);
    const input = ofNode(events, "n_in").at(-1) as Extract<RunEvent, { type: "node.completed" }>;
    const output = ofNode(events, "n_out").at(-1) as Extract<RunEvent, { type: "node.completed" }>;
    expect(input).toMatchObject({ type: "node.completed", outputs: { a: "x", b: 2 }, cached: false });
    expect(output.outputs).toEqual({ a: "x" });
    expect(result.outputs).toEqual(output.outputs);
    expect(ofNode(events, "n_in")[0]).toMatchObject({ type: "node.started", attempt: 1 });
  });
});
