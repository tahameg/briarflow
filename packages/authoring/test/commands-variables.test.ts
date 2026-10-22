import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import type { ContextDocument, FlowVariable } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, richDoc } from "./fixtures/docs.js";
import { accept, build, chars, diags, edgeIds, flowOf, msg, nodeOf, reject } from "./fixtures/helpers.js";

function v(doc: ContextDocument, id: string, flowId = KIT): FlowVariable {
  const x = flowOf(doc, flowId).variables.find((y) => y.id === id);
  if (!x) throw new Error(`variable ${id} missing`);
  return x;
}

describe("flow.variable.create", () => {
  it("creates with shorthand type as IR, default and description", () => {
    const r = accept(richDoc(), [
      { op: "flow.variable.create", flowId: KIT, id: "var_list", name: "list", type: "list<int>", access: "private", default: [1], description: "L" },
    ]);
    expect(r.created).toEqual([{ variableId: "var_list" }]);
    expect(flowOf(r.doc, KIT).variables.at(-1)).toEqual({ id: "var_list", name: "list", type: ir.list(ir.int()), access: "private", default: [1], description: "L" });
  });

  it("generated id; private variables may use local types", () => {
    const r = accept(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "feel", type: "Mood", access: "private" }]);
    expect(r.created[0]!.variableId).toBe("var_1");
    expect(v(r.doc, "var_1").type).toEqual(ir.named("ty_mood"));
  });

  it("variable ids are flow-scoped: the same id in another flow is fine", () => {
    accept(richDoc(), [{ op: "flow.variable.create", flowId: PORTRAIT, id: "var_n", name: "n", type: "int", access: "private" }]);
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, id: "var_n", name: "other", type: "int", access: "private" }], "command.duplicate_id", {
      message: msg.duplicateId("flow.variable.create", "var_n"),
    });
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, id: "gv_n", name: "other", type: "int", access: "private" }], "command.invalid_id");
  });

  it("public + local type → visibility.local_type_in_public_variable", () => {
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "feel", type: "Mood", access: "public" }], "visibility.local_type_in_public_variable", {
      message: 'Public variable "feel" uses local type "Mood". Make the variable private or move the type to global.',
    });
  });

  it("invalid default → value.invalid; name rules; payload", () => {
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "x", type: "int", access: "private", default: "a" }], "value.invalid", {
      message: 'variables.x must be a whole number (got "a")',
    });
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "N", type: "int", access: "private" }], "command.duplicate_name", { message: msg.duplicateName("n") });
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "a b", type: "int", access: "private" }], "command.invalid_name");
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "prototype", type: "int", access: "private" }], "command.reserved_name");
    reject(richDoc(), [{ op: "flow.variable.create", flowId: KIT, name: "x", type: "int", access: "global" } as unknown as Command], "command.invalid_payload");
    reject(richDoc(), [{ op: "flow.variable.create", flowId: "flow_x", name: "x", type: "int", access: "private" }], "command.unknown_ref");
  });
});

describe("flow.variable.rename", () => {
  it("renames; nodes reference ids", () => {
    const r = accept(richDoc(), [{ op: "flow.variable.rename", flowId: KIT, variableId: "var_n", name: "counter" }]);
    expect(v(r.doc, "var_n").name).toBe("counter");
    expect(nodeOf(r.doc, KIT, "n_vget")!.config).toEqual({ variableId: "var_n" });
  });
  it("rejections", () => {
    reject(richDoc(), [{ op: "flow.variable.rename", flowId: KIT, variableId: "var_n", name: "TITLE" }], "command.duplicate_name", { message: msg.duplicateName("title") });
    reject(richDoc(), [{ op: "flow.variable.rename", flowId: KIT, variableId: "var_n", name: "" }], "command.invalid_name");
    const e = reject(richDoc(), [{ op: "flow.variable.rename", flowId: KIT, variableId: "var_x", name: "y" }], "command.unknown_ref", {
      message: msg.unknownRef("flow.variable.rename", "variable", "var_x"),
    });
    expect(e.details).toMatchObject({ kind: "variable", id: "var_x" });
  });
});

