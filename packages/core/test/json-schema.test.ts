/**
 * JSON Schema export (phase-1.md §5.7; types.md §9). Generated schemas are checked against the
 * draft 2020-12 meta-schema and exercised with Ajv.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  TypeDefinitionError,
  createTypeScope,
  flowSignatureSchema,
  scopeForContext,
  scopeForFlow,
  toJsonSchema,
  type JsonSchema,
  type TypeRef,
  type TypeScope,
} from "@briarflow/core";
import {
  CHARACTER_ID,
  PORTRAIT_FLOW_ID,
  editFlow,
  everyTypeContext,
  expectBriarError,
  field,
  ir,
  portraitContext,
  struct,
  wordsPack,
} from "@briarflow/testing";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const empty = createTypeScope({});

function ajv(): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true });
}

/** Checks the schema against the meta-schema and returns a validator. */
function compile(schema: JsonSchema): (value: unknown) => boolean {
  const instance = ajv();
  expect(instance.validateSchema(schema), JSON.stringify(instance.errors)).toBe(true);
  const validate = instance.compile(schema);
  return (value) => validate(value) as boolean;
}

/** Collects every value of a keyword anywhere in a schema. */
function keywordValues(schema: unknown, keyword: string): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === keyword) out.push(v);
        walk(v);
      }
    }
  };
  walk(schema);
  return out;
}

