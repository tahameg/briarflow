/**
 * Flow control along execution lines (execution.md §7): Branch, Switch, For each, For range.
 */
import { describe, expect, it } from "vitest";
import { createCatalog, validateFlow, type ExecEdge, type FlowDocument } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { collect, context, edge, field, flow, ir, node, testEngine, trace } from "./helpers.js";

let n = 0;
/** `line("a.true", "b")` → an execution line from a's output to b's `in` (default output `then`). */
function line(from: string, to: string): ExecEdge {
  const [fn, fp] = from.includes(".") ? (from.split(".") as [string, string]) : [from, "then"];
  n += 1;
  return { id: `x_${n}`, from: { node: fn, port: fp }, to: { node: to, port: "in" } };
}
const withLines = (f: FlowDocument, lines: ExecEdge[]): FlowDocument => ({ ...f, execEdges: lines });
const catalog = createCatalog([stdPack, mockPack]);
const errors = (f: FlowDocument) => validateFlow(context([f]), f.id, catalog).filter((d) => d.severity === "error");

async function run(f: FlowDocument, inputs: Record<string, unknown> = {}) {
  const { engine } = testEngine({ packs: [stdPack, mockPack] });
  const r = engine.run({ context: context([f]), flowId: f.id, inputs });
  const events = await collect(r.events());
  return { result: await r.result, events, r };
}

const set = (id: string, variableId: string, values?: Record<string, unknown>) => node(id, "briar.variable.set", { config: { variableId }, ...(values ? { values } : {}) });
const get = (id: string, variableId: string) => node(id, "briar.variable.get", { config: { variableId } });

describe("Branch", () => {
  const f = withLines(
    flow({
      inputs: [field("flag", ir.int())],
      outputs: [field("answer", ir.string())],
      variables: [{ id: "var_a", name: "a", type: ir.string(), access: "private", default: "" }],
      nodes: [node("n_br", "briar.branch"), set("n_yes", "var_a", { value: "yes" }), set("n_no", "var_a", { value: "no" }), get("n_get", "var_a")],
      edges: [edge("n_in.flag", "n_br.condition"), edge("n_get.value", "n_out.answer")],
    }),
    [line("n_in", "n_br"), line("n_br.true", "n_yes"), line("n_br.false", "n_no"), line("n_yes", "n_out"), line("n_no", "n_out")],
  );

  it("follows true or false by the condition's truth; paths meet again", async () => {
    expect(errors(f)).toEqual([]);
    expect((await run(f, { flag: 3 })).result.outputs).toEqual({ answer: "yes" });
    const off = await run(f, { flag: 0 });
    expect(off.result.outputs).toEqual({ answer: "no" });
    expect(trace(off.events)).not.toContain("node.started:n_yes");
  });

  it("a value from one side is not available after the paths meet", () => {
    const bad = withLines({ ...f, edges: [edge("n_in.flag", "n_br.condition"), edge("n_yes.value", "n_out.answer")] }, [...(f.execEdges ?? [])]);
    expect(errors(bad).map((d) => d.code)).toContain("exec.value_unavailable");
  });
});

describe("Switch", () => {
  it("follows the case the value equals, else default", async () => {
    const f = withLines(
      flow({
        inputs: [field("mode", ir.string())],
        outputs: [field("answer", ir.string())],
        variables: [{ id: "var_a", name: "a", type: ir.string(), access: "private", default: "" }],
        nodes: [node("n_sw", "briar.switch", { config: { cases: "fast\nslow" } }), set("n_f", "var_a", { value: "F" }), set("n_d", "var_a", { value: "D" }), get("n_get", "var_a")],
        edges: [edge("n_in.mode", "n_sw.value"), edge("n_get.value", "n_out.answer")],
      }),
      [line("n_in", "n_sw"), line("n_sw.fast", "n_f"), line("n_sw.default", "n_d"), line("n_f", "n_out"), line("n_d", "n_out")],
    );
    expect(errors(f)).toEqual([]);
    expect((await run(f, { mode: "fast" })).result.outputs).toEqual({ answer: "F" });
    expect((await run(f, { mode: "other" })).result.outputs).toEqual({ answer: "D" });
    // "slow" has no line: the line ends there, before Output.
    expect((await run(f, { mode: "slow" })).result.error?.code).toBe("run.output_not_reached");
  });

  it("an enum's members are its cases", () => {
    const f = withLines(
      flow({ nodes: [node("n_sw", "briar.switch", { config: { type: ir.named("ty_mood") } })] }),
      [line("n_in", "n_sw"), line("n_sw.happy", "n_out")],
    );
    const doc = context([f], { types: [{ kind: "enum", id: "ty_mood", name: "Mood", members: [{ value: "happy" }, { value: "sad" }] }] });
    expect(validateFlow(doc, f.id, catalog).filter((d) => d.severity === "error")).toEqual([]);
    const wrong = withLines(f, [line("n_in", "n_sw"), line("n_sw.angry", "n_out")]);
    expect(validateFlow(context([wrong], { types: [...doc.types] }), f.id, catalog).map((d) => d.code)).toContain("exec.unknown_port");
  });
});

