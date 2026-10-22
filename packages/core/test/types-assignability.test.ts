/**
 * Assignability, type equality and generics (phase-1.md §5.5; types.md §4, §5).
 */
import { describe, expect, it } from "vitest";
import {
  bindTypeVars,
  collectTypeVars,
  isAssignable,
  joinTypes,
  meetTypes,
  stripConstraints,
  substituteTypeVars,
  typeEquals,
  type GenericConnection,
  type TypeRef,
} from "@briarflow/core";
import { ir } from "@briarflow/testing";

const text = ir.text();
const int = ir.int();
const float = ir.float();
const X = ir.named("ty_x");
const Y = ir.named("ty_y");

describe("isAssignable (types.md §4 table)", () => {
  const rows: [string, TypeRef, TypeRef, boolean][] = [
    // primitive p
    ["text → text", text, text, true],
    ["int → int", int, int, true],
    ["boolean → boolean", ir.boolean(), ir.boolean(), true],
    ["image → image", ir.image(), ir.image(), true],
    ["int → float", int, float, true],
    ["float → float", float, float, true],
    ["float → int", float, int, false],
    ["text → float", text, float, false],
    ["boolean → float", ir.boolean(), float, false],
    ["int → text (no implicit text)", int, text, false],
    ["boolean → text", ir.boolean(), text, false],
    ["text → int", text, int, false],
    ["text → named", text, X, false],
    ["text → list<text>", text, ir.list(text), false],
    ["text → text?", text, ir.optional(text), true],
    ["int → float?", int, ir.optional(float), true],
    ["int → text?", int, ir.optional(text), false],
    // media never convert
    ["image → file", ir.image(), ir.file(), false],
    ["file → image", ir.file(), ir.image(), false],
    ["video → audio", ir.video(), ir.audio(), false],
    ["image → text", ir.image(), text, false],
    ["model3d → model3d?", ir.model3d(), ir.optional(ir.model3d()), true],
    // named X
    ["X → X", X, X, true],
    ["X → Y", X, Y, false],
    ["X → text", X, text, false],
    ["X → float", X, float, false],
    ["X → list<X>", X, ir.list(X), false],
    ["X → X?", X, ir.optional(X), true],
    ["X → Y?", X, ir.optional(Y), false],
    // list<A>
    ["list<text> → text", ir.list(text), text, false],
    ["list<int> → float", ir.list(int), float, false],
    ["list<X> → X", ir.list(X), X, false],
    ["list<int> → list<float>", ir.list(int), ir.list(float), true],
    ["list<float> → list<int>", ir.list(float), ir.list(int), false],
    ["list<X> → list<X>", ir.list(X), ir.list(X), true],
    ["list<X> → list<X?>", ir.list(X), ir.list(ir.optional(X)), true],
    ["list<X?> → list<X>", ir.list(ir.optional(X)), ir.list(X), false],
    ["list<text> → list<text>?", ir.list(text), ir.optional(ir.list(text)), true],
    ["list<list<int>> → list<list<float>>", ir.list(ir.list(int)), ir.list(ir.list(float)), true],
    // A?
    ["text? → text", ir.optional(text), text, false],
    ["int? → float", ir.optional(int), float, false],
    ["X? → X", ir.optional(X), X, false],
    ["text? → list<text>", ir.optional(text), ir.list(text), false],
    ["text? → text?", ir.optional(text), ir.optional(text), true],
    ["int? → float?", ir.optional(int), ir.optional(float), true],
    ["X? → Y?", ir.optional(X), ir.optional(Y), false],
    // var never assignable
    ["$T → text", ir.var("T"), text, false],
    ["text → $T", text, ir.var("T"), false],
    ["$T → $T", ir.var("T"), ir.var("T"), false],
    ["list<$T> → list<text>", ir.list(ir.var("T")), ir.list(text), false],
  ];

  it.each(rows)("%s", (_label, from, to, expected) => {
    expect(isAssignable(from, to)).toBe(expected);
  });

  it("ignores constraints and list bounds", () => {
    expect(isAssignable(ir.text({ maxLength: 10 }), ir.text({ maxLength: 5 }))).toBe(true);
    expect(isAssignable(ir.int({ min: -5 }), ir.float({ min: 0 }))).toBe(true);
    expect(isAssignable(ir.image({ formats: ["gif"] }), ir.image({ formats: ["png"] }))).toBe(true);
    expect(isAssignable(ir.list(text, { maxItems: 10 }), ir.list(text, { maxItems: 1 }))).toBe(true);
  });
});

