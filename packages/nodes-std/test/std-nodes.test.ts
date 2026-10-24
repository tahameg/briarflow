/**
 * node-api.md §9, phase-3.md §4.9: the standard pack `briar` — pack shape, every node's
 * behaviour (through `runNode` from @briarflow/testing), toText rules and templates.
 */
import { describe, expect, it } from "vitest";
import { createCatalog, isBriarError, toNodeDescriptor, type ContextDocument, type PortError } from "@briarflow/core";
import {
  constant,
  convertAsBoolean,
  convertAsFloat,
  convertAsInt,
  convertAsJson,
  convertAsJsonArray,
  convertFloatToInt,
  convertToText,
  debugPrint,
  globalGet,
  globalSet,
  jsonAddField,
  jsonGetField,
  jsonSetField,
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

  it("is pack briar 1.0.0 with namespaces briar, text, list, convert, debug, json and type briar.RoundingMode", () => {
    expect(stdPack).toMatchObject({ kind: "nodePack", name: "briar", version: "1.0.0", namespaces: ["briar", "text", "list", "convert", "debug", "json"] });
    expect(stdPack.types).toEqual([expect.objectContaining({ kind: "enum", id: "briar.RoundingMode", name: "RoundingMode" })]);
  });

  it("has every §9 node except the core built-ins briar.input / briar.output", () => {
    expect(stdPack.nodes.map((d) => d.type).sort()).toEqual(
      [
        "briar.constant",
        "briar.error.break",
        "briar.global.get",
        "briar.global.set",
        "briar.member.get",
        "briar.member.set",
        "briar.struct.break",
        "briar.struct.make",
        "briar.variable.get",
        "briar.variable.set",
        "convert.asBoolean",
        "convert.asFloat",
        "convert.asInt",
        "convert.asJson",
        "convert.asJsonArray",
        "convert.floatToInt",
        "convert.toText",
        "debug.print",
        "debug.image",
        "json.addField",
        "json.construct",
        "json.getField",
        "json.setField",
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
      "convert.asInt": convertAsInt,
      "convert.asFloat": convertAsFloat,
      "convert.asBoolean": convertAsBoolean,
      "convert.asJson": convertAsJson,
      "convert.asJsonArray": convertAsJsonArray,
      "convert.floatToInt": convertFloatToInt,
    };
    for (const [type, def] of Object.entries(exported)) {
      expect(def.type).toBe(type);
      expect(byType.get(type)?.run).toBe(def.run);
    }
  });

  it("variable nodes and the Template builder (it reads variables) are cache: false; the others are cached", () => {
    for (const d of stdPack.nodes) {
      expect(d.cache, d.type).toBe(!d.type.startsWith("briar.variable.") && !d.type.startsWith("briar.global.") && d.type !== "text.template");
    }
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
    "briar.member.get": [{ config: { type: ir.named("ty_char"), path: "name" }, inputs: { value: { name: "Aria", age: 3, nick: null } }, outputs: { name: "Aria" } }],
    "briar.member.set": [{ config: { type: ir.named("ty_char"), path: "age" }, inputs: { value: { name: "Aria", age: 3, nick: null }, to: 4 }, outputs: { value: { name: "Aria", age: 4, nick: null } } }],
    "text.template": [{ config: { template: "Hi {{name}}" }, inputs: { name: "Aria" }, outputs: { text: "Hi Aria" } }],
    "text.join": [{ inputs: { items: ["a", "b"], separator: ", " }, outputs: { text: "a, b" } }],
    "list.make": [{ config: { count: 3 }, inputs: { item1: 1, item2: 2, item3: 3 }, outputs: { list: [1, 2, 3] } }],
    "list.length": [{ inputs: { list: [1, 2] }, outputs: { length: 2 } }],
    "list.get": [{ inputs: { list: ["a", "b"], index: -1 }, outputs: { item: "b" } }],
    "convert.toText": [{ inputs: { value: { b: 1, a: [true] } }, outputs: { text: '{"a":[true],"b":1}' } }],
    "convert.asInt": [{ inputs: { value: " 42 " }, outputs: { value: 42 } }],
    "convert.asFloat": [{ inputs: { value: "1e3" }, outputs: { value: 1000 } }],
    "convert.asBoolean": [{ inputs: { value: 0 }, outputs: { value: false } }],
    "convert.asJson": [{ inputs: { text: '{"a":1}' }, outputs: { json: '{"a":1}' } }],
    "convert.asJsonArray": [{ inputs: { value: "[1,2]" }, outputs: { items: [1, 2] } }],
    "convert.floatToInt": [{ inputs: { value: 2.5 }, outputs: { value: 3 } }],
    "debug.print": [{ inputs: { text: "hello" }, outputs: {} }],
    "debug.image": [{ inputs: { image: { mediaId: "med_1" }, label: "after resize" }, outputs: {} }],
    "json.construct": [{ inputs: { value: [1, { a: true }] }, outputs: { json: [1, { a: true }] } }],
    "json.getField": [{ inputs: { json: { user: { tags: ["a", "b"] } }, path: "user.tags[1]" }, outputs: { value: "b" } }],
    "json.setField": [{ inputs: { json: { a: 1 }, path: "b.c", value: 2 }, outputs: { json: { a: 1, b: { c: 2 } } } }],
    "json.addField": [{ inputs: { json: { a: 1 }, path: "a", value: 2 }, errorCode: "json.field_exists" }],
    "briar.error.break": [{ inputs: { error: { code: "node.timeout", message: "Too slow", node: "LLM" } }, outputs: { code: "node.timeout", message: "Too slow", node: "LLM", nodeId: null } }],
  },
});

describe("debug.print", () => {
  it("is a frontend node that does nothing on the server", async () => {
    expect(debugPrint.frontend).toBe(true);
    expect(toNodeDescriptor(debugPrint, stdPack).frontend).toBe(true);
    const r = await runNode(debugPrint, { text: "hi\nthere", browserConsole: true });
    expect(r.outputs).toEqual({});
  });
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
    ["media → its id (typed)", { mediaId: "med_1" }, ir.image(), "med_1"],
    ["media → its id (untyped media shape)", { mediaId: "med_3" }, undefined, "med_3"],
    ["optional media", { mediaId: "med_2" }, ir.optional(ir.image()), "med_2"],
    ["struct → canonical JSON", { b: 2, a: { d: [1, "x"], c: null } }, undefined, '{"a":{"c":null,"d":[1,"x"]},"b":2}'],
    ["list → JSON", [3, "a", { z: 1, y: 2 }], undefined, '[3,"a",{"y":2,"z":1}]'],
    ["struct shaped like a media value stays JSON when typed as a struct", { mediaId: "u" }, ir.named("ty_s"), '{"mediaId":"u"}'],
  ])("%s", (_label, value, type, expected) => {
    expect(valueToText(value, type)).toBe(expected);
  });
});

