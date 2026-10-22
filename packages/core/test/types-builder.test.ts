/**
 * `t` builder, `defineStruct`, `defineEnum` (phase-1.md §5.3; node-api.md §3, §7; types.md §6).
 */
import { describe, expect, it } from "vitest";
import {
  PackDefinitionError,
  TypeDefinitionError,
  defineEnum,
  defineStruct,
  isTypeSpec,
  t,
  type TypeRef,
  type TypeSpec,
} from "@briarflow/core";
import { expectBriarError } from "@briarflow/testing";

describe("t builder IR (types.md §2)", () => {
  const cases: [string, () => TypeSpec<unknown>, TypeRef][] = [
    ["text", () => t.text(), { kind: "primitive", name: "text" }],
    ["text {}", () => t.text({}), { kind: "primitive", name: "text" }],
    [
      "text constraints",
      () => t.text({ minLength: 1, maxLength: 40, pattern: "[a-z]+", multiline: true }),
      { kind: "primitive", name: "text", constraints: { minLength: 1, maxLength: 40, pattern: "[a-z]+", multiline: true } },
    ],
    ["int", () => t.int(), { kind: "primitive", name: "int" }],
    ["int bounds", () => t.int({ min: 0, max: 120 }), { kind: "primitive", name: "int", constraints: { min: 0, max: 120 } }],
    ["float", () => t.float({ min: -1.5 }), { kind: "primitive", name: "float", constraints: { min: -1.5 } }],
    ["boolean", () => t.boolean(), { kind: "primitive", name: "boolean" }],
    ["image", () => t.image(), { kind: "primitive", name: "image" }],
    [
      "image constraints",
      () => t.image({ formats: ["png", "jpeg"], maxBytes: 1000, minWidth: 1, maxWidth: 10, minHeight: 2, maxHeight: 20 }),
      {
        kind: "primitive",
        name: "image",
        constraints: { formats: ["png", "jpeg"], maxBytes: 1000, minWidth: 1, maxWidth: 10, minHeight: 2, maxHeight: 20 },
      },
    ],
    ["video", () => t.video({ maxDurationSec: 30 }), { kind: "primitive", name: "video", constraints: { maxDurationSec: 30 } }],
    ["audio", () => t.audio(), { kind: "primitive", name: "audio" }],
    ["model3d", () => t.model3d({ formats: ["glb"] }), { kind: "primitive", name: "model3d", constraints: { formats: ["glb"] } }],
    ["file", () => t.file(), { kind: "primitive", name: "file" }],
    ["list", () => t.list(t.text()), { kind: "list", of: { kind: "primitive", name: "text" } }],
    ["list {}", () => t.list(t.text(), {}), { kind: "list", of: { kind: "primitive", name: "text" } }],
    [
      "list bounds",
      () => t.list(t.image(), { minItems: 1, maxItems: 4 }),
      { kind: "list", of: { kind: "primitive", name: "image" }, minItems: 1, maxItems: 4 },
    ],
    ["optional", () => t.optional(t.int()), { kind: "optional", of: { kind: "primitive", name: "int" } }],
    [
      "list of optional",
      () => t.list(t.optional(t.text())),
      { kind: "list", of: { kind: "optional", of: { kind: "primitive", name: "text" } } },
    ],
    ["ref by id", () => t.ref("ty_char"), { kind: "named", id: "ty_char" }],
    ["ref qualified", () => t.ref("openai.ChatMessage"), { kind: "named", id: "openai.ChatMessage" }],
    ["var", () => t.var("T"), { kind: "var", name: "T" }],
    ["fromRef", () => t.fromRef({ kind: "list", of: { kind: "named", id: "ty_x" } }), { kind: "list", of: { kind: "named", id: "ty_x" } }],
  ];

  it.each(cases)("%s", (_label, build, expected) => {
    const spec = build();
    expect(spec.kind).toBe("typeSpec");
    expect(isTypeSpec(spec)).toBe(true);
    expect(spec.ref).toEqual(expected);
  });

  it("empty options produce no constraints key", () => {
    expect("constraints" in t.text({}).ref).toBe(false);
    expect("constraints" in t.int().ref).toBe(false);
    expect("constraints" in t.image({}).ref).toBe(false);
    expect("minItems" in t.list(t.text(), {}).ref).toBe(false);
    expect("maxItems" in t.list(t.text()).ref).toBe(false);
  });

  it("does not share the caller's constraint object", () => {
    const constraints = { min: 0 };
    const spec = t.int(constraints);
    constraints.min = 5;
    expect(spec.ref).toEqual({ kind: "primitive", name: "int", constraints: { min: 0 } });
  });

  it("isTypeSpec rejects other values", () => {
    expect(isTypeSpec({ kind: "primitive", name: "text" })).toBe(false);
    expect(isTypeSpec(null)).toBe(false);
    expect(isTypeSpec("text")).toBe(false);
  });

  it("t.parse keeps names unresolved", () => {
    expect(t.parse("list<Character?>").ref).toEqual({
      kind: "list",
      of: { kind: "optional", of: { kind: "named", id: "Character" } },
    });
    expect(t.parse("openai.ChatMessage").ref).toEqual({ kind: "named", id: "openai.ChatMessage" });
    expect(t.parse("list<image>[..4]").ref).toEqual({ kind: "list", of: { kind: "primitive", name: "image" }, maxItems: 4 });
  });

  it("t.parse accepts generic vars (node definitions)", () => {
    expect(t.parse("list<$T>").ref).toEqual({ kind: "list", of: { kind: "var", name: "T" } });
  });

  it("t.parse throws TypeDefinitionError type.syntax on bad shorthand", () => {
    expectBriarError(() => t.parse("list<text"), "type.syntax", TypeDefinitionError);
  });
});