describe("typeEquals / stripConstraints", () => {
  it("compares structurally", () => {
    expect(typeEquals(ir.list(X), ir.list(ir.named("ty_x")))).toBe(true);
    expect(typeEquals(X, Y)).toBe(false);
    expect(typeEquals(int, float)).toBe(false);
    expect(typeEquals(ir.optional(text), text)).toBe(false);
    expect(typeEquals(ir.var("T"), ir.var("T"))).toBe(true);
    expect(typeEquals(ir.var("T"), ir.var("U"))).toBe(false);
  });

  it("respects constraints unless ignoreConstraints", () => {
    expect(typeEquals(ir.text({ maxLength: 3 }), text)).toBe(false);
    expect(typeEquals(ir.text({ maxLength: 3 }), text, { ignoreConstraints: true })).toBe(true);
    expect(typeEquals(ir.list(text, { maxItems: 1 }), ir.list(text))).toBe(false);
    expect(typeEquals(ir.list(text, { maxItems: 1 }), ir.list(text), { ignoreConstraints: true })).toBe(true);
  });

  it("ignores constraint key order", () => {
    expect(typeEquals(ir.int({ min: 0, max: 1 }), ir.int({ max: 1, min: 0 }))).toBe(true);
  });

  it("stripConstraints removes constraints and bounds recursively", () => {
    const input = ir.optional(ir.list(ir.list(ir.text({ maxLength: 3 }), { minItems: 1 }), { maxItems: 4 }));
    const before = structuredClone(input);
    expect(stripConstraints(input)).toEqual(ir.optional(ir.list(ir.list(text))));
    expect(input).toEqual(before);
    expect(stripConstraints(X)).toEqual(X);
  });
});

describe("collectTypeVars / substituteTypeVars", () => {
  it("collects vars in order of first appearance without duplicates", () => {
    expect(collectTypeVars(ir.list(ir.optional(ir.var("T"))))).toEqual(["T"]);
    expect(collectTypeVars(text)).toEqual([]);
  });

  it("substitutes bound vars and leaves unbound ones", () => {
    expect(substituteTypeVars(ir.optional(ir.var("T")), { T: X })).toEqual(ir.optional(X));
    expect(substituteTypeVars(ir.list(ir.var("T")), {})).toEqual(ir.list(ir.var("T")));
    expect(substituteTypeVars(ir.list(ir.var("T"), { maxItems: 2 }), { T: int })).toEqual(ir.list(int, { maxItems: 2 }));
    expect(substituteTypeVars(ir.var("U"), { T: int })).toEqual(ir.var("U"));
  });
});

describe("joinTypes / meetTypes (types.md §5.2)", () => {
  it("join", () => {
    expect(joinTypes(text, text)).toEqual(text);
    expect(joinTypes(int, float)).toEqual(float);
    expect(joinTypes(float, int)).toEqual(float);
    expect(joinTypes(X, ir.optional(X))).toEqual(ir.optional(X));
    expect(joinTypes(ir.optional(X), X)).toEqual(ir.optional(X));
    expect(joinTypes(ir.list(int), ir.list(float))).toEqual(ir.list(float));
    expect(joinTypes(text, int)).toBeUndefined();
    expect(joinTypes(X, Y)).toBeUndefined();
    expect(joinTypes(ir.image(), ir.file())).toBeUndefined();
    expect(joinTypes(ir.list(text), text)).toBeUndefined();
  });

  it("meet", () => {
    expect(meetTypes(text, text)).toEqual(text);
    expect(meetTypes(int, float)).toEqual(int);
    expect(meetTypes(float, int)).toEqual(int);
    expect(meetTypes(ir.optional(X), X)).toEqual(X);
    expect(meetTypes(X, ir.optional(X))).toEqual(X);
    expect(meetTypes(ir.list(int), ir.list(float))).toEqual(ir.list(int));
    expect(meetTypes(text, int)).toBeUndefined();
    expect(meetTypes(X, Y)).toBeUndefined();
  });
});

