import { beforeEach, describe, expect, it } from "vitest";
import type { FlowVariable, GlobalVariable, RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { collect, context, edge, field, flow, ir, node, testEngine } from "./helpers.js";
import { probe, tkPack } from "./tk-pack.js";

const packs = [stdPack, mockPack, tkPack];
beforeEach(() => probe.reset());

const v = (id: string, name: string, type: ReturnType<typeof ir.text>, access: "public" | "private", extra: Partial<FlowVariable> = {}): FlowVariable => ({
  id,
  name,
  type,
  access,
  ...extra,
});

async function exec(doc: ReturnType<typeof context>, inputs: Record<string, unknown> = {}) {
  const { engine } = testEngine({ packs });
  const run = engine.run({ context: doc, flowId: "flow_t", inputs });
  const [result, events] = await Promise.all([run.result, collect(run.events())]);
  return { result, events, engine };
}

describe("flow variables (variables.md §4, §6, §7)", () => {
  it("example A: a get waits for the set and reads its value", async () => {
    const doc = context([
      flow({
        inputs: [field("topic", ir.text())],
        outputs: [field("summary", ir.text())],
        variables: [v("var_sum", "summary", ir.text(), "public")],
        nodes: [node("n_set", "briar.variable.set", { config: { variableId: "var_sum" } }), node("n_get", "briar.variable.get", { config: { variableId: "var_sum" } })],
        edges: [edge("n_in.topic", "n_set.value"), edge("n_get.value", "n_out.summary")],
      }),
    ]);
    const { result, events } = await exec(doc, { topic: "cats" });
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ summary: "cats" });
    expect(result.variables).toEqual({ summary: "cats" });
    const order = events.filter((e) => e.type === "node.completed").map((e) => (e as { nodeId: string }).nodeId);
    expect(order.indexOf("n_set")).toBeLessThan(order.indexOf("n_get"));
  });

  it("example B: a get upstream of the set reads the starting value; final value is the written one", async () => {
    const doc = context([
      flow({
        outputs: [field("before", ir.int()), field("after", ir.int())],
        variables: [v("var_c", "count", ir.int(), "public", { default: 5 }), v("var_p", "notes", ir.list(ir.text()), "private")],
        nodes: [
          node("n_get1", "briar.variable.get", { config: { variableId: "var_c" } }),
          node("n_add", "tk.addOne"),
          node("n_set", "briar.variable.set", { config: { variableId: "var_c" } }),
          node("n_get2", "briar.variable.get", { config: { variableId: "var_c" } }),
          node("n_notes", "briar.variable.get", { config: { variableId: "var_p" } }),
          node("n_len", "list.length"),
          node("n_sink", "tk.num"),
        ],
        edges: [
          edge("n_get1.value", "n_add.value"),
          edge("n_add.value", "n_set.value"),
          edge("n_get1.value", "n_out.before"),
          edge("n_get2.value", "n_out.after"),
          edge("n_notes.value", "n_len.list"),
          edge("n_len.length", "n_sink.n"),
        ],
      }),
    ]);
    const { result, events } = await exec(doc);
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ before: 5, after: 6 });
    expect(result.variables).toEqual({ count: 6 });
    const lenOut = events.find((e): e is Extract<RunEvent, { type: "node.completed" }> => e.type === "node.completed" && e.nodeId === "n_len");
    expect(lenOut?.outputs).toEqual({ length: 0 });
  });

  it("set validates the value against the variable type", async () => {
    const doc = context([
      flow({
        variables: [v("var_n", "n", ir.int({ min: 0 }), "public", { default: 0 })],
        nodes: [node("n_num", "tk.num", { values: { n: -1 } }), node("n_set", "briar.variable.set", { config: { variableId: "var_n" } })],
        edges: [edge("n_num.value", "n_set.value")],
      }),
    ]);
    const { result } = await exec(doc);
    expect(result.error?.cause).toMatchObject({ code: "node.invalid_input", nodeId: "n_set" });
    expect(result.variables).toBeUndefined();
  });

  it("gets ordered after a skipped writer are skipped too", async () => {
    const doc = context([
      flow({
        outputs: [field("x", ir.text())],
        variables: [v("var_x", "x", ir.text(), "public", { default: "start" })],
        nodes: [
          node("n_fail", "tk.fail"),
          node("n_set", "briar.variable.set", { config: { variableId: "var_x" } }),
          node("n_get", "briar.variable.get", { config: { variableId: "var_x" } }),
        ],
        edges: [edge("n_fail.value", "n_set.value"), edge("n_get.value", "n_out.x")],
      }),
    ]);
    const { result, events } = await exec(doc);
    expect(result.status).toBe("failed");
    const skipped = events.filter((e) => e.type === "node.skipped").map((e) => [(e as { nodeId: string }).nodeId, (e as { cause?: string }).cause]);
    expect(skipped).toEqual([
      ["n_set", "n_fail"],
      ["n_get", "n_fail"],
      ["n_out", "n_fail"],
    ]);
  });

  it("public variables never written report their starting value; unset ones are omitted", async () => {
    const doc = context([
      flow({
        variables: [
          v("var_a", "a", ir.text(), "public", { default: "x" }),
          v("var_b", "b", ir.text(), "public"),
          v("var_c", "c", ir.optional(ir.text()), "public"),
          v("var_d", "d", ir.text(), "private", { default: "hidden" }),
        ],
      }),
    ]);
    const { result } = await exec(doc);
    expect(result.variables).toEqual({ a: "x", c: null });
  });
});

