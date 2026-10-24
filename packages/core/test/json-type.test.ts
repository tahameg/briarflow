import { describe, expect, expectTypeOf, it } from "vitest";
import { createTypeScope, defineNode, emptyValue, formatType, isAssignable, parseType, t, toJsonSchema, validateValue, type InputsOf, type JsonValue } from "@briarflow/core";
import { ir } from "@briarflow/testing";

const scope = createTypeScope({});
const probe = defineNode({ type: "test.json", inputs: { j: t.json() }, run: () => ({}) });

describe("json primitive", () => {
  it("t.json() is the json primitive and types values as JsonValue", () => {
    expect(t.json().ref).toEqual({ kind: "primitive", name: "json" });
    expectTypeOf<InputsOf<typeof probe>["j"]>().toEqualTypeOf<JsonValue>();
  });

  it("accepts any JSON value, including null and a root array", () => {
    for (const v of [{ a: [1, "x", null, { b: true }] }, [1, 2], "text", 3.5, false, null]) {
      expect(validateValue(v, ir.json(), scope), JSON.stringify(v)).toEqual([]);
    }
  });

  it("rejects values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const v of [Number.NaN, Infinity, { a: undefined }, [() => 1], cyclic]) {
      expect(validateValue(v, ir.json(), scope)[0]?.code).toBe("value.invalid");
    }
  });

  it("is only assignable to json (casts are explicit nodes)", () => {
    expect(isAssignable(ir.json(), ir.json())).toBe(true);
    expect(isAssignable(ir.json(), ir.text())).toBe(false);
    expect(isAssignable(ir.text(), ir.json())).toBe(false);
  });

  it("parses, formats, has an open JSON Schema and an empty value of null", () => {
    expect(parseType("json")).toMatchObject({ ok: true, type: ir.json() });
    expect(formatType(ir.list(ir.json()))).toBe("list<json>");
    expect(toJsonSchema(ir.json(), scope)).toMatchObject({});
    expect(emptyValue(ir.json())).toBeNull();
  });
});