describe("bindTypeVars (types.md §5)", () => {
  const input = (port: string, pattern: TypeRef, other: TypeRef): GenericConnection => ({ port, direction: "input", pattern, other });
  const output = (port: string, pattern: TypeRef, other: TypeRef): GenericConnection => ({ port, direction: "output", pattern, other });
  const T = ir.var("T");

  function permutations<V>(items: readonly V[]): V[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  }

  function expectBindings(connections: GenericConnection[], bindings: Record<string, TypeRef>): void {
    for (const order of permutations(connections)) {
      expect(bindTypeVars(order)).toEqual({ ok: true, bindings });
    }
  }

  it("example §5.4: list.get fed list<Character> binds T = Character", () => {
    expectBindings([input("list", ir.list(T), ir.list(ir.named("ty_char")))], { T: ir.named("ty_char") });
  });

  it("no connections → no bindings", () => {
    expect(bindTypeVars([])).toEqual({ ok: true, bindings: {} });
  });

  it("join of input candidates: int and float → float", () => {
    expectBindings([input("a", T, int), input("b", T, float)], { T: float });
  });

  it("join of X and X? → X?", () => {
    expectBindings([input("a", T, text), input("b", T, ir.optional(text))], { T: ir.optional(text) });
  });

  it("join of lists: list<int> and list<float> → list<float>", () => {
    expectBindings([input("a", T, ir.list(int)), input("b", T, ir.list(float))], { T: ir.list(float) });
  });

  it("match(P?, X) and match(P?, X?) both bind T = X", () => {
    expectBindings([input("v", ir.optional(T), text)], { T: text });
    expectBindings([input("v", ir.optional(T), ir.optional(text))], { T: text });
  });

  it("list bounds are ignored when matching", () => {
    expectBindings([input("l", ir.list(T, { maxItems: 3 }), ir.list(int, { minItems: 1 }))], { T: int });
  });

  it("meet of upper bounds when there are no inputs: int and float → int", () => {
    expectBindings([output("o", T, int), output("p", T, float)], { T: int });
  });

  it("meet of X? and X → X", () => {
    expectBindings([output("o", T, ir.optional(X)), output("p", T, X)], { T: X });
  });

  it("output pattern T? feeding X? binds T = X", () => {
    expectBindings([output("item", ir.optional(T), ir.optional(X))], { T: X });
  });

  it("lower bound wins when it satisfies the upper bounds", () => {
    expectBindings([input("a", T, int), output("o", T, float)], { T: int });
  });

  it("constraints are dropped from bindings", () => {
    expectBindings([input("a", T, ir.text({ maxLength: 3 }))], { T: text });
    expectBindings([input("l", ir.list(T), ir.list(ir.int({ min: 0 }), { maxItems: 2 }))], { T: int });
  });

  it("several vars bind independently", () => {
    expectBindings([input("a", ir.var("A"), text), input("b", ir.var("B"), X)], { A: text, B: X });
  });

  it("concrete patterns contribute nothing", () => {
    expectBindings([input("index", int, int), input("list", ir.list(T), ir.list(text))], { T: text });
  });

  it("conflict when inputs have no join, naming var, port, bound and other", () => {
    for (const order of permutations([input("a", T, text), input("b", T, int)])) {
      const result = bindTypeVars(order);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.conflict.varName).toBe("T");
      expect(["a", "b"]).toContain(result.conflict.port);
      expect([result.conflict.bound, result.conflict.other]).toEqual(expect.arrayContaining([text, int]));
    }
  });

  it("conflict when the binding does not fit an upper bound", () => {
    const result = bindTypeVars([input("a", T, text), output("o", T, int)]);
    expect(result).toMatchObject({ ok: false, conflict: { varName: "T" } });
  });

  it("a structural mismatch (list pattern fed a non-list) binds nothing; the edge check reports it", () => {
    const result = bindTypeVars([input("l", ir.list(T), text)]);
    if (result.ok) expect(result.bindings).not.toHaveProperty("T");
  });

  it("the result is the same for every connection order", () => {
    const connections = [input("a", T, int), input("b", T, float), output("o", ir.optional(T), ir.optional(float))];
    const results = permutations(connections).map((order) => bindTypeVars(order));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toEqual({ ok: true, bindings: { T: float } });
  });
});
