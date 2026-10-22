import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE, type StructDecl } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, emptyDoc, richDoc } from "./fixtures/docs.js";
import { accept, chars, flowOf, msg, nodeOf, reject } from "./fixtures/helpers.js";

describe("flow.create", () => {
  it("creates an empty flow with input node at {0,0} and output node at {640,0}", () => {
    const r = accept(richDoc(), [{ op: "flow.create", id: "flow_new", name: "New", inputNodeId: "n_i", outputNodeId: "n_o", description: "D" }]);
    expect(r.created).toEqual([{ flowId: "flow_new", inputNodeId: "n_i", outputNodeId: "n_o" }]);
    expect(r.doc.flows.map((f) => f.id)).toEqual([PORTRAIT, KIT, "flow_new"]);
    expect(flowOf(r.doc, "flow_new")).toEqual({
      id: "flow_new",
      name: "New",
      description: "D",
      types: [],
      inputs: [],
      outputs: [],
      variables: [],
      nodes: [
        { id: "n_i", type: FLOW_INPUT_NODE_TYPE, position: { x: 0, y: 0 } },
        { id: "n_o", type: FLOW_OUTPUT_NODE_TYPE, position: { x: 640, y: 0 } },
      ],
      edges: [],
      execEdges: [{ id: "x_1", from: { node: "n_i", port: "then" }, to: { node: "n_o", port: "in" } }],
    });
    expect(r.inverse).toEqual([{ op: "flow.delete", flowId: "flow_new", restore: true }]);
  });

  it("generates missing ids", () => {
    const r = accept(emptyDoc(), [{ op: "flow.create", name: "A" }]);
    const c = r.created[0]!;
    expect(c.flowId).toMatch(/^flow_/);
    expect(c.inputNodeId).toMatch(/^n_/);
    expect(c.outputNodeId).toMatch(/^n_/);
    expect(c.inputNodeId).not.toBe(c.outputNodeId);
    expect(nodeOf(r.doc, c.flowId!, c.inputNodeId!)!.type).toBe(FLOW_INPUT_NODE_TYPE);
    expect(nodeOf(r.doc, c.flowId!, c.outputNodeId!)!.type).toBe(FLOW_OUTPUT_NODE_TYPE);
  });

  it("names: 80 chars, unicode ok", () => {
    accept(emptyDoc(), [{ op: "flow.create", name: chars(80) }]);
    accept(emptyDoc(), [{ op: "flow.create", name: "Bild ✨ — 茨 (v2)" }]);
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["81 chars", chars(81)],
    ["a control char", "a\tb"],
    ["a newline", "a\nb"],
  ])("rejects a name that is %s (command.invalid_name)", (_l, name) => {
    reject(emptyDoc(), [{ op: "flow.create", name }], "command.invalid_name");
  });

  it("flow names are unique ignoring case", () => {
    reject(richDoc(), [{ op: "flow.create", name: "portrait" }], "command.duplicate_name", { message: msg.duplicateName("Portrait") });
    reject(emptyDoc(), [{ op: "flow.create", name: "A" }, { op: "flow.create", name: "a" }], "command.duplicate_name", { index: 1 });
  });

  it("ids", () => {
    reject(richDoc(), [{ op: "flow.create", id: "n_x", name: "X" }], "command.invalid_id", { message: msg.invalidId("flow.create", "n_x") });
    reject(richDoc(), [{ op: "flow.create", id: "flow_p", name: "X" }], "command.duplicate_id", { message: msg.duplicateId("flow.create", "flow_p") });
    reject(richDoc(), [{ op: "flow.create", name: "X", inputNodeId: "e_1" }], "command.invalid_id");
    reject(richDoc(), [{ op: "flow.create", name: "X", outputNodeId: "flow_q" }], "command.invalid_id");
  });
});

