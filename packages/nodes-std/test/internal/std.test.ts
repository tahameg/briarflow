import { describe, expect, it } from "vitest";
import { createCatalog, createMedia, createMemoryMediaRegistry, noopLogger, type AnyNodeDefinition, type ExecContext, type NodeInstance } from "@briarflow/core";
import {
  convertFloatToInt,
  convertAsFloat,
  convertAsInt,
  convertToText,
  listGet,
  listLength,
  listMake,
  renderTemplate,
  stdPack,
  templatePlaceholders,
  textJoin,
  textTemplate,
  valueToText,
  variableGet,
} from "@briarflow/nodes-std";

function ctx(): ExecContext {
  return {
    signal: new AbortController().signal,
    runId: "run_1",
    resolveType: () => undefined,
    flowId: "flow_1",
    nodeId: "n_1",
    attempt: 1,
    progress() {},
    log: noopLogger,
    media: createMedia({ registry: createMemoryMediaRegistry() }).forNode({ owner: { runId: "run_1" } }),
    secrets: { get: async () => "", read: async () => "" },
    settings: { get: async () => undefined },
    globals: { get: () => undefined },
    variables: { get: () => undefined },
    fetch: globalThis.fetch,
  };
}

async function call(def: unknown, inputs: Record<string, unknown>, config: Record<string, unknown> = {}, node: Partial<NodeInstance> = {}) {
  const d = def as AnyNodeDefinition;
  return d.run({ inputs: inputs as never, config: config as never, node: { id: "n_1", type: d.type, position: { x: 0, y: 0 }, ...node }, ctx: ctx() });
}

describe("stdPack", () => {
  it("is pack briar with the std namespaces and every §9 node except the core built-ins", () => {
    expect(stdPack).toMatchObject({ name: "briar", version: "1.0.0", namespaces: ["briar", "text", "list", "convert", "debug", "json"] });
    expect(stdPack.types.map((t) => t.id)).toEqual(["briar.RoundingMode"]);
    expect(stdPack.nodes.map((n) => n.type).sort()).toEqual(
      [
        "briar.variable.get",
        "briar.variable.set",
        "briar.global.get",
        "briar.global.set",
        "briar.struct.make",
        "briar.struct.break",
        "briar.constant",
        "briar.error.break",
        "briar.member.get",
        "briar.member.set",
        "text.template",
        "text.join",
        "list.make",
        "list.length",
        "list.get",
        "convert.toText",
        "convert.asJson",
        "convert.asInt",
        "convert.asFloat",
        "convert.asBoolean",
        "convert.asJsonArray",
        "convert.floatToInt",
        "debug.print",
        "debug.image",
        "json.construct",
        "json.getField",
        "json.setField",
        "json.addField",
      ].sort(),
    );
    const catalog = createCatalog([stdPack]);
    expect(catalog.get("briar.input")).toBeUndefined();
    expect(catalog.descriptors().every((d) => JSON.parse(JSON.stringify(d)) !== undefined)).toBe(true);
    const cached = stdPack.nodes.filter((n) => !n.cache).map((n) => n.type).sort();
    expect(cached).toEqual(["briar.global.get", "briar.global.set", "briar.variable.get", "briar.variable.set", "text.template"]);
  });

  it("qualifies the RoundingMode port of floatToInt", () => {
    const def = stdPack.nodes.find((n) => n.type === "convert.floatToInt") as AnyNodeDefinition;
    expect((def.inputs["mode"] as { type: { ref: unknown } }).type.ref).toEqual({ kind: "named", id: "briar.RoundingMode" });
  });
});

describe("text.template", () => {
  it("lists placeholders in order of first appearance; \\{{ is literal", () => {
    expect(templatePlaceholders("Draw {{name}} in {{style}} style, {{name}}! \\{{not}} }}")).toEqual({
      inputs: [{ name: "name", json: false }, { name: "style", json: false }],
      variables: [],
    });
    expect(templatePlaceholders("Hi {{")).toMatchObject({ error: { code: "text.invalid_template" } });
    expect(templatePlaceholders("Hi {{first name}}")).toMatchObject({ error: { code: "text.invalid_placeholder" } });
  });

  it("resolves one generic port per placeholder with synthetic vars T1…Tn", () => {
    const ports = textTemplate.resolvePorts?.({ config: { template: "{{character_name_that_is_long}} and {{b}}" }, scope: {} as never });
    expect(ports).toEqual({
      inputs: { character_name_that_is_long: { kind: "typeSpec", ref: { kind: "var", name: "T1" } }, b: { kind: "typeSpec", ref: { kind: "var", name: "T2" } } },
      outputs: { text: { kind: "typeSpec", ref: { kind: "primitive", name: "text" } } },
    });
  });

  it("renders values with the toText rules", async () => {
    expect(renderTemplate("{{a}}-{{b}}-{{c}}-{{d}} \\{{x}}", { a: "t", b: 1.5, c: true, d: null })).toBe("t-1.5-true- {{x}}");
    const out = await call(textTemplate, { who: { b: 2, a: [1] }, img: { mediaId: "med_9" } }, { template: "{{who}} {{img}}" });
    expect(out).toEqual({ text: '{"a":[1],"b":2} med_9' });
  });

  it("uses type bindings so struct values that look like media are rendered as JSON", async () => {
    const value = { mediaId: "x" };
    const out = await call(textTemplate, { s: value }, { template: "{{s}}" }, { typeBindings: { T1: { kind: "named", id: "ty_s" } } });
    expect(out).toEqual({ text: '{"mediaId":"x"}' });
  });
});

