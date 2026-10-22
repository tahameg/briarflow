import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, richDoc } from "./fixtures/docs.js";
import { accept, build, chars, diags, edgeIds, flowOf, msg, nodeOf, portsOf, reject } from "./fixtures/helpers.js";

const at = { x: 10, y: 20 };

describe("node.add", () => {
  it("adds a static node with id, position and title", () => {
    const r = accept(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_new", type: "kit.textSource", position: at, title: "Source" }]);
    expect(r.created).toEqual([{ nodeId: "n_new" }]);
    expect(flowOf(r.doc, KIT).nodes.at(-1)).toEqual({ id: "n_new", type: "kit.textSource", position: at, title: "Source" });
    expect(r.inverse).toEqual([{ op: "node.remove", flowId: KIT, nodeId: "n_new", restore: true }]);
  });

  it("generated ids; node ids are flow-scoped", () => {
    expect(accept(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.textSource", position: at }]).created[0]!.nodeId).toMatch(/^n_/);
    accept(richDoc(), [{ op: "node.add", flowId: PORTRAIT, id: "n_make", type: "kit.textSource", position: at }]);
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_make", type: "kit.textSource", position: at }], "command.duplicate_id", {
      message: msg.duplicateId("node.add", "n_make"),
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "node_1", type: "kit.textSource", position: at }], "command.invalid_id", {
      message: msg.invalidId("node.add", "node_1"),
    });
  });

  it("values: validated against input ports", () => {
    const r = accept(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_x", type: "kit.sinkConstrained", position: at, values: { value: 3 } }]);
    expect(nodeOf(r.doc, KIT, "n_x")!.values).toEqual({ value: 3 });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_x", type: "kit.sinkConstrained", position: at, values: { value: 11 } }], "value.invalid", {
      message: "nodes.n_x.values.value must be <= 10",
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_x", type: "kit.sinkText", position: at, values: { value: 5 } }], "value.invalid", {
      message: "nodes.n_x.values.value must be text (got 5)",
    });
  });

  it("values keys must be input ports → node.unknown_port", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_x", type: "kit.sinkText", position: at, values: { nope: "a" } }], "node.unknown_port", {
      message: /^.*\(n_x\) has no input "nope"\. Inputs: value\.$/,
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_x", type: "kit.textSource", position: at, values: { text: "a" } }], "node.unknown_port", {
      contains: ['has no input "text"'],
    });
  });

  it("built-ins → node.builtin_singleton", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.input", position: at }], "node.builtin_singleton", {
      message: "Every flow has exactly one briar.input node; it is created with the flow.",
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.output", position: at }], "node.builtin_singleton", {
      message: "Every flow has exactly one briar.output node; it is created with the flow.",
    });
  });

  it("unknown type → node.unknown_type listing the loaded packs", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "openai.chat", position: at }], "node.unknown_type", {
      message: /^Unknown node type "openai\.chat"\. Is its pack loaded\? Known packs: .*briar.*kit.*\.$/,
    });
  });

  it("config: validated (config.invalid)", () => {
    accept(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_cfg", type: "kit.configured", position: at, config: { count: 2, mode: "b" } }]);
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.configured", position: at, config: { count: 5 } }], "config.invalid", {
      message: "kit.configured: config.count must be <= 3.",
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.configured", position: at, config: { mode: "c" } }], "config.invalid", {
      message: "kit.configured: config.mode must be one of a, b.",
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.configured", position: at, config: { color: "red" } }], "config.invalid", {
      contains: ["kit.configured: config.color"],
    });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.variable.get", position: at }], "config.invalid", {
      message: "briar.variable.get: config.variableId is required.",
    });
  });

  it("config: references (config.unknown_ref)", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.variable.get", position: at, config: { variableId: "var_x" } }], "config.unknown_ref", {
      message: 'briar.variable.get: variable "var_x" does not exist in this flow.',
    });
    // variables are flow-scoped: var_n lives in flow_k only
    reject(richDoc(), [{ op: "node.add", flowId: PORTRAIT, type: "briar.variable.get", position: at, config: { variableId: "var_n" } }], "config.unknown_ref");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.global.get", position: at, config: { globalId: "gv_x" } }], "config.unknown_ref");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.struct.make", position: at, config: { typeId: "ty_style" } }], "config.unknown_ref");
    reject(richDoc(), [{ op: "node.add", flowId: PORTRAIT, type: "briar.struct.make", position: at, config: { typeId: "ty_pair" } }], "config.unknown_ref");
  });

  it("briar.global.set on a readonly global → variable.write_to_readonly", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.global.set", position: at, config: { globalId: "gv_brand" } }], "variable.write_to_readonly", {
      message: 'Global "brand" is readonly. Make it readwrite to write it from a flow.',
    });
    accept(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.global.get", position: at, config: { globalId: "gv_brand" } }]);
  });

  it("config-dependent nodes get their ports (struct.make with a local struct, variable/global nodes)", () => {
    const r = accept(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_pm", type: "briar.struct.make", position: at, config: { typeId: "ty_pair" }, values: { left: "L", mood: "angry" } },
      { op: "node.add", flowId: KIT, id: "n_gs", type: "briar.global.set", position: at, config: { globalId: "gv_hero" } },
      { op: "node.add", flowId: KIT, id: "n_vs", type: "briar.variable.set", position: at, config: { variableId: "var_mood" }, values: { value: "angry" } },
    ]);
    expect(portsOf(r.doc, KIT, "n_pm")).toEqual({ inputs: ["left", "mood"], outputs: ["value"] });
    expect(portsOf(r.doc, KIT, "n_gs")).toEqual({ inputs: ["value"], outputs: ["value"] });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.variable.set", position: at, config: { variableId: "var_mood" }, values: { value: "sad" } }], "value.invalid");
  });

  it("cfg.type() config accepts shorthand (stored as IR, resolved in the flow scope)", () => {
    const r = accept(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_k", type: "briar.constant", position: at, config: { type: "list<Character>" }, values: { value: [{ name: "A", style: "pixel" }] } },
      { op: "node.add", flowId: KIT, id: "n_m", type: "briar.constant", position: at, config: { type: "Mood?" } },
    ]);
    expect(nodeOf(r.doc, KIT, "n_k")!.config).toEqual({ type: ir.list(ir.named("ty_char")) });
    expect(nodeOf(r.doc, KIT, "n_m")!.config).toEqual({ type: ir.optional(ir.named("ty_mood")) });
    expect(r.resolved[0]).toMatchObject({ config: { type: ir.list(ir.named("ty_char")) } });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, config: { type: "list<" } }], "type.syntax");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, config: { type: "Nope" } }], "type.unknown");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, config: { type: "int" }, values: { value: "x" } }], "value.invalid");
  });

  it("media values are validated (media.*)", () => {
    const e = reject(
      richDoc(),
      [{ op: "node.add", flowId: KIT, id: "n_img", type: "briar.constant", position: at, config: { type: "image" }, values: { value: { uri: "ftp://x", mime: "image/png" } } }],
      "media.invalid_uri",
    );
    expect(e.message).toContain("nodes.n_img.values.value");
    reject(
      richDoc(),
      [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, config: { type: "image" }, values: { value: { uri: "https://x.test/a.txt", mime: "text/plain" } } }],
      "media.kind_mismatch",
    );
    accept(richDoc(), [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, config: { type: "image" }, values: { value: { uri: "https://x.test/a.png", mime: "image/png" } } }]);
  });

  it("a constant on an unbound generic port → value.generic_unbound", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, id: "n_g", type: "kit.same", position: at, values: { a: 1 } }], "value.generic_unbound", {
      message: /^Cannot set a constant on "a" of .*\(n_g\) before its type is known\. Connect an input first\.$/,
    });
  });

  it("payload rules", () => {
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.textSource", position: at, title: chars(81) }], "command.invalid_payload");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.textSource", position: { x: Number.NaN, y: 0 } }], "command.invalid_payload");
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.textSource" } as unknown as Command], "command.invalid_payload", {
      message: msg.invalidPayload("node.add", "position"),
    });
    reject(richDoc(), [{ op: "node.add", flowId: "flow_x", type: "kit.textSource", position: at }], "command.unknown_ref");
  });
});

