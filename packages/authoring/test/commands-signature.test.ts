import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, richDoc } from "./fixtures/docs.js";
import { accept, build, chars, diags, edgeIds, flowOf, msg, nodeOf, portsOf, reject } from "./fixtures/helpers.js";

const names = (list: readonly { name: string }[]) => list.map((x) => x.name);

describe("flow.input.add", () => {
  it("adds an input (shorthand → IR) at an index; briar.input gains the output port", () => {
    const r = accept(richDoc(), [{ op: "flow.input.add", flowId: PORTRAIT, name: "style", type: "ArtStyle", description: "Look", default: "anime", index: 0 }]);
    expect(flowOf(r.doc, PORTRAIT).inputs[0]).toEqual({ name: "style", type: ir.named("ty_style"), description: "Look", default: "anime" });
    expect(names(flowOf(r.doc, PORTRAIT).inputs)).toEqual(["style", "character"]);
    expect(portsOf(r.doc, PORTRAIT, "n_in").outputs).toEqual(["style", "character"]);
    expect(r.created).toEqual([{}]);
  });

  it("the new port can be connected in the same batch", () => {
    accept(richDoc(), [
      { op: "flow.input.add", flowId: KIT, name: "extra", type: "text" },
      { op: "edge.connect", flowId: KIT, id: "e_x", from: { node: "n_in", port: "extra" }, to: { node: "n_pass", port: "value" } },
    ]);
  });

  it("an input may share a name with an output", () => {
    accept(richDoc(), [{ op: "flow.input.add", flowId: PORTRAIT, name: "prompt", type: "text" }]);
  });

  it("§10 rejection: duplicate name (ignoring case) with the exact message", () => {
    reject(richDoc(), [{ op: "flow.input.add", flowId: PORTRAIT, name: "Character", type: "text" }], "command.duplicate_name", {
      index: 0,
      message: 'A flow input named "character" already exists in flow "Portrait". Names must be unique (ignoring case).',
    });
  });

  it("name rules", () => {
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "my input", type: "text" }], "command.invalid_name", { message: msg.invalidName("my input") });
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "constructor", type: "text" }], "command.reserved_name");
  });

  it("local type in public signature → visibility.local_type_in_public_signature", () => {
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "m", type: "Mood" }], "visibility.local_type_in_public_signature", {
      message: 'Flow input "m" uses local type "Mood". Public signatures can only use primitives, global types and pack types. Move "Mood" to global types.',
    });
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "m", type: "list<Pair?>" }], "visibility.local_type_in_public_signature");
  });

  it("invalid default → type.invalid_default; unknown type; unknown flow", () => {
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "n", type: "int", default: "x" }], "type.invalid_default", { message: msg.invalidDefault });
    reject(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "n", type: "Nope" }], "type.unknown");
    reject(richDoc(), [{ op: "flow.input.add", flowId: "flow_x", name: "n", type: "int" }], "command.unknown_ref");
  });
});

describe("flow.input.remove", () => {
  it("removes the input, its port and its edges", () => {
    const r = accept(richDoc(), [{ op: "flow.input.remove", flowId: KIT, name: "topic" }]);
    expect(flowOf(r.doc, KIT).inputs).toEqual([]);
    expect(edgeIds(r.doc, KIT)).toEqual(["e_2", "e_3", "e_4"]);
    expect(portsOf(r.doc, KIT, "n_in").outputs).toEqual([]);
  });
  it("unknown input → command.unknown_ref (kind input)", () => {
    const e = reject(richDoc(), [{ op: "flow.input.remove", flowId: KIT, name: "ghost" }], "command.unknown_ref", { contains: ['"ghost"'] });
    expect((e.details as Record<string, unknown>).kind).toBe("input");
  });
});

describe("flow.input.rename", () => {
  it("renames; the port follows and edges are rewritten", () => {
    const r = accept(richDoc(), [{ op: "flow.input.rename", flowId: KIT, name: "topic", newName: "subject" }]);
    expect(names(flowOf(r.doc, KIT).inputs)).toEqual(["subject"]);
    expect(flowOf(r.doc, KIT).edges.find((e) => e.id === "e_1")!.from).toEqual({ node: "n_in", port: "subject" });
    expect(diags(r.diagnostics, "edge.unknown_port")).toEqual([]);
  });
  it("same name no-op; rejections", () => {
    expect(accept(richDoc(), [{ op: "flow.input.rename", flowId: KIT, name: "topic", newName: "topic" }]).changed).toBe(false);
    const d = build(richDoc(), [{ op: "flow.input.add", flowId: KIT, name: "other", type: "text" }]);
    reject(d, [{ op: "flow.input.rename", flowId: KIT, name: "topic", newName: "OTHER" }], "command.duplicate_name", { message: msg.duplicateName("other") });
    reject(richDoc(), [{ op: "flow.input.rename", flowId: KIT, name: "topic", newName: "a.b" }], "command.invalid_name");
    reject(richDoc(), [{ op: "flow.input.rename", flowId: KIT, name: "ghost", newName: "x" }], "command.unknown_ref");
  });
});

