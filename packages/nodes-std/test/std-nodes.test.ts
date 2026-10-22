/**
 * node-api.md §9, phase-3.md §4.9: the standard pack `briar` — pack shape, every node's
 * behaviour (through `runNode` from @briarflow/testing), toText rules and templates.
 */
import { describe, expect, it } from "vitest";
import { createCatalog, isBriarError, type ContextDocument, type PortError } from "@briarflow/core";
import {
  constant,
  convertFloatToInt,
  convertParseFloat,
  convertParseInt,
  convertToText,
  globalGet,
  globalSet,
  listGet,
  listLength,
  listMake,
  PACKAGE_NAME,
  renderTemplate,
  RoundingMode,
  stdPack,
  structBreak,
  structMake,
  templatePlaceholders,
  textJoin,
  textTemplate,
  valueToText,
  variableGet,
  variableSet,
} from "@briarflow/nodes-std";
import { context, describeNodePack, flow, ir, runNode, struct, field } from "@briarflow/testing";

const packs = [stdPack];

async function rejects(p: Promise<unknown>): Promise<{ code: string; message: string; details?: unknown }> {
  try {
    await p;
  } catch (error) {
    expect(isBriarError(error), String(error)).toBe(true);
    return error as { code: string; message: string };
  }
  throw new Error("expected a rejection");
}

const charCtx = (): ContextDocument =>
  context({
    types: [
      struct("ty_char", "Character", [
        field("name", ir.text()),
        field("age", ir.int({ min: 0 }), { default: 30, description: "Years" }),
        field("nick", ir.optional(ir.text())),
      ]),
    ],
    globals: [
      { id: "gv_style", name: "style", type: ir.text(), access: "readonly", value: "noir" },
      { id: "gv_count", name: "count", type: ir.int(), access: "readwrite", value: 1 },
    ],
    flows: [flow({ id: "flow_s", name: "S", variables: [{ id: "var_x", name: "x", type: ir.int({ min: 0 }), access: "public", default: 0 }], builtins: false })],
  });

describe("stdPack", () => {
  it("exports", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/nodes-std");
    expect(RoundingMode.decl.members.map((m) => m.value)).toEqual(["round", "floor", "ceil", "trunc"]);
  });

  it("is pack briar 1.0.0 with namespaces briar, text, list, convert and type briar.RoundingMode", () => {
    expect(stdPack).toMatchObject({ kind: "nodePack", name: "briar", version: "1.0.0", namespaces: ["briar", "text", "list", "convert"] });
    expect(stdPack.types).toEqual([expect.objectContaining({ kind: "enum", id: "briar.RoundingMode", name: "RoundingMode" })]);
  });

  it("has every §9 node except the core built-ins briar.input / briar.output", () => {
    expect(stdPack.nodes.map((d) => d.type).sort()).toEqual(
      [
        "briar.constant",
        "briar.global.get",
        "briar.global.set",
        "briar.struct.break",
        "briar.struct.make",
        "briar.variable.get",
        "briar.variable.set",
        "convert.floatToInt",
        "convert.parseFloat",
        "convert.parseInt",
        "convert.toText",
        "list.get",
        "list.length",
        "list.make",
        "text.join",
        "text.template",
      ].sort(),
    );
    const catalog = createCatalog([stdPack]);
    expect(catalog.get("briar.input")).toBeUndefined();
    expect(catalog.get("briar.output")).toBeUndefined();
  });

  it("exports each node definition under its namespace+name (REQ-11)", () => {
    const byType = new Map(stdPack.nodes.map((d) => [d.type, d]));
    const exported = {
      "briar.variable.get": variableGet,
      "briar.variable.set": variableSet,
      "briar.global.get": globalGet,
      "briar.global.set": globalSet,
      "briar.struct.make": structMake,
      "briar.struct.break": structBreak,
      "briar.constant": constant,
      "text.template": textTemplate,
      "text.join": textJoin,
      "list.make": listMake,
      "list.length": listLength,
      "list.get": listGet,
      "convert.toText": convertToText,
      "convert.parseInt": convertParseInt,
      "convert.parseFloat": convertParseFloat,
      "convert.floatToInt": convertFloatToInt,
    };
    for (const [type, def] of Object.entries(exported)) {
      expect(def.type).toBe(type);
      expect(byType.get(type)?.run).toBe(def.run);
    }
  });

  it("variable nodes are cache: false; the others are cached", () => {
    for (const d of stdPack.nodes) expect(d.cache, d.type).toBe(!d.type.startsWith("briar.variable.") && !d.type.startsWith("briar.global."));
  });
});