describe("node.remove", () => {
  it("removes the node and attached edges; inverse = node.add + edge.connect with the same ids", () => {
    const r = accept(richDoc(), [{ op: "node.remove", flowId: KIT, nodeId: "n_src" }]);
    expect(nodeOf(r.doc, KIT, "n_src")).toBeUndefined();
    expect(edgeIds(r.doc, KIT)).toEqual(["e_1", "e_3", "e_4"]);
    expect(r.inverse[0]).toMatchObject({ op: "node.add", flowId: KIT, id: "n_src", type: "kit.textSource", position: { x: 100, y: 600 }, restore: true });
    expect(r.inverse.filter((c) => c.op === "edge.connect")).toEqual([
      expect.objectContaining({ op: "edge.connect", id: "e_2", from: { node: "n_src", port: "text" }, to: { node: "n_sink", port: "value" }, restore: true }),
    ]);
  });

  it("removing a node with config, values and title round-trips", () => {
    const d = build(richDoc(), [{ op: "node.setTitle", flowId: KIT, nodeId: "n_make", title: "Maker" }]);
    accept(d, [{ op: "node.remove", flowId: KIT, nodeId: "n_make" }]);
    accept(richDoc(), [{ op: "node.remove", flowId: KIT, nodeId: "n_same" }]);
  });

  it("built-ins → node.builtin_protected", () => {
    reject(richDoc(), [{ op: "node.remove", flowId: KIT, nodeId: "n_in" }], "node.builtin_protected", {
      message: "The flow's Input node cannot be removed. Edit the signature instead.",
    });
    reject(richDoc(), [{ op: "node.remove", flowId: KIT, nodeId: "n_out" }], "node.builtin_protected", {
      message: "The flow's Output node cannot be removed. Edit the signature instead.",
    });
  });

  it("unknown → command.unknown_ref (kind node)", () => {
    const e = reject(richDoc(), [{ op: "node.remove", flowId: KIT, nodeId: "n_x" }], "command.unknown_ref", { message: msg.unknownRef("node.remove", "node", "n_x") });
    expect(e.details).toMatchObject({ kind: "node", id: "n_x" });
  });
});