describe("flow.input.setType", () => {
  it("soft: edges and defaults that no longer fit become diagnostics", () => {
    const r = accept(richDoc(), [{ op: "flow.input.setType", flowId: KIT, name: "topic", type: "int" }]);
    expect(flowOf(r.doc, KIT).inputs[0]).toEqual({ name: "topic", type: ir.int(), default: "cats" });
    expect(edgeIds(r.doc, KIT)).toContain("e_1");
    expect(diags(r.diagnostics, "edge.type_mismatch").some((d) => d.path.edgeId === "e_1")).toBe(true);
    expect(diags(r.diagnostics, "type.invalid_default").some((d) => d.path.flowId === KIT && d.path.field === "topic")).toBe(true);
  });
  it("hard: visibility; unknown", () => {
    reject(richDoc(), [{ op: "flow.input.setType", flowId: KIT, name: "topic", type: "Mood" }], "visibility.local_type_in_public_signature");
    reject(richDoc(), [{ op: "flow.input.setType", flowId: KIT, name: "topic", type: "Nope" }], "type.unknown");
    reject(richDoc(), [{ op: "flow.input.setType", flowId: KIT, name: "ghost", type: "int" }], "command.unknown_ref");
  });
});

describe("flow.input.reorder / setDescription / setDefault / clearDefault", () => {
  const three = () =>
    build(richDoc(), [
      { op: "flow.input.add", flowId: KIT, name: "a", type: "text" },
      { op: "flow.input.add", flowId: KIT, name: "b", type: "text" },
    ]);
  it.each([
    [0, ["b", "topic", "a"]],
    [1, ["topic", "b", "a"]],
    [9, ["topic", "a", "b"]],
    [-9, ["b", "topic", "a"]],
  ])("reorder to %d (clamped)", (index, expected) => {
    const r = accept(three(), [{ op: "flow.input.reorder", flowId: KIT, name: "b", index }]);
    expect(names(flowOf(r.doc, KIT).inputs)).toEqual(expected);
    expect(portsOf(r.doc, KIT, "n_in").outputs).toEqual(expected);
  });
  it("reorder rejections", () => {
    reject(three(), [{ op: "flow.input.reorder", flowId: KIT, name: "b", index: 0.5 }], "command.invalid_payload");
    reject(three(), [{ op: "flow.input.reorder", flowId: KIT, name: "z", index: 0 }], "command.unknown_ref");
  });
  it("setDescription", () => {
    const d = accept(richDoc(), [{ op: "flow.input.setDescription", flowId: KIT, name: "topic", description: "What" }]).doc;
    expect(flowOf(d, KIT).inputs[0]!.description).toBe("What");
    expect("description" in flowOf(accept(d, [{ op: "flow.input.setDescription", flowId: KIT, name: "topic", description: null }]).doc, KIT).inputs[0]!).toBe(false);
    reject(richDoc(), [{ op: "flow.input.setDescription", flowId: KIT, name: "topic", description: chars(2001) }], "command.invalid_payload");
  });
  it("setDefault validates hard; clearDefault removes", () => {
    expect(flowOf(accept(richDoc(), [{ op: "flow.input.setDefault", flowId: KIT, name: "topic", value: "dogs" }]).doc, KIT).inputs[0]!.default).toBe("dogs");
    reject(richDoc(), [{ op: "flow.input.setDefault", flowId: KIT, name: "topic", value: 4 }], "type.invalid_default", { message: msg.invalidDefault });
    reject(richDoc(), [{ op: "flow.input.setDefault", flowId: PORTRAIT, name: "character", value: { name: "A" } }], "type.invalid_default");
    reject(richDoc(), [{ op: "flow.input.setDefault", flowId: KIT, name: "ghost", value: "x" }], "command.unknown_ref");
    const r = accept(richDoc(), [{ op: "flow.input.clearDefault", flowId: KIT, name: "topic" }]);
    expect("default" in flowOf(r.doc, KIT).inputs[0]!).toBe(false);
    reject(richDoc(), [{ op: "flow.input.clearDefault", flowId: KIT, name: "ghost" }], "command.unknown_ref");
  });
});