describeNodePack(stdPack, {
  requireSamples: true,
  context: charCtx(),
  samples: {
    "briar.variable.get": [{ config: { variableId: "var_x" }, flowId: "flow_s", errorCode: "node.failed" }],
    "briar.variable.set": [{ config: { variableId: "var_x" }, flowId: "flow_s", inputs: { value: 4 }, outputs: { value: 4 } }],
    "briar.global.get": [{ config: { globalId: "gv_style" }, errorCode: "node.failed" }],
    "briar.global.set": [{ config: { globalId: "gv_count" }, inputs: { value: 2 }, outputs: { value: 2 } }],
    "briar.struct.make": [{ config: { typeId: "ty_char" }, inputs: { name: "Aria" }, outputs: { value: { name: "Aria", age: 30, nick: null } } }],
    "briar.struct.break": [{ config: { typeId: "ty_char" }, inputs: { value: { name: "Aria", age: 4 } }, outputs: { name: "Aria", age: 4, nick: null } }],
    "briar.constant": [{ config: { type: ir.int() }, inputs: { value: 5 }, outputs: { value: 5 } }],
    "text.template": [{ config: { template: "Hi {name}" }, inputs: { name: "Aria" }, outputs: { text: "Hi Aria" } }],
    "text.join": [{ inputs: { items: ["a", "b"], separator: ", " }, outputs: { text: "a, b" } }],
    "list.make": [{ config: { count: 3 }, inputs: { item1: 1, item2: 2, item3: 3 }, outputs: { list: [1, 2, 3] } }],
    "list.length": [{ inputs: { list: [1, 2] }, outputs: { length: 2 } }],
    "list.get": [{ inputs: { list: ["a", "b"], index: -1 }, outputs: { item: "b" } }],
    "convert.toText": [{ inputs: { value: { b: 1, a: [true] } }, outputs: { text: '{"a":[true],"b":1}' } }],
    "convert.parseInt": [{ inputs: { text: " 42 " }, outputs: { value: 42 } }],
    "convert.parseFloat": [{ inputs: { text: "1e3" }, outputs: { value: 1000 } }],
    "convert.floatToInt": [{ inputs: { value: 2.5 }, outputs: { value: 3 } }],
  },
});

describe("valueToText (toText rules)", () => {
  it.each([
    ["text as is", "héllo {x}", undefined, "héllo {x}"],
    ["empty text", "", undefined, ""],
    ["int", 42, undefined, "42"],
    ["negative float", -1.5, undefined, "-1.5"],
    ["large float uses String()", 1e21, undefined, "1e+21"],
    ["true", true, undefined, "true"],
    ["false", false, undefined, "false"],
    ["null", null, undefined, ""],
    ["enum member value", "gpt-4.1", ir.named("ty_mood"), "gpt-4.1"],
    ["media → uri (typed)", { uri: "briar-media://m_1", mime: "image/png", bytes: 3 }, ir.image(), "briar-media://m_1"],
    ["media → uri (untyped MediaRef shape)", { uri: "https://x/a.png", mime: "image/png" }, undefined, "https://x/a.png"],
    ["optional media", { uri: "briar-media://m_2", mime: "image/png" }, ir.optional(ir.image()), "briar-media://m_2"],
    ["struct → canonical JSON", { b: 2, a: { d: [1, "x"], c: null } }, undefined, '{"a":{"c":null,"d":[1,"x"]},"b":2}'],
    ["list → JSON", [3, "a", { z: 1, y: 2 }], undefined, '[3,"a",{"y":2,"z":1}]'],
    ["struct shaped like a MediaRef stays JSON when typed as a struct", { uri: "u", mime: "m" }, ir.named("ty_s"), '{"mime":"m","uri":"u"}'],
  ])("%s", (_label, value, type, expected) => {
    expect(valueToText(value, type)).toBe(expected);
  });
});

