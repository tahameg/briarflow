/**
 * runtime.md §1–§2, phase-3.md §4.1: engine API, run lifecycle, start sequence.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createCatalog, type ContextDocument, type RunEvent } from "@briarflow/core";
import { createEngine, createMemoryCache, PACKAGE_NAME } from "@briarflow/runtime";
import { expectBriarError, ir, memoryMediaStore } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, probe, probePack, started, trace } from "./support.js";

beforeEach(() => probe.reset());

const echoDoc = () =>
  doc({
    inputs: [{ name: "topic", type: ir.text() }],
    outputs: [{ name: "out", type: ir.text() }],
    nodes: [n("n_a", "probe.echo")],
    edges: [e("n_in.topic", "n_a.value"), e("n_a.value", "n_out.out")],
  });

describe("package", () => {
  it("exports PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/runtime");
  });
});

describe("createEngine", () => {
  const base = () => ({ catalog: createCatalog([probePack]), secrets: { get: async () => undefined } });

  it("needs catalog and secrets (media defaults to memory)", () => {
    const err = expectBriarError(() => createEngine({} as never), "engine.invalid_options");
    expect(err.message).toBe("createEngine needs { catalog, secrets }.");
    expectBriarError(() => createEngine({ ...base(), secrets: undefined } as never), "engine.invalid_options");
    expect(() => createEngine(base())).not.toThrow();
    expectBriarError(() => createEngine(undefined as never), "engine.invalid_options");
  });

  it("rejects bad concurrency / maxConcurrentRuns / cancelGraceMs", () => {
    const c = expectBriarError(() => createEngine({ ...base(), concurrency: 0 }), "engine.invalid_options");
    expect(c.message).toBe("createEngine: concurrency must be a whole number >= 1 (got 0).");
    expectBriarError(() => createEngine({ ...base(), concurrency: 1.5 }), "engine.invalid_options");
    const r = expectBriarError(() => createEngine({ ...base(), maxConcurrentRuns: -2 }), "engine.invalid_options");
    expect(r.message).toBe("createEngine: maxConcurrentRuns must be a whole number >= 1 (got -2).");
    expectBriarError(() => createEngine({ ...base(), cancelGraceMs: -1 }), "engine.invalid_options");
    expectBriarError(() => createEngine({ ...base(), cancelGraceMs: Number.NaN }), "engine.invalid_options");
    expect(() => createEngine({ ...base(), cancelGraceMs: 0, concurrency: 1, maxConcurrentRuns: 1 })).not.toThrow();
  });

  it("exposes its catalog", () => {
    const opts = base();
    expect(createEngine(opts).catalog).toBe(opts.catalog);
  });
});

describe("engine.run programmer errors", () => {
  it("throws run.invalid_call for missing options, context or flowId, and bad timeoutMs", () => {
    const { engine } = makeEngine();
    expectBriarError(() => engine.run(undefined as never), "run.invalid_call");
    expectBriarError(() => engine.run({ flowId: FLOW_ID } as never), "run.invalid_call");
    const noFlow = expectBriarError(() => engine.run({ context: echoDoc() } as never), "run.invalid_call");
    expect(noFlow.message).toBe("engine.run needs the id of the flow to run in options.flowId.");
    const t = expectBriarError(() => engine.run({ context: echoDoc(), flowId: FLOW_ID, timeoutMs: -1 }), "run.invalid_call");
    expect(t.message).toBe("engine.run: timeoutMs must be a number > 0 (got -1).");
    expectBriarError(() => engine.run({ context: echoDoc(), flowId: FLOW_ID, timeoutMs: 0 }), "run.invalid_call");
  });
});

describe("run lifecycle", () => {
  it("returns synchronously in queued, then runs to succeeded", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: echoDoc(), flowId: FLOW_ID, inputs: { topic: "cats" } });
    expect(run.status).toBe("queued");
    expect(run.id).toBe("run_1");
    const result = await run.result;
    expect(run.status).toBe("succeeded");
    expect(result).toEqual({
      runId: "run_1",
      flowId: FLOW_ID,
      contextId: "ctx_test",
      contextRevision: 1,
      status: "succeeded",
      outputs: { out: "cats" },
      variables: {},
      globalWrites: {},
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    });
    expect(result.finishedAt >= result.startedAt).toBe(true);
  });

  it("is running while nodes execute", async () => {
    const { engine } = makeEngine();
    const run = engine.run({
      context: doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_w", "probe.wait")], edges: [e("n_w.value", "n_out.out")] }),
      flowId: FLOW_ID,
    });
    await started(run, "n_w");
    expect(run.status).toBe("running");
    probe.release("n_w", "go");
    expect((await run.result).outputs).toEqual({ out: "go" });
  });

  it("uses the given runId", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: echoDoc(), flowId: FLOW_ID, inputs: { topic: "x" }, runId: "run_custom" });
    expect(run.id).toBe("run_custom");
    expect((await run.result).runId).toBe("run_custom");
    for (const ev of await collect(run)) expect(ev.runId).toBe("run_custom");
  });

  it("result resolves once with the run.completed result; terminal state never changes; cancel after is a no-op", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: echoDoc(), flowId: FLOW_ID, inputs: { topic: "x" } });
    const result = await run.result;
    run.cancel("too late");
    expect(run.status).toBe("succeeded");
    expect(await run.result).toBe(result);
    const events = await collect(run);
    const completed = events.filter((ev) => ev.type === "run.completed");
    expect(completed).toHaveLength(1);
    expect((completed[0] as Extract<RunEvent, { type: "run.completed" }>).result).toEqual(result);
  });

  it("maxConcurrentRuns: extra runs wait in queued and start FIFO", async () => {
    const { engine } = makeEngine({ maxConcurrentRuns: 1 });
    const mk = (key: string) =>
      engine.run({
        context: doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_w", "probe.wait", { values: { key } })], edges: [e("n_w.value", "n_out.out")] }),
        flowId: FLOW_ID,
      });
    const a = mk("a");
    const b = mk("b");
    const c = mk("c");
    await started(a, "n_w");
    expect([a.status, b.status, c.status]).toEqual(["running", "queued", "queued"]);
    probe.release("a");
    await a.result;
    await started(b, "n_w");
    expect([b.status, c.status]).toEqual(["running", "queued"]);
    probe.release("b");
    probe.release("c");
    await Promise.all([b.result, c.result]);
    expect(probe.started).toEqual(["n_w", "n_w", "n_w"]);
    const order = await Promise.all([a, b, c].map(async (r) => (await r.result).startedAt));
    expect([...order].sort()).toEqual(order);
  });
});

describe("start sequence failures", () => {
  it("unknown flow id → failed run.invalid_flow with one flow.not_found diagnostic", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: echoDoc(), flowId: "flow_nope" });
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "run.invalid_flow",
      message: 'Flow "flow_nope" does not exist in context "Test context". Check the flow id.',
    });
    const diags = (result.error?.details as { diagnostics: { code: string; severity: string; path: unknown }[] }).diagnostics;
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: "flow.not_found", severity: "error", path: { flowId: "flow_nope" } });
    expect(result.outputs).toBeUndefined();
    expect(trace(await collect(run))).toEqual(["run.started", "run.completed"]);
  });

  it("one validation error → `Flow \"{name}\" has 1 error: {message}`; stream is run.started, run.completed", async () => {
    const { engine } = makeEngine();
    const bad = doc({ nodes: [n("n_x", "nope.unknown")] });
    const run = engine.run({ context: bad, flowId: FLOW_ID });
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("run.invalid_flow");
    const diags = (result.error?.details as { diagnostics: { code: string; message: string; severity: string }[] }).diagnostics;
    expect(diags.length).toBe(1);
    expect(diags.every((d) => d.severity === "error")).toBe(true);
    expect(result.error?.message).toBe(`Flow "Test flow" has 1 error: ${diags[0]?.message}`);
    expect(trace(await collect(run))).toEqual(["run.started", "run.completed"]);
    expect(probe.started).toEqual([]);
  });

  it("several validation errors → `has {n} errors. First: …`; warnings ignored", async () => {
    const { engine } = makeEngine();
    const bad = doc({ nodes: [n("n_x", "nope.unknown"), n("n_y", "nope.other")] });
    const result = await engine.run({ context: bad, flowId: FLOW_ID }).result;
    const diags = (result.error?.details as { diagnostics: { message: string }[] }).diagnostics;
    expect(diags.length).toBe(2);
    expect(result.error?.message).toBe(`Flow "Test flow" has 2 errors. First: ${diags[0]?.message}`);
  });

  it("a flow with only warnings runs", async () => {
    const { engine } = makeEngine();
    // An unused private variable is a warning (variable.unused).
    const d = doc({
      outputs: [{ name: "out", type: ir.text() }],
      variables: [{ id: "var_u", name: "unused", type: ir.text(), access: "private", default: "x" }],
      nodes: [n("n_a", "probe.echo", { values: { value: "v" } })],
      edges: [e("n_a.value", "n_out.out")],
    });
    expect((await engine.run({ context: d, flowId: FLOW_ID }).result).status).toBe("succeeded");
  });

  describe("input validation", () => {
    const sig = () =>
      doc({
        inputs: [
          { name: "name", type: ir.text({ maxLength: 5 }) },
          { name: "count", type: ir.int({ min: 0 }), default: 3 },
          { name: "maybe", type: ir.optional(ir.text()) },
        ],
        outputs: [
          { name: "name", type: ir.text() },
          { name: "count", type: ir.int() },
          { name: "maybe", type: ir.optional(ir.text()) },
        ],
        edges: [e("n_in.name", "n_out.name"), e("n_in.count", "n_out.count"), e("n_in.maybe", "n_out.maybe")],
      });

    it("applies defaults; optional inputs default to null", async () => {
      const { engine } = makeEngine();
      const result = await engine.run({ context: sig(), flowId: FLOW_ID, inputs: { name: "Aria" } }).result;
      expect(result.status).toBe("succeeded");
      expect(result.outputs).toEqual({ name: "Aria", count: 3, maybe: null });
    });

    async function invalid(inputs: Record<string, unknown>) {
      const { engine } = makeEngine();
      const run = engine.run({ context: sig(), flowId: FLOW_ID, inputs });
      const result = await run.result;
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("run.invalid_inputs");
      expect(trace(await collect(run))).toEqual(["run.started", "run.completed"]);
      return {
        error: result.error as { message: string },
        diagnostics: (result.error?.details as { diagnostics: { code: string; message: string; path: { valuePath?: string } }[] }).diagnostics,
      };
    }

    it("missing required input → value.invalid at inputs.<name>; singular message", async () => {
      const { error, diagnostics } = await invalid({});
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ code: "value.invalid", path: { valuePath: "inputs.name" } });
      expect(error.message).toBe(`Flow "Test flow" received 1 invalid input: ${diagnostics[0]?.message}`);
    });

    it("unknown key → value.invalid", async () => {
      const { diagnostics } = await invalid({ name: "Aria", bogus: 1 });
      expect(diagnostics.map((d) => [d.code, d.path.valuePath])).toEqual([["value.invalid", "inputs.bogus"]]);
    });

    it("wrong type and constraint violations; plural message", async () => {
      const { error, diagnostics } = await invalid({ name: "Too long name", count: -1 });
      expect(diagnostics.length).toBe(2);
      expect(diagnostics.every((d) => d.code.startsWith("value."))).toBe(true);
      expect(diagnostics.map((d) => d.path.valuePath)).toEqual(["inputs.name", "inputs.count"]);
      expect(error.message).toBe(`Flow "Test flow" received 2 invalid inputs. First: ${diagnostics[0]?.message}`);
      const wrong = await invalid({ name: 42 });
      expect(wrong.diagnostics[0]?.path.valuePath).toBe("inputs.name");
    });

    it("media inputs use media.* codes", async () => {
      const { engine } = makeEngine();
      const d = doc({ inputs: [{ name: "img", type: ir.image() }], outputs: [] });
      const result = await engine.run({ context: d, flowId: FLOW_ID, inputs: { img: { uri: "ftp://x/a.png", mime: "image/png" } } }).result;
      expect(result.error?.code).toBe("run.invalid_inputs");
      const diags = (result.error?.details as { diagnostics: { code: string; path: { valuePath?: string } }[] }).diagnostics;
      expect(diags[0]?.code).toBe("media.invalid_ref");
      expect(diags[0]?.path.valuePath?.startsWith("inputs.img")).toBe(true);
    });
  });

  it("a cycle that only appears with implicit variable edges → run.invalid_flow with flow.cycle", async () => {
    const { engine } = makeEngine();
    // variables.md example D.
    const d = doc({
      variables: [
        { id: "var_x", name: "x", type: ir.text(), access: "private", default: "x0" },
        { id: "var_y", name: "y", type: ir.text(), access: "private", default: "y0" },
      ],
      nodes: [
        n("n_gx", "briar.variable.get", { config: { variableId: "var_x" } }),
        n("n_sy", "briar.variable.set", { config: { variableId: "var_y" } }),
        n("n_gy", "briar.variable.get", { config: { variableId: "var_y" } }),
        n("n_sx", "briar.variable.set", { config: { variableId: "var_x" } }),
      ],
      edges: [e("n_gx.value", "n_sy.value"), e("n_gy.value", "n_sx.value")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.error?.code).toBe("run.invalid_flow");
    const diags = (result.error?.details as { diagnostics: { code: string }[] }).diagnostics;
    expect(diags.some((x) => x.code === "flow.cycle")).toBe(true);
  });

  it("the run works on its own copy: editing the document mid-run has no effect", async () => {
    const { engine } = makeEngine();
    const d = doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_w", "probe.wait")], edges: [e("n_w.value", "n_out.out")] });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    await started(run, "n_w");
    (d as { revision: number }).revision = 99;
    probe.release("n_w", "ok");
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    expect(result.contextRevision).toBe(1);
  });

  it("context without the run's flow nodes still reports contextRevision of the given document", async () => {
    const { engine } = makeEngine();
    const d: ContextDocument = { ...echoDoc(), revision: 12 };
    expect((await engine.run({ context: d, flowId: FLOW_ID, inputs: { topic: "a" } }).result).contextRevision).toBe(12);
  });
});

describe("cache option wiring", () => {
  it("createMemoryCache is usable as the engine cache", async () => {
    const cache = createMemoryCache({ maxEntries: 10 });
    const { engine } = makeEngine({ cache });
    await engine.run({ context: echoDoc(), flowId: FLOW_ID, inputs: { topic: "a" } }).result;
    expect(cache.size).toBe(1);
  });
});
