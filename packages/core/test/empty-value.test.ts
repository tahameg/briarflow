import { describe, expect, it } from "vitest";
import { emptyValue } from "@briarflow/core";
import { ir } from "@briarflow/testing";

describe("emptyValue", () => {
  it("is the zero value of text, numbers, booleans and lists", () => {
    expect(emptyValue(ir.text())).toBe("");
    expect(emptyValue(ir.int())).toBe(0);
    expect(emptyValue(ir.float())).toBe(0);
    expect(emptyValue(ir.boolean())).toBe(false);
    expect(emptyValue(ir.list(ir.text()))).toEqual([]);
  });

  it("moves numbers into their bounds", () => {
    expect(emptyValue(ir.int({ min: 3 }))).toBe(3);
    expect(emptyValue(ir.float({ max: -2 }))).toBe(-2);
    expect(emptyValue(ir.int({ min: -5, max: 5 }))).toBe(0);
  });

  it("is null for structs, enums, media, optionals and generics", () => {
    expect(emptyValue({ kind: "named", id: "ty_person" })).toBeNull();
    expect(emptyValue(ir.image())).toBeNull();
    expect(emptyValue(ir.optional(ir.text()))).toBeNull();
    expect(emptyValue({ kind: "var", name: "T" })).toBeNull();
  });
});