describe("templates", () => {
  it("placeholders in order of first appearance, distinct", () => {
    expect(templatePlaceholders("Draw {name} in {style} style, {name}!")).toEqual(["name", "style"]);
    expect(templatePlaceholders("no placeholders")).toEqual([]);
    expect(templatePlaceholders("")).toEqual([]);
    expect(templatePlaceholders("{{literal}} {_x1}")).toEqual(["_x1"]);
    expect(templatePlaceholders("}} and {{")).toEqual([]);
  });

  it("invalid placeholder → text.invalid_placeholder; unclosed brace → text.invalid_template", () => {
    for (const bad of ["{1abc}", "{a b}", "{}", "{a-b}"]) {
      const r = templatePlaceholders(bad) as PortError;
      expect(r.error.code, bad).toBe("text.invalid_placeholder");
      expect(typeof r.error.message).toBe("string");
    }
    expect((templatePlaceholders("Hello {name") as PortError).error.code).toBe("text.invalid_template");
  });

  it("renderTemplate uses toText and literal braces; throws text.invalid_template", () => {
    expect(renderTemplate("Hi {name} {{ok}} }}", { name: "Aria" })).toBe("Hi Aria {ok} }");
    expect(renderTemplate("{a}|{b}|{c}|{d}", { a: 1, b: null, c: [1, 2], d: true })).toBe("1||[1,2]|true");
    expect(renderTemplate("{m}", { m: { uri: "briar-media://m_9", mime: "image/png" } }, { m: ir.image() })).toBe("briar-media://m_9");
    let thrown: unknown;
    try {
      renderTemplate("{oops", {});
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("text.invalid_template");
  });
});

describe("text.template", () => {
  it("has one generic input per distinct placeholder named T1…Tn, and output text", async () => {
    const r = await runNode(textTemplate, { name: "Aria", style: 2 }, { config: { template: "{name} in {style}, {name}" } });
    expect(r.ports.inputs.map((p) => [p.name, p.declaredType])).toEqual([
      ["name", { kind: "var", name: "T1" }],
      ["style", { kind: "var", name: "T2" }],
    ]);
    expect(r.ports.outputs.map((p) => [p.name, p.type])).toEqual([["text", { kind: "primitive", name: "text" }]]);
    expect(r.outputs).toEqual({ text: "Aria in 2, Aria" });
  });

  it("resolvePorts returns a PortError for bad templates (the node then has no ports)", () => {
    const scope = { flow: { id: "f", inputs: [], outputs: [], variables: [] }, globals: [], resolveType: () => undefined };
    const bad = textTemplate.resolvePorts!({ config: { template: "{9}" }, scope }) as PortError;
    expect(bad.error.code).toBe("text.invalid_placeholder");
    const unclosed = textTemplate.resolvePorts!({ config: { template: "{a" }, scope }) as PortError;
    expect(unclosed.error.code).toBe("text.invalid_template");
  });

  it("renders values with toText, using bound media types", async () => {
    const r = await runNode(
      textTemplate,
      { img: { uri: "briar-media://m_1", mime: "image/png" }, list: ["a"], nothing: null },
      { config: { template: "{img} {list} [{nothing}] {{x}}" }, typeBindings: { T1: ir.image() } },
    );
    expect(r.outputs.text).toBe('briar-media://m_1 ["a"] [] {x}');
  });

  it("a template without placeholders has no inputs", async () => {
    const r = await runNode(textTemplate, {}, { config: { template: "static" } });
    expect(r.ports.inputs).toEqual([]);
    expect(r.outputs).toEqual({ text: "static" });
  });

  it("requires config.template", async () => {
    expect((await rejects(runNode(textTemplate, {}, {}))).code).toBe("config.invalid");
  });
});

describe("text.join", () => {
  it("joins with the separator; default separator is empty", async () => {
    expect((await runNode(textJoin, { items: ["a", "b", "c"] })).outputs).toEqual({ text: "abc" });
    expect((await runNode(textJoin, { items: ["a", "b"], separator: " - " })).outputs).toEqual({ text: "a - b" });
    expect((await runNode(textJoin, { items: [] })).outputs).toEqual({ text: "" });
  });

  it("rejects non-text items", async () => {
    expect((await rejects(runNode(textJoin, { items: ["a", 1] }))).code).toBe("node.invalid_input");
  });
});

describe("list nodes", () => {
  it("list.make: item1…itemN ports from config.count (default 2, 0–32)", async () => {
    const two = await runNode(listMake, { item1: "a", item2: "b" });
    expect(two.ports.inputs.map((p) => p.name)).toEqual(["item1", "item2"]);
    expect(two.outputs).toEqual({ list: ["a", "b"] });
    const none = await runNode(listMake, {}, { config: { count: 0 } });
    expect(none.outputs).toEqual({ list: [] });
    const max = await runNode(listMake, Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`item${i + 1}`, i])), { config: { count: 32 } });
    expect((max.outputs.list as unknown[]).length).toBe(32);
    expect((await rejects(runNode(listMake, {}, { config: { count: 33 } }))).code).toBe("config.invalid");
    expect((await rejects(runNode(listMake, {}, { config: { count: -1 } }))).code).toBe("config.invalid");
  });

  it("list.length", async () => {
    expect((await runNode(listLength, { list: [] })).outputs).toEqual({ length: 0 });
    expect((await runNode(listLength, { list: [1, 2, 3] })).outputs).toEqual({ length: 3 });
  });

  it.each([
    [0, "a"],
    [2, "c"],
    [-1, "c"],
    [-3, "a"],
    [3, null],
    [-4, null],
    [100, null],
  ])("list.get index %i → %s", async (index, expected) => {
    expect((await runNode(listGet, { list: ["a", "b", "c"], index })).outputs).toEqual({ item: expected });
  });

  it("list.get on an empty list → null; index must be an int", async () => {
    expect((await runNode(listGet, { list: [], index: 0 })).outputs).toEqual({ item: null });
    expect((await rejects(runNode(listGet, { list: [1], index: 0.5 }))).code).toBe("node.invalid_input");
  });
});

