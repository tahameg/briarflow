/**
 * node-api.md §3.4: conversion nodes, `findConversions`, and generics limited by `oneOf`.
 */
import { describe, expect, it } from "vitest";
import { bindTypeVars, createCatalog, defineNode, definePack, findConversions, t, toNodeDescriptor } from "../src/index.js";
import type { TypeRef } from "../src/index.js";

const p = (name: string) => ({ kind: "primitive", name }) as TypeRef;

const asText = defineNode({ type: "convert.toText", title: "As text", pure: true, conversion: true, inputs: { value: t.var("T") }, outputs: { text: t.text() }, run: () => ({ text: "" }) });
const asInt = defineNode({
  type: "convert.asInt",
  title: "As int",
  pure: true,
  conversion: true,
  inputs: { value: t.var("T", { oneOf: [t.text(), t.json()] }) },
  outputs: { value: t.int() },
  run: () => ({ value: 0 }),
});
const asJson = defineNode({ type: "convert.asJson", title: "As JSON", pure: true, conversion: true, inputs: { text: t.text() }, outputs: { json: t.json() }, run: () => ({ json: null }) });
const floatToInt = defineNode({
  type: "convert.floatToInt",
  title: "Float to int",
  pure: true,
  conversion: true,
  inputs: { value: t.float(), mode: { type: t.text(), default: "round" } },
  outputs: { value: t.int() },
  run: () => ({ value: 0 }),
});
const notConversion = defineNode({ type: "convert.shout", pure: true, inputs: { text: t.text() }, outputs: { text: t.text() }, run: ({ inputs }) => inputs });
const catalog = createCatalog([definePack({ name: "c", version: "1.0.0", namespaces: ["convert"], nodes: [asText, asInt, asJson, floatToInt, notConversion] })]);

describe("defineNode conversion", () => {
  it("is kept on the definition and the descriptor", () => {
    expect(asInt.conversion).toBe(true);
    expect(toNodeDescriptor(asInt, { name: "c", version: "1.0.0" }).conversion).toBe(true);
    expect(notConversion.conversion).toBeUndefined();
  });

  it.each([
    [{ inputs: { a: t.text() }, outputs: { b: t.text() } }, "must be pure"],
    [{ pure: true, inputs: {}, outputs: { b: t.text() } }, "needs an input"],
    [{ pure: true, inputs: { a: t.text() }, outputs: { b: t.text(), c: t.text() } }, "exactly one output"],
    [{ pure: true, inputs: { a: t.text(), b: t.int() }, outputs: { c: t.text() } }, 'conversion input "b" needs a default'],
  ])("rejects a conversion node that breaks the rules (%#)", (parts, message) => {
    expect(() => defineNode({ type: "convert.bad", conversion: true, run: () => ({}) as never, ...(parts as object) })).toThrow(message);
  });
});

describe("findConversions", () => {
  it("finds the node that turns one type into another, best first", () => {
    expect(findConversions(catalog, p("json"), p("text")).map((c) => c.type)).toEqual(["convert.toText"]);
    expect(findConversions(catalog, p("text"), p("json"))).toEqual([{ type: "convert.asJson", title: "As JSON", input: "text", output: "json" }]);
    expect(findConversions(catalog, p("json"), p("int")).map((c) => c.type)).toEqual(["convert.asInt"]);
    expect(findConversions(catalog, p("float"), p("int")).map((c) => c.type)).toEqual(["convert.floatToInt"]);
    expect(findConversions(catalog, p("text"), p("int")).map((c) => c.type)).toEqual(["convert.asInt"]);
  });

  it("returns nothing when no conversion fits, and ignores other pure nodes", () => {
    expect(findConversions(catalog, p("int"), p("json"))).toEqual([]);
    expect(findConversions(catalog, p("boolean"), p("int"))).toEqual([]);
    expect(findConversions(catalog, { kind: "var", name: "T" }, p("text"))).toEqual([]);
  });
});

describe("oneOf generics", () => {
  it("bind to a type that fits one of them and refuse the rest", () => {
    const pattern: TypeRef = { kind: "var", name: "T", oneOf: [p("text"), p("json")] };
    expect(bindTypeVars([{ port: "value", direction: "input", pattern, other: p("json") }])).toEqual({ ok: true, bindings: { T: p("json") } });
    const r = bindTypeVars([{ port: "value", direction: "input", pattern, other: p("int") }]);
    expect(r).toMatchObject({ ok: false, conflict: { varName: "T", port: "value", other: p("int"), allowed: [p("text"), p("json")] } });
  });

  it("t.var needs concrete oneOf types", () => {
    expect(() => t.var("T", { oneOf: [] })).toThrow("oneOf must list at least one concrete type");
    expect(() => t.var("T", { oneOf: [t.var("U")] })).toThrow("oneOf must list at least one concrete type");
  });
});
