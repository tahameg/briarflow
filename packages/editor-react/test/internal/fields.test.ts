import { describe, expect, it } from "vitest";
import { parseType } from "@briarflow/core";
import type { TypeRef } from "@briarflow/core";
import { nextName, shapeShorthand, toggleArray, typeShape } from "../../src/fields.js";

const t = (s: string): TypeRef => {
  const r = parseType(s);
  if (!r.ok) throw new Error(r.diagnostic.message);
  return r.type;
};

describe("typeShape / shapeShorthand", () => {
  it("round-trips every wrapper combination", () => {
    for (const s of ["string", "int?", "list<float>", "list<bool?>", "list<Image>?", "list<Audio?>?"]) {
      expect(shapeShorthand(typeShape(t(s)))).toBe(s);
    }
  });

  it("splits wrappers off the base", () => {
    expect(typeShape(t("list<int?>?"))).toEqual({ base: t("int"), array: true, optional: true, itemOptional: true });
  });

  it("swaps the base and keeps the wrappers", () => {
    expect(shapeShorthand({ ...typeShape(t("list<string>?")), base: t("Video") })).toBe("list<Video>?");
  });
});

describe("toggleArray", () => {
  it("wraps a single value in a list and unwraps it again", () => {
    expect(toggleArray(t("string"))).toBe("list<string>");
    expect(toggleArray(t("list<string>"))).toBe("string");
  });

  it("keeps optionality when switching", () => {
    expect(toggleArray(t("int?"))).toBe("list<int>?");
    expect(toggleArray(t("list<int?>"))).toBe("int?");
  });
});

describe("nextName", () => {
  it("returns the first free numbered name, ignoring case", () => {
    expect(nextName("input", [])).toBe("input1");
    expect(nextName("input", ["input1", "INPUT2", "other"])).toBe("input3");
    expect(nextName("Struct", ["Struct2"])).toBe("Struct1");
  });
});