describe("flow.variable.setType", () => {
  it("soft: default and set-node constants become diagnostics; ports follow", () => {
    const r = accept(richDoc(), [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_n", type: "text" }]);
    expect(v(r.doc, "var_n")).toMatchObject({ type: ir.text(), default: 1 });
    expect(diags(r.diagnostics, "variable.invalid_default").some((d) => d.path.variableId === "var_n")).toBe(true);
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_vset")).toBe(true);
  });
  it("hard: visibility of public variables; unknown", () => {
    reject(richDoc(), [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_title", type: "Mood" }], "visibility.local_type_in_public_variable");
    accept(richDoc(), [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_n", type: "Pair?" }]);
    reject(richDoc(), [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_n", type: "Nope" }], "type.unknown");
    reject(richDoc(), [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_x", type: "int" }], "command.unknown_ref");
  });
});

describe("flow.variable.setAccess", () => {
  it("private → public; public → private", () => {
    expect(v(accept(richDoc(), [{ op: "flow.variable.setAccess", flowId: KIT, variableId: "var_n", access: "public" }]).doc, "var_n").access).toBe("public");
    expect(v(accept(richDoc(), [{ op: "flow.variable.setAccess", flowId: KIT, variableId: "var_title", access: "private" }]).doc, "var_title").access).toBe("private");
  });
  it("→ public with a local type is rejected", () => {
    reject(richDoc(), [{ op: "flow.variable.setAccess", flowId: KIT, variableId: "var_mood", access: "public" }], "visibility.local_type_in_public_variable", {
      message: 'Public variable "mood" uses local type "Mood". Make the variable private or move the type to global.',
    });
    reject(richDoc(), [{ op: "flow.variable.setAccess", flowId: KIT, variableId: "var_n", access: "open" } as unknown as Command], "command.invalid_payload");
  });
});

describe("flow.variable.setDefault / clearDefault / setDescription", () => {
  it("setDefault validates hard", () => {
    expect(v(accept(richDoc(), [{ op: "flow.variable.setDefault", flowId: KIT, variableId: "var_n", value: 9 }]).doc, "var_n").default).toBe(9);
    reject(richDoc(), [{ op: "flow.variable.setDefault", flowId: KIT, variableId: "var_mood", value: "sad" }], "value.invalid", { contains: ["variables.mood"] });
    reject(richDoc(), [{ op: "flow.variable.setDefault", flowId: KIT, variableId: "var_x", value: 1 }], "command.unknown_ref");
  });
  it("clearDefault removes the key", () => {
    expect("default" in v(accept(richDoc(), [{ op: "flow.variable.clearDefault", flowId: KIT, variableId: "var_n" }]).doc, "var_n")).toBe(false);
  });
  it("setDescription sets and clears", () => {
    const d = accept(richDoc(), [{ op: "flow.variable.setDescription", flowId: KIT, variableId: "var_n", description: "Counter" }]).doc;
    expect(v(d, "var_n").description).toBe("Counter");
    expect("description" in v(accept(d, [{ op: "flow.variable.setDescription", flowId: KIT, variableId: "var_n", description: null }]).doc, "var_n")).toBe(false);
    reject(richDoc(), [{ op: "flow.variable.setDescription", flowId: KIT, variableId: "var_n", description: chars(2001) }], "command.invalid_payload");
  });
});

describe("flow.variable.delete", () => {
  it("deletes an unused variable", () => {
    const r = accept(richDoc(), [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_title" }]);
    expect(flowOf(r.doc, KIT).variables.map((x) => x.id)).toEqual(["var_n", "var_mood", "var_hero"]);
  });
  it("in use → variable.in_use with details.nodes", () => {
    const e = reject(richDoc(), [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_n" }], "variable.in_use", { contains: ['"n"'] });
    expect((e.details as { nodes: unknown[] }).nodes).toEqual(
      expect.arrayContaining([
        { flowId: KIT, nodeId: "n_vget" },
        { flowId: KIT, nodeId: "n_vset" },
      ]),
    );
  });
  it("cascade removes the get/set nodes and their edges", () => {
    const d = build(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_add", type: "kit.addOne", position: { x: 0, y: 0 } },
      { op: "edge.connect", flowId: KIT, id: "e_v", from: { node: "n_vget", port: "value" }, to: { node: "n_add", port: "value" } },
    ]);
    const r = accept(d, [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_n", cascade: true }]);
    expect(nodeOf(r.doc, KIT, "n_vget")).toBeUndefined();
    expect(nodeOf(r.doc, KIT, "n_vset")).toBeUndefined();
    expect(edgeIds(r.doc, KIT)).not.toContain("e_v");
    expect(nodeOf(r.doc, KIT, "n_add")).toBeDefined();
  });
  it("unknown → command.unknown_ref", () => {
    reject(richDoc(), [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_x" }], "command.unknown_ref");
  });
});