describe("convert nodes", () => {
  it("convert.toText follows the toText rules", async () => {
    expect((await runNode(convertToText, { value: 3.5 })).outputs).toEqual({ text: "3.5" });
    expect((await runNode(convertToText, { value: null })).outputs).toEqual({ text: "" });
    expect((await runNode(convertToText, { value: [1, { b: 2, a: 1 }] })).outputs).toEqual({ text: '[1,{"a":1,"b":2}]' });
    const media = await runNode(convertToText, { value: { uri: "briar-media://m_1", mime: "image/png" } }, { typeBindings: { T: ir.image() } });
    expect(media.outputs).toEqual({ text: "briar-media://m_1" });
  });

  it.each([
    ["42", 42],
    ["  -7\n", -7],
    ["+3", 3],
    ["0", 0],
    ["-0", 0],
    ["007", 7],
  ])("convert.parseInt %j → %i", async (text, value) => {
    const r = await runNode(convertParseInt, { text });
    expect(r.outputs).toEqual({ value });
    expect(Object.is(r.outputs.value, -0)).toBe(false);
  });

  it.each(["", " ", "1.5", "12abc", "abc", "0x10", "1e3", "1 2", "9007199254740993", "Infinity", "--1"])(
    "convert.parseInt %j → convert.invalid_number",
    async (text) => {
      const err = await rejects(runNode(convertParseInt, { text }));
      expect(err.code).toBe("convert.invalid_number");
      expect(err.message).toContain("is not a whole number");
    },
  );

  it.each([
    ["3.14", 3.14],
    [" -2 ", -2],
    ["1e3", 1000],
    [".5", 0.5],
    ["5.", 5],
    ["-1.5E-2", -0.015],
    ["+0.0", 0],
  ])("convert.parseFloat %j → %d", async (text, value) => {
    expect((await runNode(convertParseFloat, { text })).outputs).toEqual({ value });
  });

  it.each(["", "abc", "1.2.3", "NaN", "Infinity", "-Infinity", "1e999", "0x1A", "1,5", "."])("convert.parseFloat %j → convert.invalid_number", async (text) => {
    expect((await rejects(runNode(convertParseFloat, { text }))).code).toBe("convert.invalid_number");
  });

  it.each([
    [2.5, "round", 3],
    [-2.5, "round", -3],
    [2.4, "round", 2],
    [-2.6, "round", -3],
    [0.5, "round", 1],
    [-0.4, "round", 0],
    [2.7, "floor", 2],
    [-2.2, "floor", -3],
    [2.2, "ceil", 3],
    [-2.7, "ceil", -2],
    [2.9, "trunc", 2],
    [-2.9, "trunc", -2],
    [7, "round", 7],
  ])("convert.floatToInt %d (%s) → %i", async (value, mode, expected) => {
    const r = await runNode(convertFloatToInt, { value, mode }, { packs });
    expect(r.outputs).toEqual({ value: expected });
    expect(Object.is(r.outputs.value, -0)).toBe(false);
  });

  it("convert.floatToInt: mode defaults to round; an unknown mode is an invalid input; the mode port is briar.RoundingMode", async () => {
    const r = await runNode(convertFloatToInt, { value: 1.5 }, { packs });
    expect(r.outputs).toEqual({ value: 2 });
    expect(r.ports.inputs.find((p) => p.name === "mode")?.type).toEqual({ kind: "named", id: "briar.RoundingMode" });
    expect((await rejects(runNode(convertFloatToInt, { value: 1.5, mode: "banker" }, { packs }))).code).toBe("node.invalid_input");
  });

  it("convert.floatToInt: values too large for an int → convert.invalid_number", async () => {
    expect((await rejects(runNode(convertFloatToInt, { value: 1e300 }, { packs }))).code).toBe("convert.invalid_number");
  });
});