function withoutSchemaKey(schema: JsonSchema): JsonSchema {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

describe("toJsonSchema: mapping table", () => {
  it("text with constraints (pattern anchored)", () => {
    const schema = toJsonSchema(ir.text({ minLength: 1, maxLength: 5, pattern: "[a-z]+", multiline: true }), empty);
    expect(schema).toEqual({ $schema: DRAFT, type: "string", minLength: 1, maxLength: 5, pattern: "^(?:[a-z]+)$" });
    const validate = compile(schema);
    expect(validate("abc")).toBe(true);
    expect(validate("abc1")).toBe(false);
    expect(validate("")).toBe(false);
  });

  it("int, float, boolean", () => {
    expect(toJsonSchema(ir.int({ min: 0, max: 9 }), empty)).toEqual({ $schema: DRAFT, type: "integer", minimum: 0, maximum: 9 });
    expect(toJsonSchema(ir.float({ min: -1.5 }), empty)).toEqual({ $schema: DRAFT, type: "number", minimum: -1.5 });
    expect(toJsonSchema(ir.boolean(), empty)).toEqual({ $schema: DRAFT, type: "boolean" });
    expect(toJsonSchema(ir.text(), empty)).toEqual({ $schema: DRAFT, type: "string" });
    const validate = compile(toJsonSchema(ir.int({ min: 0, max: 9 }), empty));
    expect(validate(3)).toBe(true);
    expect(validate(1.5)).toBe(false);
    expect(validate(10)).toBe(false);
  });

  it("list", () => {
    const schema = toJsonSchema(ir.list(ir.text(), { minItems: 1, maxItems: 2 }), empty);
    expect(schema).toEqual({ $schema: DRAFT, type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 });
    const validate = compile(schema);
    expect(validate(["a"])).toBe(true);
    expect(validate([])).toBe(false);
    expect(validate(["a", "b", "c"])).toBe(false);
    expect(validate([1])).toBe(false);
  });

  it("optional", () => {
    const schema = toJsonSchema(ir.optional(ir.int()), empty);
    expect(schema).toEqual({ $schema: DRAFT, anyOf: [{ type: "integer" }, { type: "null" }] });
    const validate = compile(schema);
    expect(validate(null)).toBe(true);
    expect(validate(1)).toBe(true);
    expect(validate("1")).toBe(false);
  });

  it("media: $ref MediaRef + mime pattern, defined once", () => {
    const schema = toJsonSchema(ir.list(ir.image()), empty);
    expect(Object.keys(schema.$defs as object)).toEqual(["MediaRef"]);
    expect(JSON.stringify(schema)).toContain('"#/$defs/MediaRef"');
    expect(JSON.stringify(schema)).toContain("^image/");
    const validate = compile(schema);
    expect(validate([{ uri: "briar-media://m_1", mime: "image/png" }])).toBe(true);
    expect(validate([{ uri: "briar-media://m_1", mime: "video/mp4" }])).toBe(false);
    expect(validate([{ mime: "image/png" }])).toBe(false);
    expect(validate(["briar-media://m_1"])).toBe(false);
  });

  it("media with formats uses the enum of mimes", () => {
    const schema = toJsonSchema(ir.image({ formats: ["png", "jpeg"] }), empty);
    expect(keywordValues(schema, "enum")).toContainEqual(["image/png", "image/jpeg"]);
    const validate = compile(schema);
    expect(validate({ uri: "https://x/a.jpg", mime: "image/jpeg" })).toBe(true);
    expect(validate({ uri: "https://x/a.gif", mime: "image/gif" })).toBe(false);
  });

  it("struct and enum defs (Deviation 1 required rule, defaults, descriptions, labels)", () => {
    const doc = editContext2();
    const schema = toJsonSchema(ir.named(CHARACTER_ID), scopeForContext(doc));
    expect(schema.$ref).toBe("#/$defs/Character");
    const defs = schema.$defs as Record<string, JsonSchema>;
    expect(defs.Character).toMatchObject({
      type: "object",
      title: "Character",
      required: ["name", "style"],
      additionalProperties: false,
    });
    const props = defs.Character!.properties as Record<string, JsonSchema>;
    expect(Object.keys(props)).toEqual(["name", "age", "style", "nickname"]);
    expect(props.age).toMatchObject({ type: "integer", minimum: 0, default: 30, description: "Age in years" });
    expect(props.style).toEqual({ $ref: "#/$defs/ArtStyle" });
    expect(props.nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(defs.ArtStyle).toMatchObject({ type: "string", enum: ["anime", "realistic", "pixel"], title: "ArtStyle" });
    expect(JSON.stringify(defs.ArtStyle)).toContain("Pixel art");

    const validate = compile(schema);
    expect(validate({ name: "Aria", style: "anime" })).toBe(true);
    expect(validate({ name: "Aria", age: 27, style: "pixel", nickname: null })).toBe(true);
    expect(validate({ name: "Aria", style: "Anime" })).toBe(false);
    expect(validate({ name: "Aria", style: "anime", extra: 1 })).toBe(false);
    expect(validate({ style: "anime" })).toBe(false);
    expect(validate({ name: "Aria", age: -1, style: "anime" })).toBe(false);
  });

  it("$schema only on the root", () => {
    const schema = toJsonSchema(ir.list(ir.named(CHARACTER_ID)), scopeForContext(portraitContext()));
    expect(schema.$schema).toBe(DRAFT);
    expect(keywordValues(withoutSchemaKey(schema), "$schema")).toEqual([]);
  });

  it("pack types use the qualified id as $defs key", () => {
    const pack = wordsPack();
    const schema = toJsonSchema(ir.named("words.Stats"), createTypeScope({ packTypes: pack.types }));
    expect(schema.$ref).toBe("#/$defs/words.Stats");
    expect(Object.keys(schema.$defs as object).sort()).toEqual(["words.Stats", "words.Tone"]);
    const validate = compile(schema);
    expect(validate({ words: 1, characters: 5, tone: "calm" })).toBe(true);
    expect(validate({ words: 1, characters: 5, tone: "sad" })).toBe(false);
  });

  it("local type shadowing a global gets Name__id", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => {
      f.types.push(struct("ty_lc", "Character", [field("alias", ir.text())]));
      f.types.push(struct("ty_wrap", "Wrapper", [field("global", ir.named(CHARACTER_ID)), field("local", ir.named("ty_lc"))]));
    });
    const schema = toJsonSchema(ir.named("ty_wrap"), scopeForFlow(doc, PORTRAIT_FLOW_ID));
    const keys = Object.keys(schema.$defs as object).sort();
    expect(keys).toEqual(["ArtStyle", "Character", "Character__ty_lc", "Wrapper"]);
    const validate = compile(schema);
    expect(validate({ global: { name: "A", style: "anime" }, local: { alias: "B" } })).toBe(true);
    expect(validate({ global: { alias: "B" }, local: { alias: "B" } })).toBe(false);
  });

  it("strict mode: every field required, no default, no pattern, optionals stay nullable", () => {
    const doc = editContext2();
    const schema = toJsonSchema(ir.named(CHARACTER_ID), scopeForContext(doc), { strict: true });
    const character = (schema.$defs as Record<string, JsonSchema>).Character!;
    expect([...(character.required as string[])].sort()).toEqual(["age", "name", "nickname", "style"]);
    expect(keywordValues(schema, "default")).toEqual([]);
    expect(keywordValues(schema, "pattern")).toEqual([]);
    expect(keywordValues(schema, "format")).toEqual([]);
    expect((character.properties as Record<string, JsonSchema>).nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    compile(schema);
  });

  it("vars throw type.var_not_allowed", () => {
    expectBriarError(() => toJsonSchema(ir.list(ir.var("T")), empty), "type.var_not_allowed", TypeDefinitionError);
  });

  it("unknown ids throw type.unknown_id", () => {
    expectBriarError(() => toJsonSchema(ir.named("ty_ghost"), empty), "type.unknown_id", TypeDefinitionError);
  });

  it("every type of everyTypeContext compiles to a valid schema", () => {
    const doc = everyTypeContext();
    const scope: TypeScope = scopeForFlow(doc, "flow_every");
    for (const input of doc.flows[0]!.inputs) {
      const type: TypeRef = input.type;
      compile(toJsonSchema(type, scope));
      compile(toJsonSchema(type, scope, { strict: true }));
    }
  });
});

describe("flowSignatureSchema", () => {
  it("produces object schemas for inputs and outputs", () => {
    const { inputs, outputs } = flowSignatureSchema(portraitContext(), PORTRAIT_FLOW_ID);
    expect(inputs).toMatchObject({ $schema: DRAFT, type: "object", required: ["character"] });
    expect((inputs.properties as Record<string, JsonSchema>).character).toEqual({ $ref: "#/$defs/Character" });
    expect(outputs).toMatchObject({ $schema: DRAFT, type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] });
    const validateInputs = compile(inputs);
    expect(validateInputs({ character: { name: "A", style: "anime" } })).toBe(true);
    expect(validateInputs({})).toBe(false);
    expect(compile(outputs)({ prompt: "x" })).toBe(true);
  });

  it("inputs with defaults or optional types are not required", () => {
    const doc = everyTypeContext();
    const { inputs } = flowSignatureSchema(doc, "flow_every");
    const required = inputs.required as string[];
    expect(required).toContain("text");
    expect(required).not.toContain("int");
    expect(required).not.toContain("maybeText");
    expect(required).not.toContain("mood");
    compile(inputs);
  });

  it("accepts pack types and strict mode", () => {
    const pack = wordsPack();
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void f.outputs.push(field("stats", ir.named("words.Stats"))));
    const { outputs } = flowSignatureSchema(doc, PORTRAIT_FLOW_ID, pack, { strict: true });
    expect(Object.keys(outputs.$defs as object)).toContain("words.Stats");
    compile(outputs);
  });

  it("unknown flow → flow.not_found", () => {
    expectBriarError(() => flowSignatureSchema(portraitContext(), "flow_ghost"), "flow.not_found");
  });
});

/** Portrait with a description on Character.age (description → schema description). */
function editContext2() {
  const doc = portraitContext();
  const character = doc.types.find((t) => t.id === CHARACTER_ID);
  if (character?.kind !== "struct") throw new Error("fixture");
  const fields = character.fields.map((f) => (f.name === "age" ? { ...f, description: "Age in years" } : f));
  return { ...doc, types: doc.types.map((t) => (t.id === CHARACTER_ID ? { ...character, fields } : t)) };
}

