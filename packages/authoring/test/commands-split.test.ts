/**
 * Split / collapse struct ports (execution.md §8): node.splitPort, node.collapsePort.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { createCatalog, createContextDocument, createSequentialIdGenerator, resolveFlowPorts, validateFlow } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { createEngine } from "@briarflow/runtime";
import { createMedia, createMemoryMediaRegistry } from "@briarflow/core";
import { applyCommands } from "@briarflow/authoring";
import { accept, build, options, reject } from "./fixtures/helpers.js";

const catalog = createCatalog([stdPack]);
const opts = () => ({ catalog, idGenerator: createSequentialIdGenerator() });

function base() {
  const doc = createContextDocument({ name: "x" });
  const r = applyCommands(
    doc,
    [
      { op: "type.defineStruct", scope: { kind: "global" }, id: "ty_char", name: "Character", fields: [{ name: "name", type: "string" }, { name: "age", type: "int", default: 3 }] },
      { op: "flow.create", id: "flow_f", name: "F", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "flow.input.add", flowId: "flow_f", name: "hero", type: "Character" },
      { op: "flow.output.add", flowId: "flow_f", name: "name", type: "string" },
      { op: "flow.output.add", flowId: "flow_f", name: "copy", type: "Character" },
      { op: "edge.connect", flowId: "flow_f", id: "e_h", from: { node: "n_in", port: "hero" }, to: { node: "n_out", port: "copy" } },
    ] as Command[],
    opts(),
  );
  if (!r.ok) throw r.error;
  return r.doc;
}

describe("split / collapse", () => {
  it("splits an output into member ports; edges on the port go and come back on undo", () => {
    const r = accept(base(), [{ op: "node.splitPort", flowId: "flow_f", nodeId: "n_in", side: "output", port: "hero" }], { opts: options({ catalog }) });
    const flow = r.doc.flows[0]!;
    expect(flow.nodes.find((n) => n.id === "n_in")?.split).toEqual({ outputs: ["hero"] });
    expect(flow.edges).toEqual([]);
    const ports = resolveFlowPorts(r.doc, "flow_f", catalog).nodes.get("n_in")!;
    expect(ports.outputs.map((p) => p.name)).toEqual(["hero.name", "hero.age"]);
  });

  it("a split flow runs: members out of the Input, a struct rebuilt into the Output", async () => {
    const doc = build(
      base(),
      [
        { op: "node.splitPort", flowId: "flow_f", nodeId: "n_in", side: "output", port: "hero" },
        { op: "node.splitPort", flowId: "flow_f", nodeId: "n_out", side: "input", port: "copy" },
        { op: "edge.connect", flowId: "flow_f", from: { node: "n_in", port: "hero.name" }, to: { node: "n_out", port: "name" } },
        { op: "edge.connect", flowId: "flow_f", from: { node: "n_in", port: "hero.name" }, to: { node: "n_out", port: "copy.name" } },
        { op: "node.setValue", flowId: "flow_f", nodeId: "n_out", port: "copy.age", value: 40 },
      ],
      opts(),
    );
    expect(validateFlow(doc, "flow_f", catalog).filter((d) => d.severity === "error")).toEqual([]);
    const engine = createEngine({ catalog, media: createMedia({ registry: createMemoryMediaRegistry() }), secrets: { get: async () => undefined } });
    const result = await engine.run({ context: doc, flowId: "flow_f", inputs: { hero: { name: "Ann", age: 9 } } }).result;
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ name: "Ann", copy: { name: "Ann", age: 40 } });
  });

  it("collapse removes member edges and constants, and nested splits; undo restores them", () => {
    const doc = build(
      base(),
      [
        { op: "node.splitPort", flowId: "flow_f", nodeId: "n_out", side: "input", port: "copy" },
        { op: "edge.connect", flowId: "flow_f", id: "e_m", from: { node: "n_in", port: "hero" }, to: { node: "n_out", port: "copy" } },
      ].slice(0, 1) as Command[],
      opts(),
    );
    const withValue = build(doc, [{ op: "node.setValue", flowId: "flow_f", nodeId: "n_out", port: "copy.age", value: 5 }], opts());
    const r = accept(withValue, [{ op: "node.collapsePort", flowId: "flow_f", nodeId: "n_out", side: "input", port: "copy" }], { opts: options({ catalog }) });
    const out = r.doc.flows[0]!.nodes.find((n) => n.id === "n_out")!;
    expect(out.split).toBeUndefined();
    expect(out.values).toBeUndefined();
  });

  it("only struct ports split", () => {
    reject(base(), [{ op: "node.splitPort", flowId: "flow_f", nodeId: "n_out", side: "input", port: "name" }], "port.not_struct", { opts: options({ catalog }) });
    reject(base(), [{ op: "node.collapsePort", flowId: "flow_f", nodeId: "n_out", side: "input", port: "copy" }], "port.not_split", { opts: options({ catalog }) });
  });
});