describe("t builder constraint validation (types.md §6)", () => {
  const invalid: [string, () => unknown][] = [
    ["int min > max", () => t.int({ min: 5, max: 1 })],
    ["float min > max", () => t.float({ min: 2, max: 1 })],
    ["int non-integer min", () => t.int({ min: 1.5 })],
    ["int non-integer max", () => t.int({ max: 2.5 })],
    ["int unsafe bound", () => t.int({ max: 2 ** 60 })],
    ["text negative minLength", () => t.text({ minLength: -1 })],
    ["text negative maxLength", () => t.text({ maxLength: -1 })],
    ["text minLength > maxLength", () => t.text({ minLength: 5, maxLength: 2 })],
    ["text fractional maxLength", () => t.text({ maxLength: 1.5 })],
    ["text regex that does not compile", () => t.text({ pattern: "(" })],
    ["text regex invalid with the u flag", () => t.text({ pattern: "\\c" })],
    ["image negative maxBytes", () => t.image({ maxBytes: -1 })],
    ["file negative maxBytes", () => t.file({ maxBytes: -5 })],
    ["image minWidth > maxWidth", () => t.image({ minWidth: 10, maxWidth: 5 })],
    ["image negative minHeight", () => t.image({ minHeight: -1 })],
    ["video negative maxDurationSec", () => t.video({ maxDurationSec: -1 })],
    ["list negative minItems", () => t.list(t.text(), { minItems: -1 })],
    ["list minItems > maxItems", () => t.list(t.text(), { minItems: 3, maxItems: 1 })],
    ["list fractional maxItems", () => t.list(t.text(), { maxItems: 1.5 })],
  ];

  it.each(invalid)("%s throws type.invalid_constraint", (_label, build) => {
    const error = expectBriarError(build, "type.invalid_constraint", TypeDefinitionError);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("accepts boundary constraints", () => {
    expect(() => t.int({ min: 3, max: 3 })).not.toThrow();
    expect(() => t.text({ minLength: 0, maxLength: 0 })).not.toThrow();
    expect(() => t.list(t.text(), { minItems: 2, maxItems: 2 })).not.toThrow();
    expect(() => t.float({ min: -0.5, max: 0.5 })).not.toThrow();
    expect(() => t.image({ maxBytes: 0 })).not.toThrow();
  });

  it("optional of optional throws type.syntax", () => {
    expectBriarError(() => t.optional(t.optional(t.text())), "type.syntax", TypeDefinitionError);
  });

  it.each(["t", "T_1", "1T", "", "TooLongVariableName"])("t.var(%j) throws type.invalid_name", (name) => {
    expectBriarError(() => t.var(name), "type.invalid_name", TypeDefinitionError);
  });

  it("t.var accepts valid var names", () => {
    expect(t.var("Item").ref).toEqual({ kind: "var", name: "Item" });
    expect(t.var("T1").ref).toEqual({ kind: "var", name: "T1" });
  });
});

describe("defineEnum", () => {
  it("builds an enum decl with the bare name as id", () => {
    const Role = defineEnum("Role", ["system", "user", { value: "assistant", label: "AI" }], { description: "Who speaks" });
    expect(Role.kind).toBe("enumType");
    expect(Role.decl).toEqual({
      kind: "enum",
      id: "Role",
      name: "Role",
      description: "Who speaks",
      members: [{ value: "system" }, { value: "user" }, { value: "assistant", label: "AI" }],
    });
  });

  it("t.ref(enum) refers to it by its (bare) id", () => {
    const Role = defineEnum("Role", ["a"]);
    expect(t.ref(Role).ref).toEqual({ kind: "named", id: "Role" });
  });

  it.each([
    ["lowercase name", () => defineEnum("role", ["a"])],
    ["reserved name", () => defineEnum("Text", ["a"])],
    ["name with a dot", () => defineEnum("openai.Role", ["a"])],
    ["duplicate members", () => defineEnum("Role", ["a", "a"])],
    ["duplicate members (object form)", () => defineEnum("Role", ["a", { value: "a", label: "A" }])],
    ["invalid member value", () => defineEnum("Role", ["-a"])],
    ["empty label", () => defineEnum("Role", [{ value: "a", label: "" }])],
  ])("%s throws pack.invalid", (_label, build) => {
    expectBriarError(build, "pack.invalid", PackDefinitionError);
  });
});

describe("defineStruct", () => {
  it("keeps field order and metadata", () => {
    const Role = defineEnum("Role", ["system", "user"]);
    const ChatMessage = defineStruct(
      "ChatMessage",
      {
        role: t.ref(Role),
        content: t.text(),
        name: { type: t.optional(t.text()), description: "Optional speaker name" },
        tokens: { type: t.int({ min: 0 }), default: 0 },
      },
      { description: "A chat message" },
    );
    expect(ChatMessage.kind).toBe("structType");
    expect(ChatMessage.decl).toEqual({
      kind: "struct",
      id: "ChatMessage",
      name: "ChatMessage",
      description: "A chat message",
      fields: [
        { name: "role", type: { kind: "named", id: "Role" } },
        { name: "content", type: { kind: "primitive", name: "text" } },
        { name: "name", type: { kind: "optional", of: { kind: "primitive", name: "text" } }, description: "Optional speaker name" },
        { name: "tokens", type: { kind: "primitive", name: "int", constraints: { min: 0 } }, default: 0 },
      ],
    });
    expect(t.ref(ChatMessage).ref).toEqual({ kind: "named", id: "ChatMessage" });
  });

  it("allows a struct without fields", () => {
    expect(defineStruct("Empty", {}).decl.fields).toEqual([]);
  });

  it.each([
    ["invalid name", () => defineStruct("chatMessage", { a: t.text() })],
    ["reserved name", () => defineStruct("List", { a: t.text() })],
    ["invalid field name", () => defineStruct("S", { "1x": t.text() })],
    ["reserved field name", () => defineStruct("S", { constructor: t.text() })],
    ["fields differing only in case", () => defineStruct("S", { name: t.text(), Name: t.text() })],
    ["default violating a constraint", () => defineStruct("S", { age: { type: t.int({ min: 0 }), default: -1 } })],
    ["default of the wrong type", () => defineStruct("S", { age: { type: t.int(), default: "x" as unknown as number } })],
  ])("%s throws pack.invalid", (_label, build) => {
    expectBriarError(build, "pack.invalid", PackDefinitionError);
  });
});
