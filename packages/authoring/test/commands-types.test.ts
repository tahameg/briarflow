import { describe, expect, it } from "vitest";
import type { Command, ScopeInput } from "@briarflow/authoring";
import type { ContextDocument, StructDecl, EnumDecl, TypeDecl } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { HERO, KIT, PORTRAIT, emptyDoc, richDoc } from "./fixtures/docs.js";
import { accept, build, chars, diags, flowOf, msg, nodeOf, portsOf, reject } from "./fixtures/helpers.js";

const G: ScopeInput = { kind: "global" };
const F: ScopeInput = { kind: "flow", flowId: KIT };

function typeOf(doc: ContextDocument, id: string): TypeDecl | undefined {
  return doc.types.find((t) => t.id === id) ?? doc.flows.flatMap((f) => f.types).find((t) => t.id === id);
}
function structOf(doc: ContextDocument, id: string): StructDecl {
  const t = typeOf(doc, id);
  if (!t || t.kind !== "struct") throw new Error(`struct ${id} missing`);
  return t;
}
function enumOf(doc: ContextDocument, id: string): EnumDecl {
  const t = typeOf(doc, id);
  if (!t || t.kind !== "enum") throw new Error(`enum ${id} missing`);
  return t;
}
function fieldNames(doc: ContextDocument, id: string): string[] {
  return structOf(doc, id).fields.map((f) => f.name);
}
function memberValues(doc: ContextDocument, id: string): string[] {
  return enumOf(doc, id).members.map((m) => m.value);
}

// ---------------------------------------------------------------------------------------------

