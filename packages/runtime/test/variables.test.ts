/**
 * variables.md §4–§8, runtime.md §3.1, phase-3.md §4.7: Get/Set semantics, ordering examples
 * A–D, starting values, RunResult.variables / globalWrites, ctx.globals / ctx.variables.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { ir, kitPack, VARIABLES_FLOW_ID, variablesContext } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, ofNode, probe, probePack, started } from "./support.js";

beforeEach(() => probe.reset());

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;
const packs = () => [stdPack, mockPack, probePack, kitPack()];

function completedValue(events: RunEvent[], nodeId: string): unknown {
  const done = ofNode(events, nodeId).find((x) => x.type === "node.completed") as Ev<"node.completed"> | undefined;
  return done?.outputs["value"];
}

describe("variables.md examples", () => {
  it("A: the get waits for the set (implicit edge) and reads what it wrote", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const run = engine.run({ context: variablesContext("A"), flowId: VARIABLES_FLOW_ID, inputs: { topic: "cats" } });
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ summary: "cats" });
    expect(result.variables).toEqual({}); // summary is private
    const events = await collect(run);
    const setDone = events.find((x) => x.type === "node.completed" && x.nodeId === "n_set")!;
    const getStart = events.find((x) => x.type === "node.started" && x.nodeId === "n_get")!;
    expect(setDone.seq).toBeLessThan(getStart.seq);
    // engine-executed: started attempt 1, completed not cached
    expect(ofNode(events, "n_get")[0]).toMatchObject({ attempt: 1 });
    expect((ofNode(events, "n_set").at(-1) as Ev<"node.completed">).cached).toBe(false);
  });

  it("B: a get upstream of the set reads the default; the public final value is default + 1", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const run = engine.run({ context: variablesContext("B"), flowId: VARIABLES_FLOW_ID });
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    expect(result.variables).toEqual({ count: 1 });
    const events = await collect(run);
    expect(completedValue(events, "n_get")).toBe(0);
    expect(completedValue(events, "n_set")).toBe(1);
  });

  it("C: unordered writes → run.invalid_flow (variable.unordered_writes)", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const result = await engine.run({ context: variablesContext("C"), flowId: VARIABLES_FLOW_ID, inputs: { a: "1", b: "2" } }).result;
    expect(result.error?.code).toBe("run.invalid_flow");
    const codes = (result.error?.details as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
    expect(codes).toContain("variable.unordered_writes");
  });

  it("D: a cycle through implicit edges → run.invalid_flow (flow.cycle)", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const run = engine.run({ context: variablesContext("D"), flowId: VARIABLES_FLOW_ID });
    const result = await run.result;
    expect(result.error?.code).toBe("run.invalid_flow");
    const codes = (result.error?.details as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code);
    expect(codes).toContain("flow.cycle");
    expect((await collect(run)).map((x) => x.type)).toEqual(["run.started", "run.completed"]);
  });
});

describe("Get / Set", () => {
  it("chained writers: each get reads the last writer ordered before it", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = doc({
      outputs: [
        { name: "early", type: ir.text() },
        { name: "late", type: ir.text() },
      ],
      variables: [{ id: "var_x", name: "x", type: ir.text(), access: "public", default: "start" }],
      nodes: [
        n("n_get0", "briar.variable.get", { config: { variableId: "var_x" } }),
        n("n_set1", "briar.variable.set", { config: { variableId: "var_x" }, values: { value: "one" } }),
        n("n_tpl", "text.template", { config: { template: "{a}-two" } }),
        n("n_set2", "briar.variable.set", { config: { variableId: "var_x" } }),
        n("n_get2", "briar.variable.get", { config: { variableId: "var_x" } }),
      ],
      edges: [
        e("n_get0.value", "n_out.early"),
        e("n_get0.value", "n_set1.value"),
        e("n_set1.value", "n_tpl.a"),
        e("n_tpl.text", "n_set2.value"),
        e("n_get2.value", "n_out.late"),
      ],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ early: "start", late: "start-two" });
    expect(result.variables).toEqual({ x: "start-two" });
  });

  it("starting values: default, null for optional, [] for list; unset public variables are omitted", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = doc({
      outputs: [
        { name: "opt", type: ir.optional(ir.text()) },
        { name: "list", type: ir.list(ir.text()) },
      ],
      variables: [
        { id: "var_d", name: "withDefault", type: ir.int(), access: "public", default: 7 },
        { id: "var_o", name: "opt", type: ir.optional(ir.text()), access: "public" },
        { id: "var_l", name: "list", type: ir.list(ir.text()), access: "public" },
        { id: "var_u", name: "unset", type: ir.text(), access: "public" },
        { id: "var_p", name: "hidden", type: ir.text(), access: "private", default: "p" },
      ],
      nodes: [
        n("n_go", "briar.variable.get", { config: { variableId: "var_o" } }),
        n("n_gl", "briar.variable.get", { config: { variableId: "var_l" } }),
        n("n_gp", "briar.variable.get", { config: { variableId: "var_p" } }),
        n("n_gd", "briar.variable.get", { config: { variableId: "var_d" } }),
      ],
      edges: [e("n_go.value", "n_out.opt"), e("n_gl.value", "n_out.list")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ opt: null, list: [] });
    expect(result.variables).toEqual({ withDefault: 7, opt: null, list: [] });
  });

  it("Set validates against the variable type: node.invalid_input; downstream gets are skipped", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = doc({
      inputs: [{ name: "n", type: ir.int() }],
      variables: [{ id: "var_x", name: "x", type: ir.int({ min: 0 }), access: "public", default: 0 }],
      nodes: [
        n("n_set", "briar.variable.set", { config: { variableId: "var_x" } }),
        n("n_get", "briar.variable.get", { config: { variableId: "var_x" } }),
      ],
      edges: [e("n_in.n", "n_set.value")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID, inputs: { n: -3 } });
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.variables).toBeUndefined();
    const events = await collect(run);
    const fail = events.find((x) => x.type === "node.failed") as Ev<"node.failed">;
    expect(fail.nodeId).toBe("n_set");
    expect(fail.error.code).toBe("node.invalid_input");
    expect(ofNode(events, "n_get")).toEqual([expect.objectContaining({ type: "node.skipped", reason: "upstream_failed", cause: "n_set" })]);
  });

  it("variable nodes are never retried and never take a concurrency slot", async () => {
    const { engine } = makeEngine({ packs: packs(), concurrency: 1 });
    const d = doc({
      outputs: [{ name: "out", type: ir.text() }],
      variables: [{ id: "var_x", name: "x", type: ir.text(), access: "private", default: "v" }],
      nodes: [n("n_w", "probe.wait"), n("n_get", "briar.variable.get", { config: { variableId: "var_x" } })],
      edges: [e("n_get.value", "n_out.out")],
    });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    await started(run, "n_w");
    const events: RunEvent[] = [];
    for await (const ev of run.events()) {
      events.push(ev);
      if (ev.type === "node.completed" && ev.nodeId === "n_out") break;
    }
    expect(completedValue(events, "n_get")).toBe("v");
    probe.release("n_w");
    await run.result;
  });
});

describe("globals", () => {
  const globalsDoc = () =>
    doc({
      globals: [
        { id: "gv_style", name: "style", type: ir.text(), access: "readonly", value: "noir" },
        { id: "gv_count", name: "count", type: ir.int(), access: "readwrite", value: 1 },
        { id: "gv_never", name: "untouched", type: ir.text(), access: "readwrite", value: "same" },
      ],
      outputs: [
        { name: "before", type: ir.int() },
        { name: "after", type: ir.int() },
        { name: "style", type: ir.text() },
      ],
      nodes: [
        n("n_gstyle", "briar.global.get", { config: { globalId: "gv_style" } }),
        n("n_gbefore", "briar.global.get", { config: { globalId: "gv_count" } }),
        n("n_add", "kit.addOne"),
        n("n_set", "briar.global.set", { config: { globalId: "gv_count" } }),
        n("n_gafter", "briar.global.get", { config: { globalId: "gv_count" } }),
      ],
      edges: [
        e("n_gbefore.value", "n_add.value"),
        e("n_add.value", "n_set.value"),
        e("n_gbefore.value", "n_out.before"),
        e("n_gafter.value", "n_out.after"),
        e("n_gstyle.value", "n_out.style"),
      ],
    });

  it("get reads the snapshot or the last writer; globalWrites has every executed writer's global", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const result = await engine.run({ context: globalsDoc(), flowId: FLOW_ID }).result;
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ before: 1, after: 2, style: "noir" });
    expect(result.globalWrites).toEqual({ count: 2 });
    expect(result.variables).toEqual({});
  });

  it("the engine never touches the document: globals keep their stored values", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = globalsDoc();
    const before = structuredClone(d);
    await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(d).toEqual(before);
    // A second run on the same document starts from the same snapshot.
    expect((await engine.run({ context: d, flowId: FLOW_ID }).result).globalWrites).toEqual({ count: 2 });
  });

  it("globalWrites is omitted on failed runs", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = structuredClone(globalsDoc()) as ReturnType<typeof globalsDoc> & { flows: { nodes: unknown[] }[] };
    d.flows[0]!.nodes.push(n("n_f", "mock.fail"));
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.status).toBe("failed");
    expect(result.globalWrites).toBeUndefined();
    expect(result.outputs).toBeUndefined();
  });
});

describe("ctx.globals / ctx.variables", () => {
  it("return run-start values, never mid-run writes", async () => {
    const { engine } = makeEngine({ packs: packs() });
    // The set nodes run first (their outputs feed n_s), yet n_s sees the run-start values.
    const d = doc({
      globals: [{ id: "gv_g", name: "g", type: ir.text(), access: "readwrite", value: "snapshot" }],
      variables: [{ id: "var_v", name: "v", type: ir.text(), access: "private", default: "default" }],
      outputs: [{ name: "out", type: ir.text() }],
      nodes: [
        n("n_setg", "briar.global.set", { config: { globalId: "gv_g" }, values: { value: "g" } }),
        n("n_setv", "briar.variable.set", { config: { variableId: "var_v" }, values: { value: "v" } }),
        n("n_s", "probe.state"),
      ],
      edges: [e("n_setg.value", "n_s.global"), e("n_setv.value", "n_s.variable"), e("n_s.value", "n_out.out")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.outputs).toEqual({ out: JSON.stringify(["snapshot", "default"]) });
    expect(result.globalWrites).toEqual({ g: "g" });
  });

  it("list variables without default start as [], optional ones as null", async () => {
    const { engine } = makeEngine({ packs: packs() });
    const d = doc({
      variables: [
        { id: "var_l", name: "l", type: ir.list(ir.int()), access: "private" },
        { id: "var_o", name: "o", type: ir.optional(ir.int()), access: "private" },
      ],
      outputs: [
        { name: "l", type: ir.text() },
        { name: "o", type: ir.text() },
      ],
      nodes: [
        n("n_l", "probe.state", { values: { variable: "l" } }),
        n("n_o", "probe.state", { values: { variable: "o" } }),
        n("n_gl", "briar.variable.get", { config: { variableId: "var_l" } }),
        n("n_go", "briar.variable.get", { config: { variableId: "var_o" } }),
      ],
      edges: [e("n_l.value", "n_out.l"), e("n_o.value", "n_out.o")],
    });
    const result = await engine.run({ context: d, flowId: FLOW_ID }).result;
    expect(result.outputs).toEqual({ l: "[[]]", o: "[null]" });
  });

  it("unknown names throw NodeError variable.unknown (the node fails with that code)", async () => {
    const { engine } = makeEngine({ packs: packs() });
    for (const values of [{ global: "nope" }, { variable: "nope" }]) {
      const run = engine.run({ context: doc({ nodes: [n("n_s", "probe.state", { values })] }), flowId: FLOW_ID });
      const result = await run.result;
      expect(result.error?.cause?.code).toBe("variable.unknown");
      expect(result.error?.cause?.nodeId).toBe("n_s");
    }
  });
});