describe("node.move", () => {
  it("moves and rounds to 2 decimals; built-ins can move", () => {
    const r = accept(richDoc(), [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 1.234567, y: -7.005001 } }]);
    expect(nodeOf(r.doc, KIT, "n_src")!.position).toEqual({ x: 1.23, y: -7.01 });
    accept(richDoc(), [{ op: "node.move", flowId: KIT, nodeId: "n_in", position: { x: -50, y: 5 } }]);
  });
  it("same position (also after rounding) is a no-op", () => {
    expect(accept(richDoc(), [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 100.001, y: 600 } }]).changed).toBe(false);
  });
  it("non-finite numbers are rejected", () => {
    for (const x of [Number.NaN, Number.POSITIVE_INFINITY]) {
      reject(richDoc(), [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x, y: 0 } }], "command.invalid_payload");
    }
    reject(richDoc(), [{ op: "node.move", flowId: KIT, nodeId: "n_x", position: { x: 0, y: 0 } }], "command.unknown_ref");
  });
});

describe("node.setTitle", () => {
  it("sets; null and empty string clear the key", () => {
    const d = accept(richDoc(), [{ op: "node.setTitle", flowId: KIT, nodeId: "n_src", title: chars(80) }]).doc;
    expect(nodeOf(d, KIT, "n_src")!.title).toBe(chars(80));
    expect("title" in nodeOf(accept(d, [{ op: "node.setTitle", flowId: KIT, nodeId: "n_src", title: null }]).doc, KIT, "n_src")!).toBe(false);
    expect("title" in nodeOf(accept(d, [{ op: "node.setTitle", flowId: KIT, nodeId: "n_src", title: "" }]).doc, KIT, "n_src")!).toBe(false);
  });
  it("rejections", () => {
    reject(richDoc(), [{ op: "node.setTitle", flowId: KIT, nodeId: "n_src", title: chars(81) }], "command.invalid_payload");
    reject(richDoc(), [{ op: "node.setTitle", flowId: KIT, nodeId: "n_x", title: "a" }], "command.unknown_ref");
  });
});