describe("type.defineStruct", () => {
  it("defines a global struct with shorthand field types stored as IR", () => {
    const r = accept(richDoc(), [
      {
        op: "type.defineStruct",
        scope: G,
        id: "ty_scene",
        name: "Scene",
        description: "A scene",
        fields: [
          { name: "title", type: "text" },
          { name: "count", type: "int", default: 3, description: "how many" },
          { name: "style", type: "ArtStyle" },
          { name: "cast", type: "list<Character?>" },
          { name: "mode", type: "RoundingMode" },
        ],
      },
    ]);
    expect(r.created).toEqual([{ typeId: "ty_scene" }]);
    expect(r.doc.types[r.doc.types.length - 1]).toEqual({
      kind: "struct",
      id: "ty_scene",
      name: "Scene",
      description: "A scene",
      fields: [
        { name: "title", type: ir.text() },
        { name: "count", type: ir.int(), default: 3, description: "how many" },
        { name: "style", type: ir.named("ty_style") },
        { name: "cast", type: ir.list(ir.optional(ir.named("ty_char"))) },
        { name: "mode", type: ir.named("briar.RoundingMode") },
      ],
    });
    expect(r.inverse).toEqual([{ op: "type.delete", typeId: "ty_scene", restore: true }]);
  });

  it("defines a local struct (fields resolve local types) with a generated id", () => {
    const r = accept(richDoc(), [{ op: "type.defineStruct", scope: F, name: "Feeling", fields: [{ name: "m", type: "Mood" }] }]);
    const id = r.created[0]!.typeId!;
    expect(id).toBe("ty_1");
    expect(r.resolved[0]).toMatchObject({ id: "ty_1", fields: [{ name: "m", type: ir.named("ty_mood") }] });
    expect(flowOf(r.doc, KIT).types.map((t) => t.id)).toEqual(["ty_mood", "ty_pair", "ty_1"]);
  });

  it("fields default to []", () => {
    const r = accept(emptyDoc(), [{ op: "type.defineStruct", scope: G, id: "ty_e", name: "Empty" }]);
    expect(structOf(r.doc, "ty_e").fields).toEqual([]);
  });

  it("a local type may shadow a global one (warning type.shadows_global)", () => {
    const r = accept(richDoc(), [{ op: "type.defineStruct", scope: F, id: "ty_lc", name: "Character" }]);
    const w = diags(r.diagnostics, "type.shadows_global");
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe("warning");
  });

  it("type names: invalid / reserved / duplicate (case-insensitive)", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "character" }], "type.invalid_name", { message: msg.invalidTypeName("character") });
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "Bad Name" }], "type.invalid_name", { message: msg.invalidTypeName("Bad Name") });
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: chars(65, "A") }], "type.invalid_name");
    for (const name of ["Text", "List", "Optional", "Model3D", "Int"]) {
      reject(richDoc(), [{ op: "type.defineStruct", scope: G, name }], "type.reserved_name", { message: msg.reservedTypeName(name) });
    }
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "CHARACTER" }], "type.duplicate_name", { message: msg.duplicateTypeName("Character") });
    reject(richDoc(), [{ op: "type.defineEnum", scope: F, name: "MOOD" }], "type.duplicate_name", { message: msg.duplicateTypeName("Mood") });
  });

  it("field names: invalid / reserved / duplicate → command.*_name", () => {
    const def = (fields: { name: string; type: string }[]): Command[] => [{ op: "type.defineStruct", scope: G, name: "X", fields }];
    reject(richDoc(), def([{ name: "1x", type: "text" }]), "command.invalid_name", { message: msg.invalidName("1x") });
    reject(richDoc(), def([{ name: "constructor", type: "text" }]), "command.reserved_name", { message: msg.reservedName("constructor") });
    reject(richDoc(), def([{ name: "__proto__", type: "text" }]), "command.reserved_name");
    reject(
      richDoc(),
      def([
        { name: "a", type: "text" },
        { name: "A", type: "int" },
      ]),
      "command.duplicate_name",
      { message: msg.duplicateName("a") },
    );
  });

  it("field types: unknown / syntax / var / unknown id / bad IR shape", () => {
    const def = (type: unknown): Command[] => [{ op: "type.defineStruct", scope: G, name: "X", fields: [{ name: "a", type: type as string }] }];
    reject(richDoc(), def("Nope"), "type.unknown", { contains: ['"Nope"'] });
    reject(richDoc(), def("list<text"), "type.syntax", { contains: ["list<text"] });
    reject(richDoc(), def("$T"), "type.var_not_allowed");
    reject(richDoc(), def("Mood"), "type.unknown"); // local types are not visible globally
    reject(richDoc(), def(ir.named("ty_ghost")), "type.unknown_id", { contains: ["ty_ghost"] });
    reject(richDoc(), def({ kind: "bogus" }), "command.invalid_payload");
    reject(richDoc(), def(ir.var("T")), "type.var_not_allowed");
  });

  it("global struct using a local type → visibility.local_type_in_global", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "X", fields: [{ name: "m", type: ir.named("ty_mood") as never }] }], "visibility.local_type_in_global", {
      contains: ['"Mood"', '"Kit"'],
    });
  });

  it("self recursion → type.recursive", () => {
    reject(
      richDoc(),
      [{ op: "type.defineStruct", scope: G, id: "ty_node", name: "Node", fields: [{ name: "next", type: ir.optional(ir.named("ty_node")) as never }] }],
      "type.recursive",
      { message: /^Type "Node" contains itself through .+\. Recursive types are not supported\.$/ },
    );
  });

  it("invalid default → type.invalid_default; bad constraint → type.invalid_constraint", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "X", fields: [{ name: "a", type: "int", default: "x" }] }], "type.invalid_default", {
      message: msg.invalidDefault,
    });
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "X", fields: [{ name: "a", type: "list<text>[3..1]" }] }], "type.invalid_constraint");
  });

  it("ids: invalid / duplicate in the type domain (global + all local)", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, id: "flow_x", name: "X" }], "command.invalid_id", { message: msg.invalidId("type.defineStruct", "flow_x") });
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, id: "ty_char", name: "X" }], "command.duplicate_id", { message: msg.duplicateId("type.defineStruct", "ty_char") });
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, id: "ty_mood", name: "X" }], "command.duplicate_id");
    reject(richDoc(), [{ op: "type.defineStruct", scope: { kind: "flow", flowId: PORTRAIT }, id: "ty_pair", name: "X" }], "command.duplicate_id");
  });

  it("unknown flow scope → command.unknown_ref; bad scope shape → invalid_payload", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: { kind: "flow", flowId: "flow_nope" }, name: "X" }], "command.unknown_ref", {
      contains: ['"flow_nope"'],
    });
    reject(richDoc(), [{ op: "type.defineStruct", scope: { kind: "pack" }, name: "X" } as unknown as Command], "command.invalid_payload");
  });
});

describe("type.defineEnum", () => {
  it("members as strings or objects", () => {
    const r = accept(richDoc(), [{ op: "type.defineEnum", scope: F, id: "ty_art", name: "Art", members: ["anime", { value: "pixel", label: "Pixel art" }, { value: "16x9" }] }]);
    expect(r.created).toEqual([{ typeId: "ty_art" }]);
    expect(enumOf(r.doc, "ty_art").members).toEqual([{ value: "anime" }, { value: "pixel", label: "Pixel art" }, { value: "16x9" }]);
  });

  it("zero members are accepted with warning type.enum_empty", () => {
    const r = accept(richDoc(), [{ op: "type.defineEnum", scope: G, id: "ty_none", name: "None", members: [] }]);
    expect(diags(r.diagnostics, "type.enum_empty")[0]?.severity).toBe("warning");
    const r2 = accept(richDoc(), [{ op: "type.defineEnum", scope: G, id: "ty_none", name: "None" }]);
    expect(enumOf(r2.doc, "ty_none").members).toEqual([]);
  });

  it("duplicate members (case-insensitive) → type.duplicate_member", () => {
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "X", members: ["a", "A"] }], "type.duplicate_member");
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "X", members: ["a", { value: "a", label: "Again" }] }], "type.duplicate_member");
  });

  it("invalid member value / label; name rules", () => {
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "X", members: ["a b"] }], "command.invalid_name", { message: msg.invalidName("a b") });
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "X", members: [{ value: "a", label: "  " }] }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "X", members: [{ value: "a", label: chars(121) }] }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "Artstyle" }], "type.duplicate_name");
    reject(richDoc(), [{ op: "type.defineEnum", scope: G, name: "Boolean" }], "type.reserved_name");
  });
});