describe("toText", () => {
  it("follows the toText rules", async () => {
    expect(valueToText("a")).toBe("a");
    expect(valueToText(3)).toBe("3");
    expect(valueToText(false)).toBe("false");
    expect(valueToText(null)).toBe("");
    expect(valueToText({ mediaId: "med_1" }, { kind: "primitive", name: "image" })).toBe("med_1");
    expect(valueToText([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    expect(await call(convertToText, { value: 42 })).toEqual({ text: "42" });
  });
});

describe("text.join and lists", () => {
  it("joins", async () => {
    expect(await call(textJoin, { items: ["a", "b"], separator: ", " })).toEqual({ text: "a, b" });
  });

  it("list.make builds item1…itemN ports and a list", async () => {
    const ports = listMake.resolvePorts?.({ config: { count: 3 }, scope: {} as never });
    expect(Object.keys((ports as { inputs: object }).inputs)).toEqual(["item1", "item2", "item3"]);
    expect(await call(listMake, { item1: "a", item2: "b" }, { count: 2 })).toEqual({ list: ["a", "b"] });
    expect(await call(listMake, {}, { count: 0 })).toEqual({ list: [] });
  });

  it("list.length and list.get (negative index, out of range → null)", async () => {
    expect(await call(listLength, { list: [1, 2, 3] })).toEqual({ length: 3 });
    expect(await call(listGet, { list: ["a", "b", "c"], index: 1 })).toEqual({ item: "b" });
    expect(await call(listGet, { list: ["a", "b", "c"], index: -1 })).toEqual({ item: "c" });
    expect(await call(listGet, { list: ["a"], index: 5 })).toEqual({ item: null });
    expect(await call(listGet, { list: ["a"], index: -2 })).toEqual({ item: null });
  });
});

describe("conversions", () => {
  it("asInt trims and is strict", async () => {
    expect(await call(convertAsInt, { value: " -42 " })).toEqual({ value: -42 });
    await expect(call(convertAsInt, { value: "4.2" })).rejects.toMatchObject({ code: "convert.invalid_number" });
    await expect(call(convertAsInt, { value: "" })).rejects.toMatchObject({ code: "convert.invalid_number" });
    await expect(call(convertAsInt, { value: "99999999999999999999" })).rejects.toMatchObject({ code: "convert.invalid_number" });
  });

  it("asFloat trims and is strict", async () => {
    expect(await call(convertAsFloat, { value: " 3.5 " })).toEqual({ value: 3.5 });
    expect(await call(convertAsFloat, { value: "1e3" })).toEqual({ value: 1000 });
    expect(await call(convertAsFloat, { value: ".5" })).toEqual({ value: 0.5 });
    await expect(call(convertAsFloat, { value: "abc" })).rejects.toMatchObject({ code: "convert.invalid_number" });
    await expect(call(convertAsFloat, { value: "Infinity" })).rejects.toMatchObject({ code: "convert.invalid_number" });
  });

  it("floatToInt rounds half away from zero by default", async () => {
    expect(await call(convertFloatToInt, { value: 2.5, mode: "round" })).toEqual({ value: 3 });
    expect(await call(convertFloatToInt, { value: -2.5, mode: "round" })).toEqual({ value: -3 });
    expect(await call(convertFloatToInt, { value: -2.5, mode: "floor" })).toEqual({ value: -3 });
    expect(await call(convertFloatToInt, { value: -2.5, mode: "ceil" })).toEqual({ value: -2 });
    expect(await call(convertFloatToInt, { value: -2.7, mode: "trunc" })).toEqual({ value: -2 });
    expect(await call(convertFloatToInt, { value: -0.2, mode: "round" })).toEqual({ value: 0 });
  });
});

describe("variable nodes outside the engine", () => {
  it("get explains that it needs the engine", async () => {
    await expect(call(variableGet, {}, { variableId: "var_1" })).rejects.toMatchObject({ code: "node.failed" });
  });
});