describe("For each", () => {
  const acc = (lines: ExecEdge[], extra: Partial<Parameters<typeof flow>[0]> = {}) =>
    withLines(
      flow({
        inputs: [field("names", ir.list(ir.string()))],
        outputs: [field("all", ir.string())],
        variables: [{ id: "var_acc", name: "acc", type: ir.string(), access: "private", default: "" }],
        nodes: [
          node("n_loop", "briar.forEach"),
          node("n_tpl", "text.template", { config: { template: "{{a}}{{i}}:{{b}};" } }),
          get("n_cur", "var_acc"),
          set("n_set", "var_acc"),
          get("n_end", "var_acc"),
        ],
        edges: [
          edge("n_in.names", "n_loop.list"),
          edge("n_cur.value", "n_tpl.a"),
          edge("n_loop.index", "n_tpl.i"),
          edge("n_loop.item", "n_tpl.b"),
          edge("n_tpl.text", "n_set.value"),
          edge("n_end.value", "n_out.all"),
        ],
        ...extra,
      }),
      lines,
    );
  const lines = () => [line("n_in", "n_loop"), line("n_loop.body", "n_set"), line("n_loop.completed", "n_out")];

  it("runs the body once per item with the item and index, then completed", async () => {
    const f = acc(lines());
    expect(errors(f)).toEqual([]);
    const { result, events } = await run(f, { names: ["ann", "bo", "cy"] });
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ all: "0:ann;1:bo;2:cy;" });
    expect(trace(events).filter((t) => t === "node.started:n_set")).toHaveLength(3);
    expect(trace(events).filter((t) => t === "node.completed:n_loop")).toHaveLength(1);
  });

  it("an empty list skips the body", async () => {
    const { result, events } = await run(acc(lines()), { names: [] });
    expect(result.outputs).toEqual({ all: "" });
    expect(trace(events)).not.toContain("node.started:n_set");
  });

  it("a failure in the body stops the loop and the run", async () => {
    const f = withLines(
      flow({
        inputs: [field("names", ir.list(ir.string()))],
        nodes: [node("n_loop", "briar.forEach"), node("n_fail", "mock.fail")],
        edges: [edge("n_in.names", "n_loop.list")],
      }),
      [line("n_in", "n_loop"), line("n_loop.body", "n_fail"), line("n_loop.completed", "n_out")],
    );
    const { result, events } = await run(f, { names: ["a", "b"] });
    expect(result.status).toBe("failed");
    expect(trace(events).filter((t) => t === "node.started:n_fail")).toHaveLength(1);
    const loopFailed = events.find((e) => e.type === "node.failed" && "nodeId" in e && e.nodeId === "n_loop");
    expect(loopFailed && "error" in loopFailed ? loopFailed.error.code : undefined).toBe("loop.body_failed");
  });

  it("validation: loop values only inside the body; the body must not leak", () => {
    const outside = acc(lines(), {
      edges: [edge("n_in.names", "n_loop.list"), edge("n_loop.item", "n_out.all"), edge("n_cur.value", "n_tpl.a"), edge("n_tpl.text", "n_set.value")],
    });
    expect(errors(outside).map((d) => d.code)).toContain("exec.loop_value_outside");
    const leak = acc([line("n_in", "n_loop"), line("n_loop.body", "n_set"), line("n_set", "n_out")]);
    expect(errors(leak).map((d) => d.code)).toContain("exec.loop_escape");
  });
});

describe("For range and nesting", () => {
  it("nested loops run the inner body for every outer iteration", async () => {
    const f = withLines(
      flow({
        outputs: [field("all", ir.string())],
        variables: [{ id: "var_acc", name: "acc", type: ir.string(), access: "private", default: "" }],
        nodes: [
          node("n_outer", "briar.forRange", { values: { first: 1, last: 2 } }),
          node("n_inner", "briar.forRange", { values: { first: 0, last: 1 } }),
          node("n_tpl", "text.template", { config: { template: "{{a}}{{o}}{{i}} " } }),
          get("n_cur", "var_acc"),
          set("n_set", "var_acc"),
          get("n_end", "var_acc"),
        ],
        edges: [
          edge("n_cur.value", "n_tpl.a"),
          edge("n_outer.index", "n_tpl.o"),
          edge("n_inner.index", "n_tpl.i"),
          edge("n_tpl.text", "n_set.value"),
          edge("n_end.value", "n_out.all"),
        ],
      }),
      [line("n_in", "n_outer"), line("n_outer.body", "n_inner"), line("n_inner.body", "n_set"), line("n_outer.completed", "n_out")],
    );
    expect(errors(f)).toEqual([]);
    const { result } = await run(f);
    expect(result.outputs).toEqual({ all: "10 11 20 21 " });
  });

  it("cancelling during a loop ends it cancelled", async () => {
    const f = withLines(
      flow({
        nodes: [node("n_loop", "briar.forRange", { values: { first: 1, last: 50 } }), node("n_wait", "mock.delay", { values: { ms: 20 } })],
        edges: [edge("n_loop.index", "n_wait.value")],
      }),
      [line("n_in", "n_loop"), line("n_loop.body", "n_wait"), line("n_loop.completed", "n_out")],
    );
    const { engine } = testEngine({ packs: [stdPack, mockPack] });
    const r = engine.run({ context: context([f]), flowId: f.id, inputs: {} });
    setTimeout(() => r.cancel(), 30);
    const result = await r.result;
    expect(result.status).toBe("cancelled");
    const events = await collect(r.events());
    expect(trace(events)).toContain("node.failed:n_loop");
  });
});
