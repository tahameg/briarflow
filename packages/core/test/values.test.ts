/**
 * Value validation and normalization, MediaRef validation (phase-1.md §5.6; types.md §6–§8).
 */
import { describe, expect, it } from "vitest";
import {
  MEDIA_FORMATS,
  createTypeScope,
  formatToMime,
  mediaIdFromUri,
  normalizeValue,
  scopeForContext,
  validateMediaRef,
  validateValue,
  type Diagnostic,
  type TypeScope,
} from "@briarflow/core";
import {
  CHARACTER_ID,
  constraintCases,
  invalidMediaRefs,
  ir,
  portraitContext,
  shapeCases,
  validMediaRefs,
  type ValueCase,
} from "@briarflow/testing";

const empty: TypeScope = createTypeScope({});
const portraitScope = (): TypeScope => scopeForContext(portraitContext());
const character = ir.named(CHARACTER_ID);

function messages(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.message);
}

function checkRow(row: ValueCase): void {
  const diagnostics = validateValue(row.value, row.type, empty, { path: "v" });
  if (row.ok) {
    expect(diagnostics, JSON.stringify(diagnostics)).toEqual([]);
    return;
  }
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const d of diagnostics) expect(d.severity).toBe("error");
  const expected = row.message ?? "";
  const match = row.match ?? "exact";
  const found = messages(diagnostics).some((m) =>
    match === "exact" ? m === expected : match === "prefix" ? m.startsWith(expected) : m.includes(expected),
  );
  expect(found, `no message ${match} ${JSON.stringify(expected)} in ${JSON.stringify(messages(diagnostics))}`).toBe(true);
}

describe("constraints (types.md §6)", () => {
  it.each(constraintCases.map((row) => [row.label, row] as const))("%s", (_label, row) => checkRow(row));

  it("constraint failures use code value.invalid", () => {
    const [d] = validateValue(-1, ir.int({ min: 0 }), empty, { path: "v" });
    expect(d).toMatchObject({ severity: "error", code: "value.invalid", message: "v must be >= 0" });
  });

  it("constraints: false skips constraint checks only", () => {
    expect(validateValue(-1, ir.int({ min: 0 }), empty, { constraints: false })).toEqual([]);
    expect(validateValue("abc", ir.text({ maxLength: 1 }), empty, { constraints: false })).toEqual([]);
    expect(validateValue(["a", "b"], ir.list(ir.text(), { maxItems: 1 }), empty, { constraints: false })).toEqual([]);
    expect(validateValue("x", ir.int(), empty, { constraints: false }).length).toBeGreaterThan(0);
    expect(validateValue(1.5, ir.int(), empty, { constraints: false }).length).toBeGreaterThan(0);
  });

  it("default path is \"value\"", () => {
    expect(messages(validateValue(-1, ir.int({ min: 0 }), empty))).toEqual(["value must be >= 0"]);
  });
});

describe("accepted JSON per type (types.md §7)", () => {
  it.each(shapeCases.map((row) => [row.label, row] as const))("%s", (_label, row) => checkRow(row));
});