describe("type.rename / type.setDescription", () => {
  it("renames; references (ids) are unaffected", () => {
    const r = accept(richDoc(), [{ op: "type.rename", typeId: "ty_char", name: "Persona" }]);
    expect(structOf(r.doc, "ty_char").name).toBe("Persona");
    expect(structOf(r.doc, "ty_team").fields[0]!.type).toEqual(ir.named("ty_char"));
  });

  it("a local type may be renamed to a global type's name (shadowing)", () => {
    const r = accept(richDoc(), [{ op: "type.rename", typeId: "ty_mood", name: "Character" }]);
    expect(diags(r.diagnostics, "type.shadows_global")).toHaveLength(1);
  });

  it("rejects invalid, reserved, duplicate names and unknown ids", () => {
    reject(richDoc(), [{ op: "type.rename", typeId: "ty_char", name: "persona" }], "type.invalid_name", { message: msg.invalidTypeName("persona") });
    reject(richDoc(), [{ op: "type.rename", typeId: "ty_char", name: "File" }], "type.reserved_name", { message: msg.reservedTypeName("File") });
    reject(richDoc(), [{ op: "type.rename", typeId: "ty_char", name: "ARTSTYLE" }], "type.duplicate_name", { message: msg.duplicateTypeName("ArtStyle") });
    reject(richDoc(), [{ op: "type.rename", typeId: "ty_pair", name: "MOOD" }], "type.duplicate_name");
    reject(richDoc(), [{ op: "type.rename", typeId: "ty_nope", name: "X" }], "command.unknown_ref", { message: msg.unknownRef("type.rename", "type", "ty_nope") });
  });

  it("setDescription sets and clears", () => {
    const d = accept(richDoc(), [{ op: "type.setDescription", typeId: "ty_mood", description: "Feelings" }]).doc;
    expect(enumOf(d, "ty_mood").description).toBe("Feelings");
    const c = accept(d, [{ op: "type.setDescription", typeId: "ty_mood", description: null }]).doc;
    expect("description" in enumOf(c, "ty_mood")).toBe(false);
    reject(richDoc(), [{ op: "type.setDescription", typeId: "ty_mood", description: chars(2001) }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.setDescription", typeId: "ty_x", description: "a" }], "command.unknown_ref");
  });
});

describe("type.delete", () => {
  it("deletes an unused type; the inverse re-defines it with the same id at the same position", () => {
    const r = accept(richDoc(), [{ op: "type.delete", typeId: "ty_team" }]);
    expect(r.doc.types.map((t) => t.id)).toEqual(["ty_style", "ty_char", "ty_unused"]);
    expect(r.inverse).toHaveLength(1);
    expect(r.inverse[0]).toMatchObject({ op: "type.defineStruct", id: "ty_team", restore: true });
  });

  it("deletes an unused local type", () => {
    const d = build(richDoc(), [{ op: "type.defineEnum", scope: F, id: "ty_tmp", name: "Tmp", members: ["x"] }]);
    const r = accept(d, [{ op: "type.delete", typeId: "ty_tmp" }]);
    expect(typeOf(r.doc, "ty_tmp")).toBeUndefined();
  });

  it("rejects a used type with type.in_use and details.usages", () => {
    const e = reject(richDoc(), [{ op: "type.delete", typeId: "ty_style" }], "type.in_use", {
      message: /^Type "ArtStyle" is used in \d+ places? \(.+\)\. Remove those uses first\.$/,
    });
    const usages = (e.details as { usages: { kind: string; id: string; name: string; flowId?: string }[] }).usages;
    expect(Array.isArray(usages)).toBe(true);
    expect(usages.length).toBeGreaterThan(0);
    for (const u of usages) {
      expect(typeof u.kind).toBe("string");
      expect(typeof u.id).toBe("string");
    }
  });

  const usageSetups: [string, Command[]][] = [
    ["a field of another type", [{ op: "type.defineStruct", scope: G, name: "User", fields: [{ name: "e", type: "Tone" }] }]],
    ["a flow signature", [{ op: "flow.input.add", flowId: KIT, name: "tone", type: "Tone" }]],
    ["a flow output", [{ op: "flow.output.add", flowId: KIT, name: "tone", type: "Tone" }]],
    ["a flow variable", [{ op: "flow.variable.create", flowId: KIT, name: "tone", type: "Tone", access: "private" }]],
    ["a global", [{ op: "global.create", name: "tone", type: "Tone", access: "readwrite" }]],
    ["a briar.constant config", [{ op: "node.add", flowId: KIT, type: "briar.constant", position: { x: 0, y: 0 }, config: { type: "list<Tone>" } }]],
  ];
  it.each(usageSetups)("type used by %s → type.in_use", (_label, setup) => {
    const d = build(richDoc(), [{ op: "type.defineEnum", scope: G, id: "ty_tone", name: "Tone", members: ["soft"] }, ...setup]);
    const e = reject(d, [{ op: "type.delete", typeId: "ty_tone" }], "type.in_use", { contains: ['"Tone"'] });
    expect((e.details as { usages: unknown[] }).usages).toHaveLength(1);
  });

  it("struct used by a struct.make / struct.break config → type.in_use", () => {
    const d = build(richDoc(), [
      { op: "type.defineStruct", scope: G, id: "ty_s1", name: "S1" },
      { op: "node.add", flowId: KIT, type: "briar.struct.break", position: { x: 0, y: 0 }, config: { typeId: "ty_s1" } },
    ]);
    reject(d, [{ op: "type.delete", typeId: "ty_s1" }], "type.in_use");
  });

  it("local type used by a variable, a constant config and a local field → type.in_use", () => {
    const e = reject(richDoc(), [{ op: "type.delete", typeId: "ty_mood" }], "type.in_use", { contains: ['"Mood"'] });
    expect((e.details as { usages: unknown[] }).usages.length).toBeGreaterThanOrEqual(3);
  });

  it("pack types are read-only; unknown ids are unknown_ref", () => {
    reject(richDoc(), [{ op: "type.delete", typeId: "briar.RoundingMode" }], "type.read_only");
    reject(richDoc(), [{ op: "type.delete", typeId: "ty_ghost" }], "command.unknown_ref", { message: msg.unknownRef("type.delete", "type", "ty_ghost") });
  });
});

describe("type.moveScope", () => {
  it("global → flow keeps the id and appends to the flow's types", () => {
    const r = accept(richDoc(), [{ op: "type.moveScope", typeId: "ty_unused", to: F }]);
    expect(r.doc.types.map((t) => t.id)).not.toContain("ty_unused");
    expect(flowOf(r.doc, KIT).types.map((t) => t.id)).toEqual(["ty_mood", "ty_pair", "ty_unused"]);
  });

  it("global → flow F is allowed when the type is only used privately inside F", () => {
    const d = build(richDoc(), [
      { op: "type.defineEnum", scope: G, id: "ty_tone", name: "Tone", members: ["soft"] },
      { op: "flow.variable.create", flowId: KIT, id: "var_tone", name: "tone", type: "Tone", access: "private" },
    ]);
    const r = accept(d, [{ op: "type.moveScope", typeId: "ty_tone", to: F }]);
    expect(flowOf(r.doc, KIT).variables.find((v) => v.id === "var_tone")!.type).toEqual(ir.named("ty_tone"));
  });

  it("global → flow F is rejected when used outside F (global types, other flows, globals)", () => {
    reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_style", to: F }], "type.in_use");
    reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_char", to: F }], "type.in_use");
    const d = build(richDoc(), [
      { op: "type.defineEnum", scope: G, id: "ty_tone", name: "Tone", members: ["soft"] },
      { op: "flow.variable.create", flowId: PORTRAIT, name: "tone", type: "Tone", access: "private" },
    ]);
    reject(d, [{ op: "type.moveScope", typeId: "ty_tone", to: F }], "type.in_use");
  });

  it("global → flow F is rejected when used in F's public signature", () => {
    const d = build(richDoc(), [
      { op: "type.defineEnum", scope: G, id: "ty_tone", name: "Tone", members: ["soft"] },
      { op: "flow.input.add", flowId: KIT, name: "tone", type: "Tone" },
    ]);
    reject(d, [{ op: "type.moveScope", typeId: "ty_tone", to: F }], "visibility.local_type_in_public_signature");
  });

  it("flow → global", () => {
    const r = accept(richDoc(), [{ op: "type.moveScope", typeId: "ty_mood", to: G }]);
    expect(r.doc.types[r.doc.types.length - 1]!.id).toBe("ty_mood");
    expect(flowOf(r.doc, KIT).types.map((t) => t.id)).toEqual(["ty_pair"]);
  });

  it("flow → global with local dependencies → visibility.local_type_in_global (details.localDependencies)", () => {
    const e = reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_pair", to: G }], "visibility.local_type_in_global");
    const deps = (e.details as { localDependencies?: unknown }).localDependencies;
    expect(Array.isArray(deps)).toBe(true);
    expect(JSON.stringify(deps)).toContain("ty_mood");
  });

  it("dependencies first, then the dependent type: both moves succeed in one batch", () => {
    accept(richDoc(), [
      { op: "type.moveScope", typeId: "ty_mood", to: G },
      { op: "type.moveScope", typeId: "ty_pair", to: G },
    ]);
  });

  it("flow → other flow is rejected (move via global)", () => {
    reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_mood", to: { kind: "flow", flowId: PORTRAIT } }], "command.invalid_payload", {
      contains: ["global"],
    });
  });

  // Type names use the type.* codes (phase-2.md §3.1; commands.md §3 still says command.duplicate_name).
  it("name conflict in the target scope → type.duplicate_name", () => {
    const d = build(richDoc(), [{ op: "type.defineEnum", scope: G, id: "ty_gm", name: "Mood", members: ["x"] }]);
    reject(d, [{ op: "type.moveScope", typeId: "ty_mood", to: G }], "type.duplicate_name", { message: msg.duplicateTypeName("Mood") });
  });

  it("same scope is a no-op (global and flow)", () => {
    expect(accept(richDoc(), [{ op: "type.moveScope", typeId: "ty_unused", to: G }]).changed).toBe(false);
    expect(accept(richDoc(), [{ op: "type.moveScope", typeId: "ty_mood", to: F }]).changed).toBe(false);
  });

  it("unknown type / flow → command.unknown_ref", () => {
    reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_nope", to: G }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.moveScope", typeId: "ty_unused", to: { kind: "flow", flowId: "flow_nope" } }], "command.unknown_ref");
  });
});

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