describe("templates", () => {
  it("lists inputs in order of first appearance; a field path makes an input json; $(…) reads a variable", () => {
    expect(templatePlaceholders("Draw {{name}} in {{ style }} style, {{name}}!")).toEqual({
      inputs: [{ name: "name", json: false }, { name: "style", json: false }],
      variables: [],
    });
    expect(templatePlaceholders("{{kamil.ali}} {{kamil}} {{list[0].x}} {{$(user name)}} {{$(user name).city}}")).toEqual({
      inputs: [{ name: "kamil", json: true }, { name: "list", json: true }],
      variables: ["user name"],
    });
    expect(templatePlaceholders("no placeholders")).toEqual({ inputs: [], variables: [] });
    expect(templatePlaceholders("\\{{literal}} { single } }}")).toEqual({ inputs: [], variables: [] });
  });

  it("invalid placeholder → text.invalid_placeholder; unclosed {{ → text.invalid_template", () => {
    for (const bad of ["{{1abc}}", "{{a b}}", "{{}}", "{{a-b}}", "{{$()}}", "{{$(x}}", "{{a.}}", "{{a[x]}}"]) {
      const r = templatePlaceholders(bad) as PortError;
      expect(r.error.code, bad).toBe("text.invalid_placeholder");
      expect(typeof r.error.message).toBe("string");
    }
    expect((templatePlaceholders("Hello {{name") as PortError).error.code).toBe("text.invalid_template");
  });

  it("renderTemplate uses toText, field paths, variables and literal braces", () => {
    expect(renderTemplate("Hi {{name}} \\{{ok}} {x}", { name: "Aria" })).toBe("Hi Aria {{ok}} {x}");
    expect(renderTemplate("{{a}}|{{b}}|{{c}}|{{d}}", { a: 1, b: null, c: [1, 2], d: true })).toBe("1||[1,2]|true");
    expect(renderTemplate("{{m}}", { m: { mediaId: "med_9" } }, { m: ir.image() })).toBe("med_9");
    expect(renderTemplate("{{u.name}} {{u.tags[1]}} {{u.tags}}", { u: { name: "Aria", tags: ["a", "b"] } })).toBe('Aria b ["a","b"]');
    expect(renderTemplate("{{$(city)}} {{$(user).age}}", {}, undefined, (n) => (n === "city" ? "Rome" : { age: 9 }))).toBe("Rome 9");
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(code(() => renderTemplate("{{oops", {}))).toBe("text.invalid_template");
    expect(code(() => renderTemplate("{{u.missing}}", { u: {} }))).toBe("json.field_missing");
  });
});