describe("globals (variables.md §6, §8)", () => {
  const globals: GlobalVariable[] = [
    { id: "gv_brand", name: "brand", type: ir.text(), access: "readonly", value: "Pastel" },
    { id: "gv_count", name: "counter", type: ir.int(), access: "readwrite", value: 1 },
    { id: "gv_other", name: "other", type: ir.int(), access: "readwrite", value: 2 },
  ];

  it("reads the snapshot, writes through set nodes, reports globalWrites", async () => {
    const doc = context(
      [
        flow({
          outputs: [field("brand", ir.text()), field("before", ir.int()), field("after", ir.int())],
          nodes: [
            node("n_brand", "briar.global.get", { config: { globalId: "gv_brand" } }),
            node("n_get", "briar.global.get", { config: { globalId: "gv_count" } }),
            node("n_add", "tk.addOne"),
            node("n_set", "briar.global.set", { config: { globalId: "gv_count" } }),
            node("n_get2", "briar.global.get", { config: { globalId: "gv_count" } }),
          ],
          edges: [
            edge("n_brand.value", "n_out.brand"),
            edge("n_get.value", "n_add.value"),
            edge("n_add.value", "n_set.value"),
            edge("n_get.value", "n_out.before"),
            edge("n_get2.value", "n_out.after"),
          ],
        }),
      ],
      { globals },
    );
    const { result } = await exec(doc);
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ brand: "Pastel", before: 1, after: 2 });
    expect(result.globalWrites).toEqual({ counter: 2 });
  });

  it("ctx.globals/ctx.variables return run-start values and disable caching for that execution", async () => {
    const doc = context(
      [
        flow({
          outputs: [field("v", ir.text())],
          variables: [v("var_c", "count", ir.int(), "public", { default: 5 })],
          nodes: [node("n_r", "tk.readState", { values: { global: "brand", variable: "count" } }), node("n_set", "briar.variable.set", { config: { variableId: "var_c" }, values: { value: 9 } })],
          edges: [edge("n_r.value", "n_out.v")],
        }),
      ],
      { globals },
    );
    const { engine } = testEngine({ packs });
    const r1 = await engine.run({ context: doc, flowId: "flow_t" }).result;
    const r2 = await engine.run({ context: doc, flowId: "flow_t" }).result;
    expect(r1.outputs).toEqual({ v: "Pastel|5" });
    expect(r1.variables).toEqual({ count: 9 });
    expect(r2.outputs).toEqual(r1.outputs);
    expect(probe.runCalls).toBe(2);
  });

  it("unknown names throw variable.unknown", async () => {
    const doc = context(
      [flow({ nodes: [node("n_r", "tk.readState", { values: { global: "nope", variable: "count" } })] })],
      { globals },
    );
    const { result } = await exec(doc);
    expect(result.error?.cause).toMatchObject({ code: "variable.unknown", nodeId: "n_r" });
  });
});