describe("type.field.add", () => {
  it("adds at an index; struct.make / struct.break gain the port in every flow", () => {
    const r = accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "title", type: "text", default: "Sir", description: "Honorific", index: 1 }]);
    expect(fieldNames(r.doc, "ty_char")).toEqual(["name", "title", "age", "style", "nickname"]);
    expect(structOf(r.doc, "ty_char").fields[1]).toEqual({ name: "title", type: ir.text(), default: "Sir", description: "Honorific" });
    expect(portsOf(r.doc, KIT, "n_make").inputs).toContain("title");
    expect(portsOf(r.doc, PORTRAIT, "n_brk").outputs).toContain("title");
  });

  it("index defaults to the end and is clamped to [0, n]", () => {
    expect(fieldNames(accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "z", type: "text?" }]).doc, "ty_char").at(-1)).toBe("z");
    expect(fieldNames(accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "z", type: "text?", index: 99 }]).doc, "ty_char").at(-1)).toBe("z");
    expect(fieldNames(accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "z", type: "text?", index: -4 }]).doc, "ty_char")[0]).toBe("z");
    reject(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "z", type: "text", index: 1.5 }], "command.invalid_payload");
  });

  it("a required field without default makes stored values soft-invalid", () => {
    const r = accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "power", type: "int" }]);
    expect(diags(r.diagnostics, "global.invalid_value").some((d) => d.path.globalId === "gv_hero")).toBe(true);
    expect((r.doc.globals.find((g) => g.id === "gv_hero")!.value as Record<string, unknown>).name).toBe("Aria");
  });

  it("an optional field keeps stored values valid", () => {
    const r = accept(richDoc(), [{ op: "type.field.add", typeId: "ty_char", name: "alias", type: "text?" }]);
    expect(diags(r.diagnostics, "global.invalid_value")).toEqual([]);
  });

  it("rejections", () => {
    const add = (extra: Record<string, unknown>): Command[] => [{ op: "type.field.add", typeId: "ty_char", name: "x", type: "text", ...extra } as Command];
    reject(richDoc(), add({ name: "NAME" }), "command.duplicate_name", { message: msg.duplicateName("name") });
    reject(richDoc(), add({ name: "a-b" }), "command.invalid_name", { message: msg.invalidName("a-b") });
    reject(richDoc(), add({ name: "prototype" }), "command.reserved_name");
    reject(richDoc(), add({ type: "Nope" }), "type.unknown");
    reject(richDoc(), add({ type: ir.named("ty_mood") }), "visibility.local_type_in_global");
    reject(richDoc(), add({ type: "list<Character>" }), "type.recursive");
    reject(richDoc(), add({ type: "Team" }), "type.recursive"); // Team → Character → Team
    reject(richDoc(), add({ type: "int", default: "x" }), "type.invalid_default", { message: msg.invalidDefault });
    reject(richDoc(), add({ type: "list<int>[5..2]" }), "type.invalid_constraint");
    reject(richDoc(), [{ op: "type.field.add", typeId: "ty_nope", name: "x", type: "text" }], "command.unknown_ref", { message: msg.unknownRef("type.field.add", "type", "ty_nope") });
    reject(richDoc(), [{ op: "type.field.add", typeId: "ty_style", name: "x", type: "text" }], "type.not_struct");
  });

  it("a local struct resolves local types in shorthand", () => {
    const r = accept(richDoc(), [{ op: "type.field.add", typeId: "ty_pair", name: "other", type: "Mood?" }]);
    expect(structOf(r.doc, "ty_pair").fields.at(-1)!.type).toEqual(ir.optional(ir.named("ty_mood")));
  });
});

