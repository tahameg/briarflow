import { describe, expect, it } from "vitest";
import {
  ENUM_VALUE_PATTERN,
  FIELD_NAME_PATTERN,
  ID_PATTERN,
  ID_PREFIXES,
  NODE_TYPE_PATTERN,
  PACK_NAME_PATTERN,
  RESERVED_FIELD_NAMES,
  RESERVED_TYPE_NAMES,
  TYPE_NAME_PATTERN,
  TYPE_VAR_NAME_PATTERN,
  canonicalJson,
  createIdGenerator,
  createSequentialIdGenerator,
  isBriarError,
  isValidEnumValue,
  isValidFieldName,
  isValidId,
  isValidNodeType,
  isValidPackName,
  isValidTypeName,
  jsonEquals,
  sha256Hex,
  type IdKind,
} from "@briarflow/core";
import { HELLO_SHA256, utf8 } from "@briarflow/testing";

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(isBriarError(thrown), `expected a BriarError with code ${code}`).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 1, c: 2 }] })).toBe('{"a":[true,null,{"c":2,"d":1}],"b":1}');
  });

  it("drops undefined object entries", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("sorts by UTF-16 code unit order", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4 })).toBe('{"B":2,"_":4,"a":3,"b":1}');
  });

  it("serializes primitives like JSON", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson("é✨\n")).toBe(JSON.stringify("é✨\n"));
  });

  it("is the same for objects that differ only in key order", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 }, y: 1 })).toBe(canonicalJson({ y: 1, x: { a: 2, b: 1 } }));
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a function", () => 1],
    ["a nested NaN", { a: [1, Number.NaN] }],
    ["a nested function", { f: () => 1 }],
  ])("throws json.invalid on %s", (_label, value) => {
    expectCode(() => canonicalJson(value), "json.invalid");
  });

  it("throws json.invalid on cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expectCode(() => canonicalJson(a), "json.invalid");
  });

  it("does not treat shared (non-cyclic) references as cycles", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe("jsonEquals", () => {
  it("ignores key order", () => {
    expect(jsonEquals({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it("respects array order and values", () => {
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEquals(null, {})).toBe(false);
    expect(jsonEquals("1", 1)).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes a string as UTF-8", async () => {
    expect(await sha256Hex("hello")).toBe(HELLO_SHA256);
  });

  it("hashes bytes", async () => {
    expect(await sha256Hex(utf8("hello"))).toBe(HELLO_SHA256);
  });

  it("hashes empty input", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("encodes non-ASCII text as UTF-8", async () => {
    expect(await sha256Hex("é✨")).toBe(await sha256Hex(utf8("é✨")));
  });
});

describe("ids", () => {
  const kinds = Object.keys(ID_PREFIXES) as IdKind[];

  it("has the prefixes of types.md §1", () => {
    expect(ID_PREFIXES).toEqual({ context: "ctx", flow: "flow", type: "ty", global: "gv", variable: "var", node: "n", edge: "e", exec: "x" });
  });

  it.each(kinds)("accepts valid %s ids and rejects other kinds' prefixes", (kind) => {
    const prefix = ID_PREFIXES[kind];
    expect(isValidId(kind, `${prefix}_abc`)).toBe(true);
    expect(isValidId(kind, `${prefix}_A-b_9`)).toBe(true);
    expect(isValidId(kind, `${prefix}_${"x".repeat(60)}`)).toBe(true);
    expect(isValidId(kind, `${prefix}_${"x".repeat(61)}`)).toBe(false);
    expect(isValidId(kind, `${prefix}_`)).toBe(false);
    expect(isValidId(kind, `${prefix}_a b`)).toBe(false);
    expect(isValidId(kind, `${prefix}_a.b`)).toBe(false);
    for (const other of kinds.filter((k) => ID_PREFIXES[k] !== prefix)) {
      expect(isValidId(kind, `${ID_PREFIXES[other]}_abc`)).toBe(false);
    }
  });

  it("ID_PATTERN matches every kind and nothing else", () => {
    expect(ID_PATTERN.test("flow_8fK2")).toBe(true);
    expect(ID_PATTERN.test("n_tpl1")).toBe(true);
    expect(ID_PATTERN.test("run_1")).toBe(false);
    expect(ID_PATTERN.test("FLOW_1")).toBe(false);
  });

  it("createSequentialIdGenerator counts per prefix", () => {
    const ids = createSequentialIdGenerator();
    expect([ids("n"), ids("n"), ids("e"), ids("n"), ids("flow")]).toEqual(["n_1", "n_2", "e_1", "n_3", "flow_1"]);
    expect(createSequentialIdGenerator()("n")).toBe("n_1");
  });

  it("createIdGenerator uses the injected random source and length", () => {
    const ids = createIdGenerator({ random: () => 0, length: 4 });
    expect(ids("ctx")).toBe("ctx_0000");
    const random = createIdGenerator();
    const id = random("flow");
    expect(isValidId("flow", id)).toBe(true);
    expect(id).toHaveLength("flow_".length + 12);
  });

  it("random ids are valid for every kind", () => {
    const ids = createIdGenerator();
    for (const kind of kinds) expect(isValidId(kind, ids(ID_PREFIXES[kind]))).toBe(true);
  });
});

describe("names (types.md §1)", () => {
  it("type names", () => {
    for (const ok of ["Character", "ArtStyle", "Shot_2", "X", "A".repeat(64)]) expect(isValidTypeName(ok), ok).toBe(true);
    for (const bad of ["character", "_Char", "2D", "Char-x", " Char", "Char ", "", "A".repeat(65), "Charäcter"]) {
      expect(isValidTypeName(bad), bad).toBe(false);
    }
    expect(TYPE_NAME_PATTERN.test("Character")).toBe(true);
  });

  it("reserved type names", () => {
    const reserved = ["Text", "Int", "Float", "Boolean", "Image", "Video", "Audio", "Model3d", "Model3D", "File", "List", "Optional"];
    expect([...RESERVED_TYPE_NAMES].sort()).toEqual([...reserved].sort());
    for (const name of reserved) expect(isValidTypeName(name), name).toBe(false);
    expect(isValidTypeName("Texts")).toBe(true);
  });

  it("field / port / variable names", () => {
    for (const ok of ["name", "maxTokens", "max_tokens", "_x", "Name", "a1", "a".repeat(64)]) expect(isValidFieldName(ok), ok).toBe(true);
    for (const bad of ["1abc", "max-tokens", "$media", "a b", "", " a", "a".repeat(65), "ünï"]) expect(isValidFieldName(bad), bad).toBe(false);
    expect(FIELD_NAME_PATTERN.test("maxTokens")).toBe(true);
  });

  it("reserved field names", () => {
    expect([...RESERVED_FIELD_NAMES].sort()).toEqual(["__proto__", "constructor", "prototype"]);
    for (const name of RESERVED_FIELD_NAMES) expect(isValidFieldName(name), name).toBe(false);
  });

  it("enum member values", () => {
    for (const ok of ["anime", "16x9", "gpt-4.1", "_x", "A", "a".repeat(64)]) expect(isValidEnumValue(ok), ok).toBe(true);
    for (const bad of ["-x", ".x", "a b", "", "a".repeat(65), "a/b"]) expect(isValidEnumValue(bad), bad).toBe(false);
    expect(ENUM_VALUE_PATTERN.test("gpt-4.1")).toBe(true);
  });

  it("pack names", () => {
    for (const ok of ["openai", "my_tools", "a1", "a".repeat(32)]) expect(isValidPackName(ok), ok).toBe(true);
    for (const bad of ["OpenAI", "1pack", "my-tools", "_x", "", "a".repeat(33)]) expect(isValidPackName(bad), bad).toBe(false);
    expect(PACK_NAME_PATTERN.test("openai")).toBe(true);
  });

  it("generic var names", () => {
    for (const ok of ["T", "Item", "T1"]) expect(TYPE_VAR_NAME_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ["t", "T_1", "$T", "1T"]) expect(TYPE_VAR_NAME_PATTERN.test(bad), bad).toBe(false);
  });

  it("node types", () => {
    for (const ok of ["openai.chat", "briar.variable.get", "convert.toText", "my_pack.do_it2"]) expect(isValidNodeType(ok), ok).toBe(true);
    for (const bad of ["openai", "OpenAI.chat", "openai.Chat", "openai.", ".chat", "openai..chat", "open-ai.chat", "openai.chat-x"]) {
      expect(isValidNodeType(bad), bad).toBe(false);
    }
    expect(NODE_TYPE_PATTERN.test("text.template")).toBe(true);
  });
});