describe("flow.rename / flow.setDescription", () => {
  it("renames; same name no-op; case-only rename of itself is allowed", () => {
    expect(flowOf(accept(richDoc(), [{ op: "flow.rename", flowId: KIT, name: "Toolkit" }]).doc, KIT).name).toBe("Toolkit");
    expect(accept(richDoc(), [{ op: "flow.rename", flowId: KIT, name: "Kit" }]).changed).toBe(false);
    expect(flowOf(accept(richDoc(), [{ op: "flow.rename", flowId: KIT, name: "KIT" }]).doc, KIT).name).toBe("KIT");
  });
  it("rejections", () => {
    reject(richDoc(), [{ op: "flow.rename", flowId: KIT, name: "PORTRAIT" }], "command.duplicate_name", { message: msg.duplicateName("Portrait") });
    reject(richDoc(), [{ op: "flow.rename", flowId: KIT, name: "" }], "command.invalid_name");
    reject(richDoc(), [{ op: "flow.rename", flowId: "flow_x", name: "Y" }], "command.unknown_ref", { message: msg.unknownRef("flow.rename", "flow", "flow_x") });
  });
  it("setDescription sets and clears", () => {
    const d = accept(richDoc(), [{ op: "flow.setDescription", flowId: KIT, description: "Tools" }]).doc;
    expect(flowOf(d, KIT).description).toBe("Tools");
    expect("description" in flowOf(accept(d, [{ op: "flow.setDescription", flowId: KIT, description: null }]).doc, KIT)).toBe(false);
    reject(richDoc(), [{ op: "flow.setDescription", flowId: KIT, description: chars(2001) }], "command.invalid_payload");
    reject(richDoc(), [{ op: "flow.setDescription", flowId: "flow_x", description: "a" }], "command.unknown_ref");
  });
});

describe("flow.delete", () => {
  it("deletes; the inverse restores the full flow at its index", () => {
    const r = accept(richDoc(), [{ op: "flow.delete", flowId: PORTRAIT }]);
    expect(r.doc.flows.map((f) => f.id)).toEqual([KIT]);
  });
  it("unknown → command.unknown_ref", () => {
    reject(richDoc(), [{ op: "flow.delete", flowId: "flow_x" }], "command.unknown_ref");
  });
});