describe("text.template", () => {
  it("has one generic input per distinct placeholder named T1…Tn, and output text", async () => {
    const r = await runNode(textTemplate, { name: "Aria", style: 2 }, { config: { template: "{{name}} in {{style}}, {{name}}" } });
    expect(r.ports.inputs.map((p) => [p.name, p.declaredType])).toEqual([
      ["name", { kind: "var", name: "T1" }],
      ["style", { kind: "var", name: "T2" }],
    ]);
    expect(r.ports.outputs.map((p) => [p.name, p.type])).toEqual([["text", { kind: "primitive", name: "text" }]]);
    expect(r.outputs).toEqual({ text: "Aria in 2, Aria" });
  });

  it("resolvePorts returns a PortError for bad templates (the node then has no ports)", () => {
    const scope = { flow: { id: "f", inputs: [], outputs: [], variables: [] }, globals: [], resolveType: () => undefined };
    const bad = textTemplate.resolvePorts!({ config: { template: "{{9}}" }, scope }) as PortError;
    expect(bad.error.code).toBe("text.invalid_placeholder");
    const unclosed = textTemplate.resolvePorts!({ config: { template: "{{a" }, scope }) as PortError;
    expect(unclosed.error.code).toBe("text.invalid_template");
    const unknown = textTemplate.resolvePorts!({ config: { template: "{{$(nope)}}" }, scope }) as PortError;
    expect(unknown.error.code).toBe("text.unknown_variable");
  });

  it("a field path makes a json input; variables add no input", () => {
    const scope = {
      flow: { id: "f", inputs: [], outputs: [], variables: [{ id: "var_c", name: "city", type: ir.text(), access: "private" as const }] },
      globals: [],
      resolveType: () => undefined,
    };
    const ports = textTemplate.resolvePorts!({ config: { template: "{{who}} from {{user.city}} in {{$(city)}}" }, scope });
    expect(ports).toEqual({
      inputs: { who: { kind: "typeSpec", ref: { kind: "var", name: "T1" } }, user: { kind: "typeSpec", ref: { kind: "primitive", name: "json" } } },
      outputs: { text: { kind: "typeSpec", ref: { kind: "primitive", name: "text" } } },
    });
  });

  it("renders values with toText, using bound media types", async () => {
    const r = await runNode(
      textTemplate,
      { img: { mediaId: "med_1" }, list: ["a"], nothing: null },
      { config: { template: "{{img}} {{list}} [{{nothing}}] \\{{x}}" }, typeBindings: { T1: ir.image() } },
    );
    expect(r.outputs.text).toBe('med_1 ["a"] [] {{x}}');
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
    const media = await runNode(convertToText, { value: { mediaId: "med_1" } }, { typeBindings: { T: ir.image() } });
    expect(media.outputs).toEqual({ text: "med_1" });
  });

  it.each([
    ["42", 42],
    ["  -7\n", -7],
    ["+3", 3],
    ["0", 0],
    ["-0", 0],
    ["007", 7],
  ])("convert.asInt %j → %i", async (text, value) => {
    const r = await runNode(convertAsInt, { value: text });
    expect(r.outputs).toEqual({ value });
    expect(Object.is(r.outputs.value, -0)).toBe(false);
  });

  it.each(["", " ", "1.5", "12abc", "abc", "0x10", "1e3", "1 2", "9007199254740993", "Infinity", "--1"])(
    "convert.asInt %j → convert.invalid_number",
    async (text) => {
      const err = await rejects(runNode(convertAsInt, { value: text }));
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
  ])("convert.asFloat %j → %d", async (text, value) => {
    expect((await runNode(convertAsFloat, { value: text })).outputs).toEqual({ value });
  });

  it.each(["", "abc", "1.2.3", "NaN", "Infinity", "-Infinity", "1e999", "0x1A", "1,5", "."])("convert.asFloat %j → convert.invalid_number", async (text) => {
    expect((await rejects(runNode(convertAsFloat, { value: text }))).code).toBe("convert.invalid_number");
  });

  it("As int / As float read json the same way: through its text", async () => {
    const json = { typeBindings: { T: ir.json() } };
    expect((await runNode(convertAsInt, { value: 7 }, json)).outputs).toEqual({ value: 7 });
    expect((await runNode(convertAsInt, { value: "12" }, json)).outputs).toEqual({ value: 12 });
    expect((await runNode(convertAsFloat, { value: 1.5 }, json)).outputs).toEqual({ value: 1.5 });
    expect((await rejects(runNode(convertAsInt, { value: 2.5 }, json))).code).toBe("convert.invalid_number");
    expect((await rejects(runNode(convertAsInt, { value: true }, json))).code).toBe("convert.invalid_number");
    expect((await rejects(runNode(convertAsFloat, { value: null }, json))).code).toBe("convert.invalid_number");
  });

  it("As int / As float take only text or json", () => {
    const port = convertAsInt.inputs.value;
    expect(port.ref).toEqual({ kind: "var", name: "T", oneOf: [ir.text(), ir.json()] });
  });

  it.each([
    [null, false],
    [0, false],
    [3, true],
    [-1.5, true],
    ["", false],
    [" False ", false],
    ["0", false],
    ["no", false],
    ["off", false],
    ["yes", true],
    ["anything", true],
    [[], true],
    [{}, true],
    [true, true],
  ])("convert.asBoolean %j → %s", async (value, expected) => {
    expect((await runNode(convertAsBoolean, { value }, { typeBindings: { T: ir.json() } })).outputs).toEqual({ value: expected });
  });

  it("As JSON keeps the text as it is; As JSON array reads an array from text or json", async () => {
    expect((await runNode(convertAsJson, { text: "{not json" })).outputs).toEqual({ json: "{not json" });
    expect((await runNode(convertAsJsonArray, { value: ' [1, {"a": 2}] ' })).outputs).toEqual({ items: [1, { a: 2 }] });
    expect((await runNode(convertAsJsonArray, { value: ["x"] }, { typeBindings: { T: ir.json() } })).outputs).toEqual({ items: ["x"] });
    expect((await rejects(runNode(convertAsJsonArray, { value: "{}" }))).code).toBe("json.wrong_kind");
    expect((await rejects(runNode(convertAsJsonArray, { value: "[1," }))).code).toBe("json.invalid_json");
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

describe("json nodes", () => {
  const order = { items: [{ id: 1, tags: ["a"] }, { id: 2.5 }], note: "hi", ok: true };

  it("Get field reads object fields and array items; the whole value for an empty path", async () => {
    expect((await runNode(jsonGetField, { json: order, path: "items[0].tags[0]" })).outputs).toEqual({ value: "a" });
    expect((await runNode(jsonGetField, { json: [10, 20], path: "[1]" })).outputs).toEqual({ value: 20 });
    expect((await runNode(jsonGetField, { json: order, path: "" })).outputs).toEqual({ value: order });
  });

  it("Get field fails at run time for a missing field or a bad path", async () => {
    const missing = await rejects(runNode(jsonGetField, { json: order, path: "items[5].id" }));
    expect(missing.code).toBe("json.field_missing");
    expect(missing.message).toContain("items has 2 items");
    expect((await rejects(runNode(jsonGetField, { json: order, path: "ok.length" }))).code).toBe("json.field_missing");
    // A string is JSON text until read: going into one parses it.
    expect((await rejects(runNode(jsonGetField, { json: order, path: "note.length" }))).code).toBe("json.invalid_json");
    expect((await rejects(runNode(jsonGetField, { json: order, path: "items[x]" }))).code).toBe("json.invalid_path");
    expect((await rejects(runNode(jsonGetField, { json: order, path: "a..b" }))).code).toBe("json.invalid_path");
  });

  it("Set field replaces, creates missing objects and appends one past the end; the input is not changed", async () => {
    const input = { a: { b: 1 }, list: [1] };
    expect((await runNode(jsonSetField, { json: input, path: "a.b", value: 2 })).outputs).toEqual({ json: { a: { b: 2 }, list: [1] } });
    expect((await runNode(jsonSetField, { json: input, path: "x.y.z", value: true })).outputs.json).toMatchObject({ x: { y: { z: true } } });
    expect((await runNode(jsonSetField, { json: input, path: "list[1]", value: 2 })).outputs.json).toMatchObject({ list: [1, 2] });
    expect((await rejects(runNode(jsonSetField, { json: input, path: "list[3]", value: 2 }))).code).toBe("json.field_missing");
    expect(input).toEqual({ a: { b: 1 }, list: [1] });
  });

  it("Add field fails on an existing field unless overwrite is on", async () => {
    expect((await runNode(jsonAddField, { json: { a: 1 }, path: "b", value: 2 })).outputs).toEqual({ json: { a: 1, b: 2 } });
    expect((await rejects(runNode(jsonAddField, { json: { a: 1 }, path: "a", value: 2 }))).code).toBe("json.field_exists");
    expect((await runNode(jsonAddField, { json: { a: 1 }, path: "a", value: 2, overwrite: true })).outputs).toEqual({ json: { a: 2 } });
  });

  it("text from As JSON is parsed when a field is read: valid text works, invalid text fails there", async () => {
    const text = (await runNode(convertAsJson, { text: '{"ali": "kamil", "n": [1, 2]}' })).outputs.json;
    const ali = (await runNode(jsonGetField, { json: text, path: "ali" })).outputs.value;
    expect(ali).toBe("kamil");
    expect((await runNode(convertToText, { value: ali }, { typeBindings: { T: ir.json() } })).outputs).toEqual({ text: "kamil" });
    expect((await runNode(jsonGetField, { json: text, path: "n[1]" })).outputs).toEqual({ value: 2 });
    expect((await runNode(jsonSetField, { json: text, path: "n[2]", value: 3 })).outputs.json).toEqual({ ali: "kamil", n: [1, 2, 3] });
    const bad = await rejects(runNode(jsonGetField, { json: "{ali:", path: "ali" }));
    expect(bad.code).toBe("json.invalid_json");
    expect(bad.message).toContain("is text that is not valid JSON");
    expect((await runNode(jsonGetField, { json: "{ali:", path: "" })).outputs).toEqual({ value: "{ali:" });
  });

  it("As text renders any JSON without failing", async () => {
    expect((await runNode(convertToText, { value: { b: [1], a: "x" } }, { typeBindings: { T: ir.json() } })).outputs).toEqual({ text: '{"a":"x","b":[1]}' });
    expect((await runNode(convertToText, { value: "plain" }, { typeBindings: { T: ir.json() } })).outputs).toEqual({ text: "plain" });
  });

  it("json inputs reject values that are not JSON", async () => {
    expect((await rejects(runNode(jsonGetField, { json: Number.NaN, path: "" }))).code).toBe("node.invalid_input");
  });
});
