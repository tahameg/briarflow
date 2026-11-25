/**
 * Execution lines of flow control nodes in commands (execution.md §7).
 */
import { describe, expect, it } from "vitest";
import { createCatalog, createCatalogFromDescriptors, execPortsOf } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { applyCommands } from "@briarflow/authoring";
import { createContextDocument, createSequentialIdGenerator } from "@briarflow/core";

const catalog = createCatalog([stdPack]);

function setup() {
  const doc = createContextDocument({ name: "x" });
  const r = applyCommands(
    doc,
    [
      { op: "flow.create", id: "flow_f", name: "F", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "node.add", flowId: "flow_f", id: "n_sw", type: "briar.switch", position: { x: 100, y: 0 }, config: { cases: "red\nblue" } },
      { op: "node.add", flowId: "flow_f", id: "n_loop", type: "briar.forEach", position: { x: 200, y: 0 } },
    ],
    { catalog, idGenerator: createSequentialIdGenerator() },
  );
  if (!r.ok) throw r.error;
  return r.doc;
}

describe("exec.connect on flow control nodes", () => {
  it("accepts a Switch's case outputs from its config and a loop's body / completed", () => {
    const r = applyCommands(
      setup(),
      [
        { op: "exec.connect", flowId: "flow_f", from: { node: "n_in", port: "then" }, to: { node: "n_sw", port: "in" } },
        { op: "exec.connect", flowId: "flow_f", from: { node: "n_sw", port: "blue" }, to: { node: "n_loop", port: "in" } },
        { op: "exec.connect", flowId: "flow_f", from: { node: "n_loop", port: "completed" }, to: { node: "n_out", port: "in" } },
      ],
      { catalog, idGenerator: createSequentialIdGenerator() },
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a case the Switch does not have", () => {
    const r = applyCommands(setup(), [{ op: "exec.connect", flowId: "flow_f", from: { node: "n_sw", port: "green" }, to: { node: "n_out", port: "in" } }], {
      catalog,
      idGenerator: createSequentialIdGenerator(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("exec.unknown_port");
  });

  it("descriptors carry the control (a Switch's outputs come from the config, so none are listed)", () => {
    const remote = createCatalogFromDescriptors({ packs: [{ name: "briar", version: "1.0.0", namespaces: ["briar"] } as never], nodes: catalog.descriptors(), types: [] });
    expect(execPortsOf("briar.branch", remote.get("briar.branch")).outputs).toEqual(["true", "false"]);
    expect(execPortsOf("briar.forEach", remote.get("briar.forEach")).outputs).toEqual(["body", "completed"]);
    expect(remote.get("briar.switch")?.control).toMatchObject({ kind: "route" });
  });
});