describe("type.field.remove", () => {
  it("removes ports, their edges and constants; stored values keep the key (soft)", () => {
    const r = accept(richDoc(), [{ op: "type.field.remove", typeId: "ty_char", field: "name" }]);
    expect(fieldNames(r.doc, "ty_char")).toEqual(["age", "style", "nickname"]);
    expect(flowOf(r.doc, PORTRAIT).edges.map((e) => e.id)).toEqual(["e_1", "e_3", "e_4"]);
    expect(nodeOf(r.doc, KIT, "n_make")!.values).toEqual({ age: 5, style: "anime" });
    expect(r.doc.globals.find((g) => g.id === "gv_hero")!.value).toEqual(HERO);
    expect(diags(r.diagnostics, "global.invalid_value").some((d) => d.path.globalId === "gv_hero")).toBe(true);
  });

  it("unknown field / enum target", () => {
    const e = reject(richDoc(), [{ op: "type.field.remove", typeId: "ty_char", field: "ghost" }], "command.unknown_ref", { contains: ['"ghost"'] });
    expect((e.details as Record<string, unknown>).kind).toBe("field");
    reject(richDoc(), [{ op: "type.field.remove", typeId: "ty_style", field: "anime" }], "type.not_struct");
  });
});

describe("type.field.rename", () => {
  it("rewrites ports, edges, constant keys and keys inside every stored value of the struct", () => {
    const r = accept(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "fullName" }]);
    const d = r.doc;
    expect(fieldNames(d, "ty_char")).toEqual(["fullName", "age", "style", "nickname"]);
    const e2 = flowOf(d, PORTRAIT).edges.find((e) => e.id === "e_2")!;
    expect(e2.from).toEqual({ node: "n_brk", port: "fullName" });
    expect(e2.to).toEqual({ node: "n_tpl", port: "name" }); // template placeholder untouched
    expect(nodeOf(d, KIT, "n_make")!.values).toEqual({ fullName: "Aria", age: 5, style: "anime" });
    expect(d.globals.find((g) => g.id === "gv_hero")!.value).toEqual({ fullName: "Aria", age: 30, style: "anime", nickname: null });
    expect(flowOf(d, KIT).variables.find((v) => v.id === "var_hero")!.default).toEqual({ fullName: "Bo", age: 1, style: "pixel", nickname: null });
    expect(nodeOf(d, KIT, "n_chars")!.values).toEqual({ value: [{ fullName: "Cy", age: 2, style: "anime", nickname: null }] });
    expect(structOf(d, "ty_team").fields[0]!.default).toEqual({ fullName: "Lead", age: 40, style: "realistic", nickname: null });
    expect(nodeOf(d, KIT, "n_const")!.values).toEqual({ value: ["anime"] });
    expect(diags(r.diagnostics, "node.invalid_value")).toEqual([]);
    expect(diags(r.diagnostics, "global.invalid_value")).toEqual([]);
  });

  it("rewrites flow input defaults typed as the struct", () => {
    const d = build(richDoc(), [{ op: "flow.input.setDefault", flowId: PORTRAIT, name: "character", value: { name: "D", style: "anime" } }]);
    const r = accept(d, [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "label" }]);
    expect(flowOf(r.doc, PORTRAIT).inputs[0]!.default).toMatchObject({ label: "D" });
  });

  it("same name is a no-op; rejections", () => {
    expect(accept(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "name" }]).changed).toBe(false);
    reject(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "AGE" }], "command.duplicate_name", { message: msg.duplicateName("age") });
    reject(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "9" }], "command.invalid_name");
    reject(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "constructor" }], "command.reserved_name");
    reject(richDoc(), [{ op: "type.field.rename", typeId: "ty_char", field: "ghost", name: "x" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.field.rename", typeId: "ty_style", field: "anime", name: "x" }], "type.not_struct");
  });
});