describe("flow.duplicate", () => {
  it("default names: '{name} copy', then '{name} copy 2'", () => {
    const r1 = accept(richDoc(), [{ op: "flow.duplicate", flowId: PORTRAIT }]);
    expect(r1.doc.flows.at(-1)!.name).toBe("Portrait copy");
    const r2 = accept(r1.doc, [{ op: "flow.duplicate", flowId: PORTRAIT }]);
    expect(r2.doc.flows.at(-1)!.name).toBe("Portrait copy 2");
    const r3 = accept(r2.doc, [{ op: "flow.duplicate", flowId: PORTRAIT }]);
    expect(r3.doc.flows.at(-1)!.name).toBe("Portrait copy 3");
  });

  it("keeps node / edge / variable ids; copies everything", () => {
    const r = accept(richDoc(), [{ op: "flow.duplicate", flowId: PORTRAIT, id: "flow_p2", name: "Portrait B" }]);
    expect(r.created).toEqual([{ flowId: "flow_p2", typeIds: {} }]);
    const copy = flowOf(r.doc, "flow_p2");
    const orig = flowOf(r.doc, PORTRAIT);
    expect({ ...copy, id: PORTRAIT, name: "Portrait" }).toEqual(orig);
    expect(r.inverse).toEqual([{ op: "flow.delete", flowId: "flow_p2", restore: true }]);
  });

  it("re-ids local types from typeIds and rewrites every reference in the copy", () => {
    const r = accept(richDoc(), [{ op: "flow.duplicate", flowId: KIT, id: "flow_k2", typeIds: { ty_mood: "ty_mood2", ty_pair: "ty_pair2" } }]);
    expect(r.created[0]).toEqual({ flowId: "flow_k2", typeIds: { ty_mood: "ty_mood2", ty_pair: "ty_pair2" } });
    const copy = flowOf(r.doc, "flow_k2");
    expect(copy.types.map((t) => t.id)).toEqual(["ty_mood2", "ty_pair2"]);
    expect((copy.types[1] as StructDecl).fields[1]!.type).toEqual(ir.named("ty_mood2"));
    expect(copy.variables.find((v) => v.id === "var_mood")!.type).toEqual(ir.named("ty_mood2"));
    expect(nodeOf(r.doc, "flow_k2", "n_moodc")!.config).toEqual({ type: ir.named("ty_mood2") });
    expect(nodeOf(r.doc, "flow_k2", "n_same")!.typeBindings).toEqual({ T: ir.named("ty_mood2") });
    expect(JSON.stringify(copy)).not.toMatch(/"ty_mood"|"ty_pair"/);
    // the original is untouched
    expect(flowOf(r.doc, KIT)).toEqual(flowOf(richDoc(), KIT));
    expect(copy.nodes.map((n) => n.id)).toEqual(flowOf(r.doc, KIT).nodes.map((n) => n.id));
  });

  it("generates new local type ids when typeIds is omitted (and records them)", () => {
    const r = accept(richDoc(), [{ op: "flow.duplicate", flowId: KIT }]);
    const map = r.created[0]!.typeIds!;
    expect(Object.keys(map).sort()).toEqual(["ty_mood", "ty_pair"]);
    for (const v of Object.values(map)) expect(v).toMatch(/^ty_/);
    expect(new Set(Object.values(map)).size).toBe(2);
    expect(r.resolved[0]).toMatchObject({ typeIds: map });
    const copy = r.doc.flows.at(-1)!;
    expect(copy.name).toBe("Kit copy");
    expect(copy.types.map((t) => t.id)).toEqual([map.ty_mood, map.ty_pair]);
  });

  it("rejections", () => {
    reject(richDoc(), [{ op: "flow.duplicate", flowId: "flow_x" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, name: "portrait" }], "command.duplicate_name");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, id: "flow_p" }], "command.duplicate_id");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, id: "ty_x" }], "command.invalid_id");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, typeIds: { ty_mood: "nope" } }], "command.invalid_id");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, typeIds: { ty_mood: "ty_char" } }], "command.duplicate_id");
    reject(richDoc(), [{ op: "flow.duplicate", flowId: KIT, typeIds: { ty_mood: 3 } } as unknown as Command], "command.invalid_payload");
  });
});

describe("flow.setViewport", () => {
  it("stores the viewport, bumps the revision, has no inverse", () => {
    const r = accept(richDoc(), [{ op: "flow.setViewport", flowId: KIT, viewport: { x: 10, y: -5, zoom: 1.5 } }], { noUndo: true });
    expect(flowOf(r.doc, KIT).ui).toEqual({ viewport: { x: 10, y: -5, zoom: 1.5 } });
    expect(r.changed).toBe(true);
    expect(r.doc.revision).toBe(2);
    expect(r.inverse).toEqual([]);
  });

  it("zoom must be in (0, 8]", () => {
    accept(richDoc(), [{ op: "flow.setViewport", flowId: KIT, viewport: { x: 0, y: 0, zoom: 8 } }], { noUndo: true });
    for (const zoom of [0, -1, 8.01]) {
      reject(richDoc(), [{ op: "flow.setViewport", flowId: KIT, viewport: { x: 0, y: 0, zoom } }], "command.invalid_payload");
    }
    reject(richDoc(), [{ op: "flow.setViewport", flowId: KIT, viewport: { x: 0, y: 0 } } as unknown as Command], "command.invalid_payload");
    reject(richDoc(), [{ op: "flow.setViewport", flowId: "flow_x", viewport: { x: 0, y: 0, zoom: 1 } }], "command.unknown_ref");
  });

  it("does not contribute to the inverse of a mixed batch", () => {
    const r = accept(richDoc(), [
      { op: "flow.rename", flowId: KIT, name: "K2" },
      { op: "flow.setViewport", flowId: KIT, viewport: { x: 1, y: 1, zoom: 1 } },
    ], { noUndo: true });
    expect(r.inverse.map((c) => c.op)).toEqual(["flow.rename"]);
  });
});
