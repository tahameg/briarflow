/**
 * Scopes, name resolution and the shorthand parser/printer (phase-1.md §5.4; types.md §2, §3).
 */
import { describe, expect, it } from "vitest";
import {
  createTypeScope,
  formatType,
  parseType,
  scopeForContext,
  scopeForFlow,
  type TypeRef,
  type TypeScope,
} from "@briarflow/core";
import {
  CHARACTER_ID,
  PORTRAIT_FLOW_ID,
  editFlow,
  enumType,
  expectBriarError,
  field,
  ir,
  portraitContext,
  struct,
} from "@briarflow/testing";

const character = struct("ty_c1", "Character", [field("name", ir.text())]);
const style = enumType("ty_s1", "ArtStyle", ["anime"]);
const chatMessage = struct("openai.ChatMessage", "ChatMessage", [field("content", ir.text())]);
const otherChatMessage = struct("other.ChatMessage", "ChatMessage", [field("body", ir.text())]);
const role = enumType("openai.Role", "Role", ["user"]);

function baseScope(): TypeScope {
  return createTypeScope({ globalTypes: [character, style], packTypes: [chatMessage, role] });
}

function parseOk(text: string, scope?: TypeScope, allowVars?: boolean): TypeRef {
  const options = { ...(scope ? { scope } : {}), ...(allowVars === undefined ? {} : { allowVars }) };
  const result = parseType(text, options);
  if (!result.ok) throw new Error(`expected "${text}" to parse, got ${result.diagnostic.code}: ${result.diagnostic.message}`);
  return result.type;
}

function parseFail(text: string, options: Parameters<typeof parseType>[1] = {}) {
  const result = parseType(text, options);
  expect(result.ok, `expected "${text}" to fail`).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.diagnostic.severity).toBe("error");
  return result.diagnostic;
}

describe("parseType: examples of types.md §2", () => {
  // [shorthand, IR, allowVars, printed form when shorter than the input]
  const examples: [string, TypeRef, boolean?, string?][] = [
    ["text", { kind: "primitive", name: "text" }],
    ["Character?", { kind: "optional", of: { kind: "named", id: "ty_c1" } }],
    ["list<Character?>", { kind: "list", of: { kind: "optional", of: { kind: "named", id: "ty_c1" } } }],
    ["list<image>[..4]", { kind: "list", of: { kind: "primitive", name: "image" }, maxItems: 4 }],
    ["openai.ChatMessage", { kind: "named", id: "openai.ChatMessage" }, false, "ChatMessage"],
    ["list<$T>", { kind: "list", of: { kind: "var", name: "T" } }, true],
  ];

  it.each(examples)("%s parses and prints back", (text, expected, allowVars, printed) => {
    const scope = baseScope();
    expect(parseOk(text, scope, allowVars)).toEqual(expected);
    expect(formatType(expected, scope)).toBe(printed ?? text);
    expect(parseOk(formatType(expected, scope), scope, allowVars)).toEqual(expected);
  });

  it.each(["text", "int", "float", "boolean", "image", "video", "audio", "model3d", "file"] as const)("primitive %s", (name) => {
    expect(parseOk(name)).toEqual({ kind: "primitive", name });
    expect(formatType({ kind: "primitive", name })).toBe(name);
  });
});

describe("parseType: grammar details", () => {
  it("? binds to the whole preceding base", () => {
    expect(parseOk("list<image>?")).toEqual({ kind: "optional", of: { kind: "list", of: { kind: "primitive", name: "image" } } });
    expect(parseOk("list<image?>")).toEqual({ kind: "list", of: { kind: "optional", of: { kind: "primitive", name: "image" } } });
  });

  it("list bounds", () => {
    expect(parseOk("list<text>[1..]")).toEqual({ kind: "list", of: { kind: "primitive", name: "text" }, minItems: 1 });
    expect(parseOk("list<text>[..4]")).toEqual({ kind: "list", of: { kind: "primitive", name: "text" }, maxItems: 4 });
    expect(parseOk("list<text>[2..2]")).toEqual({ kind: "list", of: { kind: "primitive", name: "text" }, minItems: 2, maxItems: 2 });
    expect(parseOk("list<text>[..]")).toEqual({ kind: "list", of: { kind: "primitive", name: "text" } });
  });

  it("allows spaces where the grammar has ws", () => {
    expect(parseOk("  list < list<int> > [ 1 .. 3 ] ? ")).toEqual({
      kind: "optional",
      of: { kind: "list", of: { kind: "list", of: { kind: "primitive", name: "int" } }, minItems: 1, maxItems: 3 },
    });
  });

  it("nested lists and optionals round-trip through formatType", () => {
    const scope = baseScope();
    for (const text of ["list<list<int>>", "list<int>[1..3]?", "list<ArtStyle>[2..]", "list<Role?>[..1]"]) {
      expect(formatType(parseOk(text, scope), scope)).toBe(text);
    }
  });

  it("formatType does not print primitive constraints", () => {
    expect(formatType({ kind: "primitive", name: "text", constraints: { maxLength: 3 } })).toBe("text");
    expect(formatType({ kind: "list", of: { kind: "primitive", name: "int", constraints: { min: 0 } }, maxItems: 2 })).toBe("list<int>[..2]");
  });

  it("formatType prints vars with $", () => {
    expect(formatType({ kind: "optional", of: { kind: "var", name: "T" } })).toBe("$T?");
  });
});