describe("node.setValue / node.clearValue", () => {
  it("sets a constant; allowed on connected ports and on the Output node", () => {
    expect(nodeOf(accept(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: 10 }]).doc, KIT, "n_c")!.values).toEqual({ value: 10 });
    expect(nodeOf(accept(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_sink", port: "value", value: "kept" }]).doc, KIT, "n_sink")!.values).toEqual({ value: "kept" });
    accept(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_out", port: "summary", value: "fallback" }]);
    accept(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_make", port: "nickname", value: null }]);
  });
  it("hard validation incl. constraints", () => {
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: -1 }], "value.invalid", { message: "nodes.n_c.values.value must be >= 0" });
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_make", port: "age", value: "x" }], "value.invalid", { contains: ["nodes.n_make.values.age"] });
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_same", port: "b", value: "sad" }], "value.invalid"); // T is bound to Mood
  });
  it("port must be an input", () => {
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_src", port: "text", value: "a" }], "node.unknown_port", { contains: ['has no input "text"'] });
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "ghost", value: 1 }], "node.unknown_port", { contains: ['has no input "ghost"', "Inputs: value"] });
    reject(richDoc(), [{ op: "node.setValue", flowId: KIT, nodeId: "n_x", port: "value", value: 1 }], "command.unknown_ref");
  });
  it("clearValue removes; no-op when none", () => {
    const r = accept(richDoc(), [{ op: "node.clearValue", flowId: KIT, nodeId: "n_c", port: "value" }]);
    expect(nodeOf(r.doc, KIT, "n_c")!.values ?? {}).toEqual({});
    expect(accept(richDoc(), [{ op: "node.clearValue", flowId: KIT, nodeId: "n_c", port: "other" }]).changed).toBe(false);
    reject(richDoc(), [{ op: "node.clearValue", flowId: KIT, nodeId: "n_x", port: "value" }], "command.unknown_ref");
  });
});

describe("node.setConfig", () => {
  it("vanished ports lose edges and constants (restored by undo)", () => {
    const r = accept(richDoc(), [{ op: "node.setConfig", flowId: PORTRAIT, nodeId: "n_tpl", config: { template: "Draw {name}" } }]);
    expect(portsOf(r.doc, PORTRAIT, "n_tpl").inputs).toEqual(["name"]);
    expect(edgeIds(r.doc, PORTRAIT)).toEqual(["e_1", "e_2", "e_4"]);
    expect(nodeOf(r.doc, PORTRAIT, "n_tpl")!.typeBindings).toEqual({ T1: ir.text() });
  });

  it("constants of vanished ports are removed", () => {
    const d = build(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_t", type: "text.template", position: at, config: { template: "{a} {b}" }, values: {} },
      { op: "edge.connect", flowId: KIT, id: "e_t", from: { node: "n_src", port: "text" }, to: { node: "n_t", port: "a" } },
      { op: "edge.connect", flowId: KIT, id: "e_u", from: { node: "n_src", port: "text" }, to: { node: "n_t", port: "b" } },
      { op: "node.setValue", flowId: KIT, nodeId: "n_t", port: "b", value: "B" },
    ]);
    const r = accept(d, [{ op: "node.setConfig", flowId: KIT, nodeId: "n_t", config: { template: "{a}" } }]);
    expect(nodeOf(r.doc, KIT, "n_t")!.values ?? {}).toEqual({});
    expect(edgeIds(r.doc, KIT)).not.toContain("e_u");
  });

  it("type changes on kept ports are soft", () => {
    const r = accept(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_const", config: { type: "int" } }]);
    expect(nodeOf(r.doc, KIT, "n_const")).toMatchObject({ config: { type: ir.int() }, values: { value: ["anime"] } });
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_const")).toBe(true);
    expect(r.resolved[0]).toMatchObject({ config: { type: ir.int() } });
  });

  it("same validation as node.add", () => {
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_vget", config: { variableId: "var_x" } }], "config.unknown_ref");
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_vget", config: {} }], "config.invalid");
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_cset", config: { globalId: "gv_brand" } }], "variable.write_to_readonly", {
      message: 'Global "brand" is readonly. Make it readwrite to write it from a flow.',
    });
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_const", config: { type: "Nope" } }], "type.unknown");
  });

  it("built-ins → node.builtin_protected; unknown node", () => {
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_in", config: {} }], "node.builtin_protected");
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_out", config: {} }], "node.builtin_protected");
    reject(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_x", config: {} }], "command.unknown_ref");
  });

  it("switching a variable node to another variable changes its ports' type", () => {
    const r = accept(richDoc(), [{ op: "node.setConfig", flowId: KIT, nodeId: "n_vset", config: { variableId: "var_title" } }]);
    expect(nodeOf(r.doc, KIT, "n_vset")!.config).toEqual({ variableId: "var_title" });
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_vset")).toBe(true);
  });
});
