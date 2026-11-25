import { describe, expect, expectTypeOf, it } from "vitest";
import { createTypeScope, defineNode, emptyValue, formatType, isAssignable, jsonText, parseJsonText, parseType, t, toJsonSchema, validateValue, type InputsOf, type JsonText } from "@briarflow/core";
import { ir } from "@briarflow/testing";

const scope = createTypeScope({});
const probe = defineNode({ type: "test.json", inputs: { j: t.json() }, run: () => ({}) });

describe("Json (built-in struct)", () => {
  it("t.json() is the built-in Json and types values as { text }", () => {
    expect(t.json().ref).toEqual({ kind: "named", id: "briar.Json" });
    expectTypeOf<InputsOf<typeof probe>["j"]>().toEqualTypeOf<JsonText>();
  });

  it("holds any JSON document as text, including null and a root array", () => {
    for (const v of [{ a: [1, "x", null, { b: true }] }, [1, 2], "text", 3.5, false, null]) {
      const value = jsonText(v);
      expect(validateValue(value, ir.json(), scope), JSON.stringify(v)).toEqual([]);
      expect(parseJsonText(value)).toEqual(v);
    }
  });

  it("rejects values that are not { text }", () => {
    for (const v of [{ a: 1 }, "raw", 3, { text: 3 }, { text: "1", extra: 1 }]) {
      expect(validateValue(v, ir.json(), scope)[0]?.code).toBe("value.invalid");
    }
  });

  it("is only assignable to Json (casts are explicit nodes)", () => {
    expect(isAssignable(ir.json(), ir.json())).toBe(true);
    expect(isAssignable(ir.json(), ir.string())).toBe(false);
    expect(isAssignable(ir.string(), ir.json())).toBe(false);
  });

  it("parses, formats, has an object JSON Schema with text and an empty value of null", () => {
    expect(parseType("Json")).toMatchObject({ ok: true, type: ir.json() });
    expect(formatType(ir.list(ir.json()))).toBe("list<Json>");
    expect(toJsonSchema(ir.json(), scope)).toMatchObject({ $ref: "#/$defs/Json" });
    expect(emptyValue(ir.json())).toBeNull();
  });
});
