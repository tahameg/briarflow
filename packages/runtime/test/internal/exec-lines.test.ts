import { describe, expect, it } from "vitest";
import { createCatalog, validateFlow, type ExecEdge, type FlowDocument } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { collect, context, edge, field, flow, ir, node, testEngine, trace } from "./helpers.js";

let lineCounter = 0;
/** `line("a.then", "b")` → an execution line from a's output to b's `in`. */
function line(from: string, to: string): ExecEdge {
  const [fn, fp] = from.includes(".") ? (from.split(".") as [string, string]) : [from, "then"];
  lineCounter += 1;
  return { id: `x_${lineCounter}`, from: { node: fn, port: fp }, to: { node: to, port: "in" } };
}

function withLines(f: FlowDocument, lines: ExecEdge[]): FlowDocument {
  return { ...f, execEdges: lines };
}

const catalog = createCatalog([stdPack, mockPack]);

async function run(f: FlowDocument, inputs: Record<string, unknown> = {}) {
  const { engine } = testEngine({ packs: [stdPack, mockPack] });
  const r = engine.run({ context: context([f]), flowId: f.id, inputs });
  const events = await collect(r.events());
  return { result: await r.result, events, started: trace(events).filter((t) => t.startsWith("node.started")).map((t) => t.split(":")[1]) };
}

describe("execution lines", () => {
  it("runs the line in order, pulls pure nodes when needed and leaves other nodes alone", async () => {
    const f = withLines(
      flow({
        inputs: [field("topic", ir.text())],
        outputs: [field("reply", ir.text())],
        nodes: [
          node("n_tpl", "text.template", { config: { template: "About {{t}}" } }),
          node("n_llm", "mock.llm"),
          node("n_off", "mock.llm", { values: { prompt: "never" } }),
        ],
        edges: [edge("n_in.topic", "n_tpl.t"), edge("n_tpl.text", "n_llm.prompt"), edge("n_llm.text", "n_out.reply")],
      }),
      [line("n_in", "n_llm"), line("n_llm", "n_out")],
    );
    expect(validateFlow(context([f]), f.id, catalog).filter((d) => d.severity === "error")).toEqual([]);
    const { result, started } = await run(f, { topic: "rain" });
    expect(result.status).toBe("succeeded");
    expect(started).toEqual(["n_in", "n_tpl", "n_llm", "n_out"]);
    expect(String(result.outputs?.reply)).toContain("About rain");
  });

  it("takes the failed line when a node fails, with the reason on its error output", async () => {
    const f = withLines(
      flow({
        outputs: [field("why", ir.text())],
        nodes: [node("n_fail", "mock.fail", { values: { message: "no luck" } }), node("n_brk", "briar.error.break")],
        edges: [edge("n_fail.error", "n_brk.error"), edge("n_brk.message", "n_out.why")],
      }),
      [line("n_in", "n_fail"), line("n_fail.failed", "n_out")],
    );
    const { result, events } = await run(f);
    expect(result.status).toBe("succeeded");
    expect(result.outputs).toEqual({ why: "no luck" });
    expect(trace(events)).toContain("node.failed:n_fail");
  });

  it("fails the run when a failure has no failed line, and skips nothing it never reached", async () => {
    const f = withLines(flow({ nodes: [node("n_fail", "mock.fail"), node("n_llm", "mock.llm", { values: { prompt: "x" } })] }), [
      line("n_in", "n_fail"),
      line("n_fail", "n_llm"),
      line("n_llm", "n_out"),
    ]);
    const { result, events } = await run(f);
    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "run.node_failed", nodeId: "n_fail" });
    expect(trace(events).filter((t) => t.includes("n_llm") || t.includes("n_out"))).toEqual([]);
  });

  it("fails with run.output_not_reached when the line ends before Output", async () => {
    const f = withLines(
      flow({ outputs: [field("x", ir.text())], nodes: [node("n_llm", "mock.llm", { values: { prompt: "p" } })], edges: [edge("n_llm.text", "n_out.x")] }),
      [line("n_in", "n_llm")],
    );
    const { result } = await run(f);
    expect(result.error?.code).toBe("run.output_not_reached");
  });

  it("reads variables as written so far along the line", async () => {
    const f = withLines(
      flow({
        outputs: [field("before", ir.text()), field("after", ir.text())],
        variables: [{ id: "var_x", name: "x", type: ir.text(), access: "private", default: "a" }],
        nodes: [
          node("n_set", "briar.variable.set", { config: { variableId: "var_x" }, values: { value: "b" } }),
          node("n_get", "briar.variable.get", { config: { variableId: "var_x" } }),
        ],
        edges: [edge("n_get.value", "n_out.after"), edge("n_set.value", "n_out.before")],
      }),
      [line("n_in", "n_set"), line("n_set", "n_out")],
    );
    const { result } = await run(f);
    expect(result.outputs).toEqual({ before: "b", after: "b" });
  });
});

describe("validation with execution lines", () => {
  const base = (lines: ExecEdge[]) =>
    withLines(
      flow({
        outputs: [field("reply", ir.text())],
        nodes: [node("n_a", "mock.llm", { values: { prompt: "a" } }), node("n_b", "mock.llm"), node("n_lost", "mock.llm")],
        edges: [edge("n_a.text", "n_out.reply")],

      }),
      lines,
    );
  const codes = (f: FlowDocument) => validateFlow(context([f]), f.id, catalog).map((d) => d.code);

  it("does not report problems of nodes off the line", () => {
    // n_b and n_lost miss their required prompt, but they never run.
    expect(codes(base([line("n_in", "n_a"), line("n_a", "n_out")]))).toEqual([]);
  });

  it("reports values that are not ready, loops, and an unreachable Output", () => {
    expect(codes(base([line("n_in", "n_out")]))).toContain("exec.value_unavailable");
    expect(codes(base([line("n_in", "n_a"), line("n_a", "n_b"), line("n_b", "n_a")]))).toContain("exec.cycle");
    const lost = validateFlow(context([base([line("n_in", "n_a")])]), "flow_t", catalog).find((d) => d.code === "exec.output_unreachable");
    expect(lost?.severity).toBe("warning");
    expect(codes(base([line("n_in.then", "n_a"), line("n_in.then", "n_b")]))).toContain("exec.duplicate_output");
  });
});
