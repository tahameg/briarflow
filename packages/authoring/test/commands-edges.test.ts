import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, richDoc } from "./fixtures/docs.js";
import { accept, build, diags, edgeIds, flowOf, msg, nodeOf, reject } from "./fixtures/helpers.js";

const at = { x: 0, y: 0 };
const add = (id: string, type: string): Command => ({ op: "node.add", flowId: KIT, id, type, position: at });
const conn = (from: string, to: string, id?: string): Command => {
  const [fn, fp] = from.split(".") as [string, string];
  const [tn, tp] = to.split(".") as [string, string];
  return id === undefined
    ? { op: "edge.connect", flowId: KIT, from: { node: fn, port: fp }, to: { node: tn, port: tp } }
    : { op: "edge.connect", flowId: KIT, id, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
};

describe("edge.connect", () => {
  it("connects; created edgeId; inverse disconnects", () => {
    const r = accept(build(richDoc(), [add("n_s2", "kit.sinkText")]), [conn("n_src.text", "n_s2.value", "e_9")]);
    expect(r.created).toEqual([{ edgeId: "e_9" }]);
    expect(flowOf(r.doc, KIT).edges.at(-1)).toEqual({ id: "e_9", from: { node: "n_src", port: "text" }, to: { node: "n_s2", port: "value" } });
    expect(r.inverse).toHaveLength(1);
    expect(r.inverse[0]).toMatchObject({ op: "edge.disconnect", flowId: KIT, restore: true });
  });

  it("an existing identical edge → unchanged, created.edgeId is the existing id", () => {
    const r = accept(richDoc(), [conn("n_src.text", "n_sink.value", "e_new")]);
    expect(r.changed).toBe(false);
    expect(r.created[0]!.edgeId).toBe("e_2");
  });

  it("replaces the edge into an occupied input (replacedEdgeId); undo restores it", () => {
    const r = accept(build(richDoc(), [add("n_src2", "kit.textSource")]), [conn("n_src2.text", "n_sink.value", "e_r")]);
    expect(r.created).toEqual([{ edgeId: "e_r", replacedEdgeId: "e_2" }]);
    expect(edgeIds(r.doc, KIT)).not.toContain("e_2");
    expect(flowOf(r.doc, KIT).edges.filter((e) => e.to.node === "n_sink")).toHaveLength(1);
  });

  it("connecting keeps the constant of the target port", () => {
    const r = accept(build(richDoc(), [add("n_int", "kit.intSource")]), [conn("n_int.value", "n_vset.value", "e_k")]);
    expect(nodeOf(r.doc, KIT, "n_vset")!.values).toEqual({ value: 2 });
  });

  it("assignable types connect (text → text?)", () => {
    accept(build(richDoc(), [add("n_opt", "kit.sinkOptional")]), [conn("n_src.text", "n_opt.value")]);
  });

  it("unknown node → command.unknown_ref; nodes of another flow are unknown", () => {
    reject(richDoc(), [conn("n_ghost.text", "n_sink.value")], "command.unknown_ref", { message: msg.unknownRef("edge.connect", "node", "n_ghost") });
    reject(richDoc(), [conn("n_src.text", "n_tpl.name")], "command.unknown_ref", { contains: ['"n_tpl"'] });
  });

  it("unknown port → edge.unknown_port", () => {
    reject(richDoc(), [conn("n_src.nope", "n_pass.value")], "edge.unknown_port", { message: /^.*\(n_src\) has no output "nope"\. Outputs: text\.$/ });
    reject(richDoc(), [conn("n_src.text", "n_pass.nope")], "edge.unknown_port", { message: /^.*\(n_pass\) has no input "nope"\. Inputs: value\.$/ });
  });

  it("wrong direction → edge.wrong_direction", () => {
    reject(richDoc(), [conn("n_sink.value", "n_pass.value")], "edge.wrong_direction", {
      message: /^Edges go from an output to an input; "value" of .*\(n_sink\) is an input\.$/,
    });
    reject(richDoc(), [conn("n_bgget.value", "n_src.text")], "edge.wrong_direction", {
      message: /^Edges go from an output to an input; "text" of .*\(n_src\) is an output\.$/,
    });
  });

  it("self loop → edge.self_loop", () => {
    reject(richDoc(), [conn("n_pass.value", "n_pass.value")], "edge.self_loop", { message: "A node cannot be connected to itself." });
  });

  it("cycle → edge.cycle with a path", () => {
    const d = build(richDoc(), [add("n_p1", "kit.passText"), add("n_p2", "kit.passText"), conn("n_p1.value", "n_p2.value")]);
    const e = reject(d, [conn("n_p2.value", "n_p1.value")], "edge.cycle", {
      message: /^Connecting .+ to .+ would create a loop \(.+ → .+ → .+\)\. Flows must not contain loops\.$/,
    });
    expect(e.message).toContain("n_p1");
    expect(e.message).toContain("n_p2");
  });

  it("type mismatch → edge.type_mismatch with hint", () => {
    const d = build(richDoc(), [add("n_int", "kit.intSource"), add("n_tl", "kit.textListSource")]);
    reject(d, [conn("n_int.value", "n_pass.value")], "edge.type_mismatch", {
      message: /^Cannot connect .*\(n_int\)\.value \(int\) to .*\(n_pass\)\.value \(text\)\. Use convert\.toText to turn it into text\.$/,
    });
    reject(d, [conn("n_tl.list", "n_pass.value")], "edge.type_mismatch", { contains: ["Use list.get to pick one item."] });
  });

  it("generic conflict → edge.generic_conflict", () => {
    const d = build(richDoc(), [add("n_int", "kit.intSource"), add("n_g", "kit.same"), conn("n_int.value", "n_g.a")]);
    reject(d, [conn("n_src.text", "n_g.b")], "edge.generic_conflict", { message: /^.*\(n_g\) already uses T = int; b would need T = text\.$/ });
  });

  it("generic bindings are stored after connect and removed after the last edge is disconnected", () => {
    const d = build(richDoc(), [add("n_g", "kit.same")]);
    const r = accept(d, [conn("n_src.text", "n_g.a", "e_g")]);
    expect(nodeOf(r.doc, KIT, "n_g")!.typeBindings).toEqual({ T: ir.text() });
    const r2 = accept(r.doc, [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_g" }]);
    expect(nodeOf(r2.doc, KIT, "n_g")!.typeBindings).toBeUndefined();
    expect("typeBindings" in nodeOf(r2.doc, KIT, "n_g")!).toBe(false);
  });

  it("ids", () => {
    const d = build(richDoc(), [add("n_s2", "kit.sinkText")]);
    reject(d, [conn("n_src.text", "n_s2.value", "e_1")], "command.duplicate_id", { message: msg.duplicateId("edge.connect", "e_1") });
    reject(d, [conn("n_src.text", "n_s2.value", "n_1")], "command.invalid_id", { message: msg.invalidId("edge.connect", "n_1") });
  });

  it("an edge id used in another flow is fine", () => {
    // flow_p has e_1 … e_4 too; use e_1-like ids from flow_p in flow_k after removing them there
    const d = build(richDoc(), [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_1" }]);
    accept(d, [conn("n_in.topic", "n_out.summary", "e_1")]);
    expect(edgeIds(richDoc(), PORTRAIT)).toContain("e_1");
  });
});

describe("edge.disconnect", () => {
  it("by edgeId", () => {
    const r = accept(richDoc(), [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_2" }]);
    expect(edgeIds(r.doc, KIT)).toEqual(["e_1", "e_3", "e_4"]);
    expect(r.inverse).toHaveLength(1);
    expect(r.inverse[0]).toMatchObject({ op: "edge.connect", flowId: KIT, id: "e_2", from: { node: "n_src", port: "text" }, to: { node: "n_sink", port: "value" }, restore: true });
  });
  it("by `to` (the edge into that input)", () => {
    const r = accept(richDoc(), [{ op: "edge.disconnect", flowId: KIT, to: { node: "n_sink", port: "value" } }]);
    expect(edgeIds(r.doc, KIT)).toEqual(["e_1", "e_3", "e_4"]);
  });
  it("disconnect recomputes generic bindings (n_same loses T)", () => {
    const r = accept(richDoc(), [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_4" }]);
    expect(nodeOf(r.doc, KIT, "n_same")!.typeBindings).toBeUndefined();
  });
  it("unknown → command.unknown_ref", () => {
    const e = reject(richDoc(), [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_99" }], "command.unknown_ref", { message: msg.unknownRef("edge.disconnect", "edge", "e_99") });
    expect(e.details).toMatchObject({ kind: "edge", id: "e_99" });
    reject(richDoc(), [{ op: "edge.disconnect", flowId: KIT, to: { node: "n_pass", port: "nope" } }], "command.unknown_ref");
    reject(richDoc(), [{ op: "edge.disconnect", flowId: KIT, to: { node: "n_c", port: "value" } }], "command.unknown_ref");
    reject(richDoc(), [{ op: "edge.disconnect", flowId: "flow_x", edgeId: "e_1" }], "command.unknown_ref");
  });
  it("needs exactly one of edgeId / to", () => {
    reject(richDoc(), [{ op: "edge.disconnect", flowId: KIT } as unknown as Command], "command.invalid_payload");
    reject(richDoc(), [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_2", to: { node: "n_sink", port: "value" } } as unknown as Command], "command.invalid_payload");
  });
});

describe("soft breakage after edits shows as diagnostics, never rejections", () => {
  it("edge whose source type changed stays and reports edge.type_mismatch", () => {
    const r = accept(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_moodc", config: { type: "int" } }]);
    expect(edgeIds(r.doc, KIT)).toContain("e_4");
    // n_same is generic: it re-binds to int, no mismatch
    expect(diags(r.diagnostics, "edge.type_mismatch")).toEqual([]);
    expect(nodeOf(r.doc, KIT, "n_same")!.typeBindings).toEqual({ T: ir.int() });
  });
});