describe("flow.output.*", () => {
  it("add: briar.output gains an input port", () => {
    const r = accept(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "count", type: "int", description: "N", index: 0 }]);
    expect(flowOf(r.doc, KIT).outputs[0]).toEqual({ name: "count", type: ir.int(), description: "N" });
    expect(portsOf(r.doc, KIT, "n_out").inputs).toEqual(["count", "summary"]);
  });
  it("add rejections (outputs have no defaults)", () => {
    reject(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "SUMMARY", type: "text" }], "command.duplicate_name", {
      message: 'A flow output named "summary" already exists in flow "Kit". Names must be unique (ignoring case).',
    });
    reject(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "m", type: "Mood" }], "visibility.local_type_in_public_signature", {
      message: 'Flow output "m" uses local type "Mood". Public signatures can only use primitives, global types and pack types. Move "Mood" to global types.',
    });
    reject(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "x", type: "text", default: "a" } as unknown as Command], "command.invalid_payload");
    reject(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "$x", type: "text" }], "command.invalid_name");
  });
  it("remove: edges and Output-node constants of the port are removed", () => {
    const d = build(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "extra", type: "text" }, { op: "node.setValue", flowId: KIT, nodeId: "n_out", port: "extra", value: "x" }]);
    const r = accept(d, [
      { op: "flow.output.remove", flowId: KIT, name: "extra" },
      { op: "flow.output.remove", flowId: KIT, name: "summary" },
    ]);
    expect(flowOf(r.doc, KIT).outputs).toEqual([]);
    expect(edgeIds(r.doc, KIT)).not.toContain("e_1");
    expect(nodeOf(r.doc, KIT, "n_out")!.values ?? {}).toEqual({});
  });
  it("rename: edges and Output-node constant keys are rewritten", () => {
    const d = build(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_out", port: "summary", value: "fallback" }]);
    const r = accept(d, [{ op: "flow.output.rename", flowId: KIT, name: "summary", newName: "result" }]);
    expect(flowOf(r.doc, KIT).edges.find((e) => e.id === "e_1")!.to).toEqual({ node: "n_out", port: "result" });
    expect(nodeOf(r.doc, KIT, "n_out")!.values).toEqual({ result: "fallback" });
    reject(richDoc(), [{ op: "flow.output.rename", flowId: KIT, name: "ghost", newName: "x" }], "command.unknown_ref", { contains: ['"ghost"'] });
  });
  it("setType: soft edge mismatch, hard visibility", () => {
    const r = accept(richDoc(), [{ op: "flow.output.setType", flowId: KIT, name: "summary", type: "image" }]);
    expect(diags(r.diagnostics, "edge.type_mismatch").some((d) => d.path.edgeId === "e_1")).toBe(true);
    reject(richDoc(), [{ op: "flow.output.setType", flowId: KIT, name: "summary", type: "Pair" }], "visibility.local_type_in_public_signature");
  });
  it("reorder and setDescription", () => {
    const d = build(richDoc(), [{ op: "flow.output.add", flowId: KIT, name: "b", type: "text" }]);
    expect(names(flowOf(accept(d, [{ op: "flow.output.reorder", flowId: KIT, name: "b", index: 0 }]).doc, KIT).outputs)).toEqual(["b", "summary"]);
    expect(flowOf(accept(d, [{ op: "flow.output.setDescription", flowId: KIT, name: "b", description: "B" }]).doc, KIT).outputs[1]!.description).toBe("B");
    reject(d, [{ op: "flow.output.reorder", flowId: KIT, name: "zz", index: 0 }], "command.unknown_ref");
    const e = reject(d, [{ op: "flow.output.setDescription", flowId: KIT, name: "zz", description: "B" }], "command.unknown_ref");
    expect((e.details as Record<string, unknown>).kind).toBe("output");
  });
  it("unknown flow → command.unknown_ref for every signature op", () => {
    const ops: Command[] = [
      { op: "flow.input.remove", flowId: "flow_x", name: "a" },
      { op: "flow.input.rename", flowId: "flow_x", name: "a", newName: "b" },
      { op: "flow.input.setType", flowId: "flow_x", name: "a", type: "int" },
      { op: "flow.input.reorder", flowId: "flow_x", name: "a", index: 0 },
      { op: "flow.input.setDescription", flowId: "flow_x", name: "a", description: null },
      { op: "flow.input.setDefault", flowId: "flow_x", name: "a", value: 1 },
      { op: "flow.input.clearDefault", flowId: "flow_x", name: "a" },
      { op: "flow.output.add", flowId: "flow_x", name: "a", type: "int" },
      { op: "flow.output.remove", flowId: "flow_x", name: "a" },
      { op: "flow.output.rename", flowId: "flow_x", name: "a", newName: "b" },
      { op: "flow.output.setType", flowId: "flow_x", name: "a", type: "int" },
      { op: "flow.output.reorder", flowId: "flow_x", name: "a", index: 0 },
      { op: "flow.output.setDescription", flowId: "flow_x", name: "a", description: null },
    ];
    for (const c of ops) reject(richDoc(), [c], "command.unknown_ref", { contains: ['"flow_x"'] });
  });
});