describe("type.field.setType", () => {
  it("soft breakage: constants, globals, variables and the field default become diagnostics", () => {
    const r = accept(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: "text" }]);
    expect(structOf(r.doc, "ty_char").fields[1]!.type).toEqual(ir.text());
    expect(structOf(r.doc, "ty_char").fields[1]!.default).toBe(30);
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_make")).toBe(true);
    expect(diags(r.diagnostics, "global.invalid_value").some((d) => d.path.globalId === "gv_hero")).toBe(true);
    expect(diags(r.diagnostics, "variable.invalid_default").some((d) => d.path.variableId === "var_hero")).toBe(true);
    expect(diags(r.diagnostics, "type.invalid_default").some((d) => d.path.typeId === "ty_char" && d.path.field === "age")).toBe(true);
    expect(r.resolved[0]).toMatchObject({ type: ir.text() });
  });

  it("IR with constraints is accepted", () => {
    const r = accept(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: ir.int({ min: 0, max: 200 }) }]);
    expect(structOf(r.doc, "ty_char").fields[1]!.type).toEqual(ir.int({ min: 0, max: 200 }));
  });

  it("hard: visibility, recursion, unknown types", () => {
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: ir.named("ty_mood") }], "visibility.local_type_in_global");
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: "Character?" }], "type.recursive");
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: "list<Team>" }], "type.recursive");
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: "Nope" }], "type.unknown");
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_char", field: "ghost", type: "int" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.field.setType", typeId: "ty_style", field: "x", type: "int" }], "type.not_struct");
  });
});