describe("parseType: errors", () => {
  it.each(["T??", "text??", "list<>", "list<text", "list text>", "te%xt", "list<text>>", "", "   ", "list<text>[a..]", "Text-x", "open ai.X"])(
    "%j → type.syntax with the position",
    (text) => {
      const diagnostic = parseFail(text);
      expect(diagnostic.code).toBe("type.syntax");
      expect(diagnostic.message).toContain("position");
    },
  );

  it("type.syntax message quotes the input and gives examples", () => {
    const diagnostic = parseFail("list<text");
    expect(diagnostic.message).toContain('"list<text"');
    expect(diagnostic.message).toContain("Example of valid types");
  });

  it("list<text>[3..1] → type.invalid_constraint", () => {
    expect(parseFail("list<text>[3..1]").code).toBe("type.invalid_constraint");
  });

  it("$T without allowVars → type.var_not_allowed", () => {
    const diagnostic = parseFail("list<$T>");
    expect(diagnostic.code).toBe("type.var_not_allowed");
    expect(diagnostic.message).toContain("$T");
    expect(parseFail("$T", { allowVars: false }).code).toBe("type.var_not_allowed");
  });

  it("invalid var names are syntax errors even with allowVars", () => {
    expect(parseFail("$t", { allowVars: true }).code).toBe("type.syntax");
  });

  it("unknown name in a scope → type.unknown", () => {
    const diagnostic = parseFail("Ghost", { scope: baseScope() });
    expect(diagnostic.code).toBe("type.unknown");
    expect(diagnostic.message).toContain('"Ghost"');
  });

  it("unknown qualified name → type.unknown", () => {
    expect(parseFail("openai.Ghost", { scope: baseScope() }).code).toBe("type.unknown");
  });

  it("never throws", () => {
    for (const text of ["<", ">", "?", "[", "list<", "$", ".", "a.b.c", "\u0000"]) {
      expect(() => parseType(text)).not.toThrow();
      expect(parseType(text).ok).toBe(false);
    }
  });
});

describe("name resolution (types.md §3)", () => {
  it("local → global → pack", () => {
    const localCharacter = struct("ty_lc", "Character", []);
    const scope = createTypeScope({
      flowId: "flow_x",
      localTypes: [localCharacter],
      globalTypes: [character, struct("ty_gm", "ChatMessage", [])],
      packTypes: [chatMessage, role],
    });
    expect(scope.flowId).toBe("flow_x");
    expect(scope.resolveName("Character")).toMatchObject({ ok: true, origin: "local", decl: { id: "ty_lc" } });
    expect(scope.resolveName("ChatMessage")).toMatchObject({ ok: true, origin: "global", decl: { id: "ty_gm" } });
    expect(scope.resolveName("Role")).toMatchObject({ ok: true, origin: "pack", decl: { id: "openai.Role" } });
  });

  it("qualified names are never shadowed", () => {
    const scope = createTypeScope({ globalTypes: [struct("ty_gm", "ChatMessage", [])], packTypes: [chatMessage] });
    expect(scope.resolveName("openai.ChatMessage")).toMatchObject({ ok: true, origin: "pack", decl: { id: "openai.ChatMessage" } });
    expect(parseOk("openai.ChatMessage", scope)).toEqual({ kind: "named", id: "openai.ChatMessage" });
    expect(parseOk("ChatMessage", scope)).toEqual({ kind: "named", id: "ty_gm" });
  });

  it("lookup is case-sensitive", () => {
    expect(baseScope().resolveName("character")).toMatchObject({ ok: false, code: "type.unknown" });
  });

  it("a short pack name shared by two packs is ambiguous and lists both ids", () => {
    const scope = createTypeScope({ packTypes: [chatMessage, otherChatMessage] });
    const result = scope.resolveName("ChatMessage");
    expect(result).toMatchObject({ ok: false, code: "type.ambiguous" });
    if (!result.ok) expect([...result.candidates].sort()).toEqual(["openai.ChatMessage", "other.ChatMessage"]);
    const diagnostic = parseFail("ChatMessage", { scope });
    expect(diagnostic.code).toBe("type.ambiguous");
    expect(diagnostic.message).toContain("openai.ChatMessage");
    expect(diagnostic.message).toContain("other.ChatMessage");
  });

  it("a global type removes the ambiguity of pack short names", () => {
    const scope = createTypeScope({ globalTypes: [struct("ty_gm", "ChatMessage", [])], packTypes: [chatMessage, otherChatMessage] });
    expect(scope.resolveName("ChatMessage")).toMatchObject({ ok: true, origin: "global" });
  });

  it("getType looks up by id: local → global → pack", () => {
    const scope = createTypeScope({ localTypes: [struct("ty_l", "L", [])], globalTypes: [character], packTypes: [role] });
    expect(scope.getType("ty_l")).toMatchObject({ origin: "local", decl: { name: "L" } });
    expect(scope.getType("ty_c1")).toMatchObject({ origin: "global", decl: { name: "Character" } });
    expect(scope.getType("openai.Role")).toMatchObject({ origin: "pack", decl: { name: "Role" } });
    expect(scope.getType("ty_ghost")).toBeUndefined();
    expect(scope.getType("Character")).toBeUndefined();
  });

  it("all() lists local, then global, then pack", () => {
    const scope = createTypeScope({ localTypes: [struct("ty_l", "L", [])], globalTypes: [character, style], packTypes: [role] });
    expect(scope.all().map((s) => [s.origin, s.decl.id])).toEqual([
      ["local", "ty_l"],
      ["global", "ty_c1"],
      ["global", "ty_s1"],
      ["pack", "openai.Role"],
    ]);
  });

  it("without a scope, names stay bare or qualified ids", () => {
    expect(parseOk("Character")).toEqual({ kind: "named", id: "Character" });
    expect(parseOk("openai.ChatMessage")).toEqual({ kind: "named", id: "openai.ChatMessage" });
  });
});