describe("structs and enums (types.md §7 examples)", () => {
  const at = { path: "inputs.character" };

  it("accepts a full value and one that omits optional/defaulted fields", () => {
    const scope = portraitScope();
    expect(validateValue({ name: "Aria", age: 27, style: "anime", nickname: null }, character, scope, at)).toEqual([]);
    expect(validateValue({ name: "Aria", style: "anime" }, character, scope, at)).toEqual([]);
  });

  it("constraint path inside a struct", () => {
    const diagnostics = validateValue({ name: "Aria", age: -1, style: "anime" }, character, portraitScope(), at);
    expect(messages(diagnostics)).toEqual(["inputs.character.age must be >= 0"]);
    expect(diagnostics[0]!.path.valuePath).toBe("inputs.character.age");
  });

  it("type mismatch shows the value", () => {
    const diagnostics = validateValue({ name: "Aria", age: "27", style: "anime" }, character, portraitScope(), at);
    expect(messages(diagnostics)).toEqual(['inputs.character.age must be a whole number (got "27")']);
  });

  it("unknown field lists the known fields", () => {
    const diagnostics = validateValue({ name: "Aria", style: "anime", nick: "A" }, character, portraitScope(), at);
    expect(messages(diagnostics)).toEqual([
      "inputs.character.nick is not a field of Character. Known fields: name, age, style, nickname",
    ]);
  });

  it("missing required field", () => {
    expect(messages(validateValue({ style: "anime" }, character, portraitScope(), at))).toEqual(["inputs.character.name is required"]);
  });

  it("enum message lists the members (case-sensitive)", () => {
    expect(messages(validateValue({ name: "Aria", style: "Anime" }, character, portraitScope(), at))).toEqual([
      'inputs.character.style must be one of anime, realistic, pixel (got "Anime")',
    ]);
  });

  it("reports every problem", () => {
    const diagnostics = validateValue({ age: -1, style: "x" }, character, portraitScope(), at);
    expect(diagnostics).toHaveLength(3);
  });

  it("rejects non-objects for structs and non-strings for enums", () => {
    expect(validateValue("Aria", character, portraitScope(), at).length).toBeGreaterThan(0);
    expect(validateValue([], character, portraitScope(), at).length).toBeGreaterThan(0);
    expect(validateValue(null, character, portraitScope(), at).length).toBeGreaterThan(0);
    expect(validateValue(1, ir.named("ty_style"), portraitScope(), at).length).toBeGreaterThan(0);
  });

  it("list path format: inputs.characters[2].name", () => {
    const value = [
      { name: "A", style: "anime" },
      { name: "B", style: "pixel" },
      { name: 3, style: "pixel" },
    ];
    const diagnostics = validateValue(value, ir.list(character), portraitScope(), { path: "inputs.characters" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message.startsWith("inputs.characters[2].name ")).toBe(true);
    expect(diagnostics[0]!.path.valuePath).toBe("inputs.characters[2].name");
  });

  it("merges options.at into every diagnostic path", () => {
    const diagnostics = validateValue({ name: "A", age: -1, style: "x" }, character, portraitScope(), {
      path: "nodes.n_x.values.value",
      at: { flowId: "flow_p", nodeId: "n_x", port: "value" },
    });
    expect(diagnostics).toHaveLength(2);
    for (const d of diagnostics) expect(d.path).toMatchObject({ flowId: "flow_p", nodeId: "n_x", port: "value" });
  });

  it("unknown type id → type.unknown_id", () => {
    const diagnostics = validateValue("x", ir.named("ty_ghost"), portraitScope());
    expect(diagnostics.map((d) => d.code)).toContain("type.unknown_id");
  });

  it("a var in the type → value.generic_unbound", () => {
    expect(validateValue("x", ir.var("T"), empty).map((d) => d.code)).toEqual(["value.generic_unbound"]);
    expect(validateValue(["x"], ir.list(ir.var("T")), empty).map((d) => d.code)).toContain("value.generic_unbound");
  });

  it("never mutates the value", () => {
    const value = { name: "Aria", style: "anime", list: [1] };
    const copy = structuredClone(value);
    validateValue(value, character, portraitScope());
    expect(value).toEqual(copy);
  });
});

describe("normalizeValue", () => {
  it("fills omitted optional with null and defaulted with the default", () => {
    expect(normalizeValue({ name: "Aria", style: "anime" }, character, portraitScope())).toEqual({
      ok: true,
      value: { name: "Aria", age: 30, style: "anime", nickname: null },
    });
  });

  it("keeps given values", () => {
    const value = { name: "Aria", age: 27, style: "pixel", nickname: "Ari" };
    expect(normalizeValue(value, character, portraitScope())).toEqual({ ok: true, value });
  });

  it("normalizes nested values (lists, optionals)", () => {
    const type = ir.optional(ir.list(character));
    expect(normalizeValue([{ name: "A", style: "anime" }], type, portraitScope())).toEqual({
      ok: true,
      value: [{ name: "A", age: 30, style: "anime", nickname: null }],
    });
    expect(normalizeValue(undefined, type, portraitScope())).toEqual({ ok: true, value: null });
  });

  it("normalizes nested structs", () => {
    const outer = { kind: "struct" as const, id: "ty_o", name: "Outer", fields: [{ name: "c", type: character }, { name: "n", type: ir.optional(ir.int()) }] };
    const doc = portraitContext();
    const scope = createTypeScope({ globalTypes: [...doc.types, outer] });
    expect(normalizeValue({ c: { name: "A", style: "anime" } }, ir.named("ty_o"), scope)).toEqual({
      ok: true,
      value: { c: { name: "A", age: 30, style: "anime", nickname: null }, n: null },
    });
  });

  it("does not share the default value object", () => {
    const withList = { kind: "struct" as const, id: "ty_l", name: "L", fields: [{ name: "tags", type: ir.list(ir.text()), default: ["a"] }] };
    const scope = createTypeScope({ globalTypes: [withList] });
    const a = normalizeValue({}, ir.named("ty_l"), scope);
    expect(a).toEqual({ ok: true, value: { tags: ["a"] } });
    if (a.ok) (a.value as { tags: string[] }).tags.push("b");
    expect(withList.fields[0]!.default).toEqual(["a"]);
  });

  it("returns the same diagnostics as validateValue when invalid", () => {
    const value = { name: "Aria", age: -1, style: "Anime", extra: 1 };
    const options = { path: "inputs.character" };
    const result = normalizeValue(value, character, portraitScope(), options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual(validateValue(value, character, portraitScope(), options));
  });

  it("never mutates its input", () => {
    const value = { name: "Aria", style: "anime" };
    const copy = structuredClone(value);
    const result = normalizeValue(value, character, portraitScope());
    expect(value).toEqual(copy);
    expect(result.ok && result.value).not.toBe(value);
  });

  it("primitives normalize as is", () => {
    expect(normalizeValue(2.0, ir.int(), empty)).toEqual({ ok: true, value: 2 });
    expect(normalizeValue("x", ir.text(), empty)).toEqual({ ok: true, value: "x" });
  });
});

describe("MediaRef validation (types.md §8)", () => {
  it.each(validMediaRefs.map((c) => [c.label, c] as const))("valid: %s", (_label, c) => {
    expect(validateMediaRef(c.value, c.primitive, "v")).toEqual([]);
    expect(validateValue(c.value, { kind: "primitive", name: c.primitive }, empty, { path: "v" })).toEqual([]);
  });

  it.each(invalidMediaRefs.map((c) => [c.label, c] as const))("invalid: %s", (_label, c) => {
    const diagnostics = validateMediaRef(c.value, c.primitive, "v");
    expect(diagnostics.map((d) => d.code)).toContain(c.code);
    const d = diagnostics.find((x) => x.code === c.code)!;
    expect(d.severity).toBe("error");
    expect(d.message.startsWith(`v is not a valid ${c.primitive}: `)).toBe(true);
    expect(validateValue(c.value, { kind: "primitive", name: c.primitive }, empty, { path: "v" }).map((x) => x.code)).toContain(c.code);
  });

  it("formatToMime maps the format table case-insensitively", () => {
    expect(MEDIA_FORMATS).toMatchObject({ png: "image/png", mp3: "audio/mpeg", glb: "model/gltf-binary", txt: "text/plain" });
    expect(formatToMime("PNG")).toBe("image/png");
    expect(formatToMime("application/zip")).toBe("application/zip");
  });

  it("mediaIdFromUri", () => {
    expect(mediaIdFromUri("briar-media://m_abc")).toBe("m_abc");
    expect(mediaIdFromUri("m_abc")).toBe("m_abc");
    expect(mediaIdFromUri("https://x/y.png")).toBeUndefined();
    expect(mediaIdFromUri("briar-media://")).toBeUndefined();
    expect(mediaIdFromUri("briar-media://a b")).toBeUndefined();
  });
});