describe("type.field.reorder", () => {
  it.each([
    [0, ["nickname", "name", "age", "style"]],
    [2, ["name", "age", "nickname", "style"]],
    [99, ["name", "age", "style", "nickname"]],
    [-3, ["nickname", "name", "age", "style"]],
  ])("index %d (clamped to [0, n-1])", (index, expected) => {
    const r = accept(richDoc(), [{ op: "type.field.reorder", typeId: "ty_char", field: "nickname", index }]);
    expect(fieldNames(r.doc, "ty_char")).toEqual(expected);
  });

  it("rejections", () => {
    reject(richDoc(), [{ op: "type.field.reorder", typeId: "ty_char", field: "nickname", index: 0.5 }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.field.reorder", typeId: "ty_char", field: "ghost", index: 0 }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.field.reorder", typeId: "ty_style", field: "x", index: 0 }], "type.not_struct");
  });
});

describe("type.field.setDescription / setDefault / clearDefault", () => {
  it("setDescription sets and clears", () => {
    const d = accept(richDoc(), [{ op: "type.field.setDescription", typeId: "ty_char", field: "name", description: "Full name" }]).doc;
    expect(structOf(d, "ty_char").fields[0]!.description).toBe("Full name");
    const c = accept(d, [{ op: "type.field.setDescription", typeId: "ty_char", field: "name", description: null }]).doc;
    expect("description" in structOf(c, "ty_char").fields[0]!).toBe(false);
    reject(richDoc(), [{ op: "type.field.setDescription", typeId: "ty_char", field: "name", description: chars(2001) }], "command.invalid_payload");
  });

  it("setDefault validates hard", () => {
    const d = accept(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "age", value: 40 }]).doc;
    expect(structOf(d, "ty_char").fields[1]!.default).toBe(40);
    accept(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "style", value: "pixel" }]);
    reject(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "age", value: -1 }], "type.invalid_default", { message: msg.invalidDefault });
    reject(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "style", value: "Anime" }], "type.invalid_default");
    reject(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "ghost", value: 1 }], "command.unknown_ref");
  });

  it("clearDefault removes the key", () => {
    const r = accept(richDoc(), [{ op: "type.field.clearDefault", typeId: "ty_char", field: "age" }]);
    expect("default" in structOf(r.doc, "ty_char").fields[1]!).toBe(false);
  });

  it("enum targets → type.not_struct for every field op", () => {
    const ops: Command[] = [
      { op: "type.field.setDescription", typeId: "ty_style", field: "a", description: "x" },
      { op: "type.field.setDefault", typeId: "ty_style", field: "a", value: 1 },
      { op: "type.field.clearDefault", typeId: "ty_style", field: "a" },
    ];
    for (const c of ops) reject(richDoc(), [c], "type.not_struct");
  });
});

// ---------------------------------------------------------------------------------------------
// Enum members
// ---------------------------------------------------------------------------------------------