describe("formatType with scopes", () => {
  it("prints the short name when it resolves back", () => {
    expect(formatType({ kind: "named", id: "openai.ChatMessage" }, baseScope())).toBe("ChatMessage");
    expect(formatType({ kind: "named", id: "ty_c1" }, baseScope())).toBe("Character");
  });

  it("qualifies a pack type whose short name is shadowed", () => {
    const scope = createTypeScope({ globalTypes: [struct("ty_gm", "ChatMessage", [])], packTypes: [chatMessage] });
    expect(formatType({ kind: "named", id: "openai.ChatMessage" }, scope)).toBe("openai.ChatMessage");
    expect(formatType({ kind: "named", id: "ty_gm" }, scope)).toBe("ChatMessage");
  });

  it("qualifies an ambiguous pack type", () => {
    const scope = createTypeScope({ packTypes: [chatMessage, otherChatMessage] });
    expect(formatType({ kind: "named", id: "other.ChatMessage" }, scope)).toBe("other.ChatMessage");
  });

  it("prints #<id> for unknown ids", () => {
    expect(formatType({ kind: "named", id: "ty_ghost" }, baseScope())).toBe("#ty_ghost");
    expect(formatType({ kind: "list", of: { kind: "named", id: "ty_ghost" } }, baseScope())).toBe("list<#ty_ghost>");
  });

  it("output parses back to the same IR (round-trip on shadowed scope)", () => {
    const scope = createTypeScope({
      localTypes: [struct("ty_lc", "Character", [])],
      globalTypes: [character],
      packTypes: [chatMessage, otherChatMessage],
    });
    const types: TypeRef[] = [
      { kind: "named", id: "ty_lc" },
      { kind: "named", id: "openai.ChatMessage" },
      { kind: "list", of: { kind: "optional", of: { kind: "named", id: "other.ChatMessage" } }, minItems: 1 },
    ];
    for (const type of types) expect(parseOk(formatType(type, scope), scope)).toEqual(type);
  });
});

describe("scopeForContext / scopeForFlow", () => {
  it("scopeForContext sees global and pack types only", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void f.types.push(enumType("ty_local", "Local", ["a"])));
    const scope = scopeForContext(doc, { types: [role] });
    expect(scope.flowId).toBeUndefined();
    expect(scope.resolveName("Character")).toMatchObject({ ok: true, decl: { id: CHARACTER_ID } });
    expect(scope.resolveName("Role")).toMatchObject({ ok: true, origin: "pack" });
    expect(scope.resolveName("Local")).toMatchObject({ ok: false, code: "type.unknown" });
    expect(scope.getType("ty_local")).toBeUndefined();
  });

  it("scopeForFlow adds the flow's local types", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void f.types.push(enumType("ty_local", "Local", ["a"])));
    const scope = scopeForFlow(doc, PORTRAIT_FLOW_ID);
    expect(scope.flowId).toBe(PORTRAIT_FLOW_ID);
    expect(scope.resolveName("Local")).toMatchObject({ ok: true, origin: "local", decl: { id: "ty_local" } });
    expect(scope.resolveName("Character")).toMatchObject({ ok: true, origin: "global" });
  });

  it("local types shadow globals inside the flow", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void f.types.push(enumType("ty_lstyle", "ArtStyle", ["sketch"])));
    expect(scopeForFlow(doc, PORTRAIT_FLOW_ID).resolveName("ArtStyle")).toMatchObject({ ok: true, decl: { id: "ty_lstyle" } });
    expect(scopeForContext(doc).resolveName("ArtStyle")).toMatchObject({ ok: true, decl: { id: "ty_style" } });
  });

  it("scopeForFlow throws flow.not_found for an unknown flow", () => {
    expectBriarError(() => scopeForFlow(portraitContext(), "flow_ghost"), "flow.not_found");
  });
});