describe("struct and constant nodes", () => {
  it("briar.struct.make: one input per field (field default as port default) → struct value", async () => {
    const r = await runNode(structMake, { name: "Aria", nick: "A" }, { config: { typeId: "ty_char" }, context: charCtx() });
    expect(r.ports.inputs.map((p) => [p.name, p.hasDefault, p.default ?? null])).toEqual([
      ["name", false, null],
      ["age", true, 30],
      ["nick", false, null],
    ]);
    expect(r.ports.inputs[1]?.description).toBe("Years");
    expect(r.ports.outputs.map((p) => p.type)).toEqual([{ kind: "named", id: "ty_char" }]);
    expect(r.outputs).toEqual({ value: { name: "Aria", age: 30, nick: "A" } });
  });

  it("briar.struct.make validates fields against their constraints", async () => {
    const err = await rejects(runNode(structMake, { name: "Aria", age: -1 }, { config: { typeId: "ty_char" }, context: charCtx() }));
    expect(err.code).toBe("node.invalid_input");
  });

  it("briar.struct.break: struct value → one output per field (defaults filled)", async () => {
    const r = await runNode(structBreak, { value: { name: "Aria" } }, { config: { typeId: "ty_char" }, context: charCtx() });
    expect(r.ports.outputs.map((p) => p.name)).toEqual(["name", "age", "nick"]);
    expect(r.outputs).toEqual({ name: "Aria", age: 30, nick: null });
  });

  it("struct nodes with an enum or unknown type id cannot resolve ports", async () => {
    const d = charCtx();
    const withEnum = { ...d, types: [...d.types, { kind: "enum" as const, id: "ty_mood", name: "Mood", members: [{ value: "calm" }] }] };
    await expect(runNode(structMake, {}, { config: { typeId: "ty_mood" }, context: withEnum })).rejects.toBeDefined();
    await expect(runNode(structBreak, {}, { config: { typeId: "ty_nope" }, context: d })).rejects.toBeDefined();
  });

  it("briar.constant: ports typed by config.type; identity", async () => {
    const r = await runNode(constant, { value: ["a", "b"] }, { config: { type: ir.list(ir.text()) } });
    expect(r.ports.inputs[0]?.type).toEqual(ir.list(ir.text()));
    expect(r.outputs).toEqual({ value: ["a", "b"] });
    expect((await rejects(runNode(constant, { value: "x" }, { config: { type: ir.int() } }))).code).toBe("node.invalid_input");
  });
});

describe("variable nodes outside the engine", () => {
  it("get throws node.failed explaining it only works inside the engine", async () => {
    const err = await rejects(runNode(variableGet, {}, { config: { variableId: "var_x" }, context: charCtx(), flowId: "flow_s" }));
    expect(err.code).toBe("node.failed");
    expect(err.message).toContain("only works inside the Briarflow engine");
    expect((await rejects(runNode(globalGet, {}, { config: { globalId: "gv_style" }, context: charCtx() }))).code).toBe("node.failed");
  });

  it("set passes the value through; ports follow the variable / global type", async () => {
    const r = await runNode(variableSet, { value: 3 }, { config: { variableId: "var_x" }, context: charCtx(), flowId: "flow_s" });
    expect(r.outputs).toEqual({ value: 3 });
    expect(r.ports.inputs[0]?.type).toEqual(ir.int({ min: 0 }));
    expect((await rejects(runNode(variableSet, { value: -1 }, { config: { variableId: "var_x" }, context: charCtx(), flowId: "flow_s" }))).code).toBe(
      "node.invalid_input",
    );
    expect((await runNode(globalSet, { value: 9 }, { config: { globalId: "gv_count" }, context: charCtx() })).outputs).toEqual({ value: 9 });
  });

  it("global.set refuses a readonly global (config check)", async () => {
    const err = await rejects(runNode(globalSet, { value: "x" }, { config: { globalId: "gv_style" }, context: charCtx() }));
    expect(err.code).toBe("config.invalid");
  });

  it("get ports follow the variable type", async () => {
    const r = await runNode(variableSet, { value: 1 }, { config: { variableId: "var_x" }, context: charCtx(), flowId: "flow_s" });
    expect(r.ports.outputs[0]?.type).toEqual(ir.int({ min: 0 }));
  });
});