describe("type.enum.addMember", () => {
  it("adds with label at an index (clamped)", () => {
    const r = accept(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "sketch", label: "Sketch", index: 1 }]);
    expect(enumOf(r.doc, "ty_style").members[1]).toEqual({ value: "sketch", label: "Sketch" });
    expect(memberValues(accept(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "x", index: 50 }]).doc, "ty_style").at(-1)).toBe("x");
    expect(memberValues(accept(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "x" }]).doc, "ty_style").at(-1)).toBe("x");
  });

  it("rejections", () => {
    reject(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "Anime" }], "type.duplicate_member");
    reject(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "a b" }], "command.invalid_name");
    reject(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_style", value: "x", label: "" }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_char", value: "x" }], "type.not_enum");
    reject(richDoc(), [{ op: "type.enum.addMember", typeId: "ty_nope", value: "x" }], "command.unknown_ref");
  });
});

describe("type.enum.removeMember", () => {
  it("removes; stored values using it become soft diagnostics", () => {
    const r = accept(richDoc(), [{ op: "type.enum.removeMember", typeId: "ty_style", value: "anime" }]);
    expect(memberValues(r.doc, "ty_style")).toEqual(["realistic", "pixel"]);
    expect(nodeOf(r.doc, KIT, "n_make")!.values!.style).toBe("anime");
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_make")).toBe(true);
    expect(diags(r.diagnostics, "global.invalid_value").some((d) => d.path.globalId === "gv_hero")).toBe(true);
  });

  it("unknown member / struct target", () => {
    const e = reject(richDoc(), [{ op: "type.enum.removeMember", typeId: "ty_style", value: "ghost" }], "command.unknown_ref", { contains: ['"ghost"'] });
    expect((e.details as Record<string, unknown>).kind).toBe("member");
    reject(richDoc(), [{ op: "type.enum.removeMember", typeId: "ty_char", value: "name" }], "type.not_enum");
  });
});

describe("type.enum.renameMember", () => {
  it("rewrites stored values typed as this enum, and only those", () => {
    const r = accept(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_style", value: "anime", newValue: "manga" }]);
    const d = r.doc;
    expect(enumOf(d, "ty_style").members[0]).toEqual({ value: "manga", label: "Anime" });
    expect(nodeOf(d, KIT, "n_make")!.values!.style).toBe("manga");
    expect((d.globals.find((g) => g.id === "gv_hero")!.value as Record<string, unknown>).style).toBe("manga");
    expect((nodeOf(d, KIT, "n_chars")!.values!.value as Record<string, unknown>[])[0]!.style).toBe("manga");
    expect(nodeOf(d, KIT, "n_const")!.values).toEqual({ value: ["anime"] }); // list<text>, not the enum
    expect(diags(r.diagnostics, "node.invalid_value")).toEqual([]);
  });

  it("local enum: variable defaults and constants are rewritten", () => {
    const d = accept(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_mood", value: "calm", newValue: "serene" }]).doc;
    expect(flowOf(d, KIT).variables.find((v) => v.id === "var_mood")!.default).toBe("serene");
    expect(nodeOf(d, KIT, "n_moodc")!.values).toEqual({ value: "serene" });
  });

  it("rewrites field defaults typed as the enum", () => {
    const d = build(richDoc(), [{ op: "type.field.setDefault", typeId: "ty_char", field: "style", value: "pixel" }]);
    const r = accept(d, [{ op: "type.enum.renameMember", typeId: "ty_style", value: "pixel", newValue: "pixels" }]);
    expect(structOf(r.doc, "ty_char").fields[2]!.default).toBe("pixels");
    expect(structOf(r.doc, "ty_team").fields[0]!.default).toMatchObject({ style: "realistic" });
  });

  it("rejections", () => {
    reject(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_style", value: "anime", newValue: "PIXEL" }], "type.duplicate_member");
    reject(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_style", value: "anime", newValue: "a b" }], "command.invalid_name");
    reject(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_style", value: "ghost", newValue: "x" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.enum.renameMember", typeId: "ty_char", value: "name", newValue: "x" }], "type.not_enum");
  });
});

describe("type.enum.setMemberLabel", () => {
  it("sets and clears", () => {
    const d = accept(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "realistic", label: "Realistic" }]).doc;
    expect(enumOf(d, "ty_style").members[1]).toEqual({ value: "realistic", label: "Realistic" });
    const c = accept(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "anime", label: null }]).doc;
    expect(enumOf(c, "ty_style").members[0]).toEqual({ value: "anime" });
  });

  it("rejections", () => {
    reject(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "anime", label: " " }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "anime", label: chars(121) }], "command.invalid_payload");
    reject(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "ghost", label: "x" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "type.enum.setMemberLabel", typeId: "ty_char", value: "name", label: "x" }], "type.not_enum");
  });
});
