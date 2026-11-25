/**
 * `extends` and static fields in type commands (types.md §1.3, commands.md §3).
 */
import { describe, expect, it } from "vitest";
import type { ScopeInput } from "@briarflow/authoring";
import type { ContextDocument, StructDecl } from "@briarflow/core";
import { validateContext } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { richDoc } from "./fixtures/docs.js";
import { testCatalog } from "@briarflow/testing";
import { accept, build, reject } from "./fixtures/helpers.js";

const G: ScopeInput = { kind: "global" };
const SHORT = { op: "type.defineStruct", scope: G, id: "ty_short", name: "ShortText", extends: "Text", fields: [{ name: "maxLength", type: "int?", static: true, default: 80 }] } as const;

function structOf(doc: ContextDocument, id: string): StructDecl {
  const t = doc.types.find((x) => x.id === id) ?? doc.flows.flatMap((f) => f.types).find((x) => x.id === id);
  if (t?.kind !== "struct") throw new Error(`struct ${id} missing`);
  return t;
}

describe("extends and static fields", () => {
  it("defines a struct that extends a built-in and sets an inherited static field", () => {
    const r = accept(richDoc(), [SHORT]);
    expect(structOf(r.doc, "ty_short")).toEqual({
      kind: "struct",
      id: "ty_short",
      name: "ShortText",
      extends: "briar.Text",
      fields: [{ name: "maxLength", type: ir.optional(ir.int()), static: true, default: 80 }],
    });
    expect(validateContext(r.doc, testCatalog()).filter((d) => d.severity === "error")).toEqual([]);
  });

  it("extends a struct of the document and chains", () => {
    const doc = build(richDoc(), [SHORT]);
    const r = accept(doc, [{ op: "type.defineStruct", scope: G, id: "ty_tiny", name: "TinyText", extends: "ShortText", fields: [{ name: "maxLength", type: "int?", static: true, default: 10 }] }]);
    expect(structOf(r.doc, "ty_tiny").extends).toBe("ty_short");
  });

  it("rejects an instance field on an extending struct", () => {
    reject(richDoc(), [{ ...SHORT, fields: [{ name: "extra", type: "int" }] }], "type.extends_instance_field");
    const doc = build(richDoc(), [SHORT]);
    reject(doc, [{ op: "type.field.add", typeId: "ty_short", name: "extra", type: "int" }], "type.extends_instance_field");
    reject(doc, [{ op: "type.field.setStatic", typeId: "ty_short", field: "maxLength", static: false }], "type.extends_instance_field");
  });

  it("rejects another type for an inherited static field, and limits that cannot hold", () => {
    reject(richDoc(), [{ ...SHORT, fields: [{ name: "maxLength", type: "string", static: true, default: "x" }] }], "type.extends_override");
    reject(richDoc(), [{ ...SHORT, fields: [{ name: "minLength", type: "int", static: true, default: 9 }, { name: "maxLength", type: "int?", static: true, default: 2 }] }], "type.invalid_constraint");
    reject(richDoc(), [{ ...SHORT, fields: [{ name: "pattern", type: "string?", static: true, default: "(" }] }], "type.invalid_constraint");
    const doc = build(richDoc(), [SHORT]);
    reject(doc, [{ op: "type.field.setDefault", typeId: "ty_short", field: "maxLength", value: -1 }], "type.invalid_constraint");
  });

  it("rejects a static field without a value unless it is optional", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "Pet", fields: [{ name: "legs", type: "int", static: true }] }], "type.static_without_value");
    const doc = build(richDoc(), [{ op: "type.defineStruct", scope: G, id: "ty_pet", name: "Pet", fields: [{ name: "legs", type: "int", static: true, default: 4 }] }]);
    reject(doc, [{ op: "type.field.clearDefault", typeId: "ty_pet", field: "legs" }], "type.static_without_value");
  });

  it("rejects extending an enum, a cycle, and changes to built-ins", () => {
    reject(richDoc(), [{ op: "type.defineStruct", scope: G, name: "Odd", extends: "ArtStyle" }], "type.extends_not_struct");
    const doc = build(richDoc(), [SHORT, { op: "type.defineStruct", scope: G, id: "ty_tiny", name: "TinyText", extends: "ShortText" }]);
    reject(doc, [{ op: "type.setExtends", typeId: "ty_short", extends: "TinyText" }], "type.extends_cycle");
    reject(doc, [{ op: "type.field.add", typeId: "briar.Text", name: "x", type: "int" }], "type.read_only");
  });

  it("a struct that is extended is in use; a change to its base is checked on it", () => {
    const doc = build(richDoc(), [
      { op: "type.defineStruct", scope: G, id: "ty_pet", name: "Pet", fields: [{ name: "name", type: "string" }, { name: "legs", type: "int", static: true, default: 4 }] },
      { op: "type.defineStruct", scope: G, id: "ty_bird", name: "Bird", extends: "Pet", fields: [{ name: "legs", type: "int", static: true, default: 2 }] },
    ]);
    reject(doc, [{ op: "type.delete", typeId: "ty_pet" }], "type.in_use");
    reject(doc, [{ op: "type.field.setType", typeId: "ty_pet", field: "legs", type: "float" }], "type.extends_override");
    // Renaming the base's static field renames the value Bird gives it.
    const r = accept(doc, [{ op: "type.field.rename", typeId: "ty_pet", field: "legs", name: "feet" }]);
    expect(structOf(r.doc, "ty_bird").fields).toEqual([{ name: "feet", type: ir.int(), static: true, default: 2 }]);
  });

  it("type.setExtends sets and clears", () => {
    const doc = build(richDoc(), [{ op: "type.defineStruct", scope: G, id: "ty_lim", name: "Limited", fields: [] }]);
    const r = accept(doc, [{ op: "type.setExtends", typeId: "ty_lim", extends: "Image" }]);
    expect(structOf(r.doc, "ty_lim").extends).toBe("briar.Image");
    expect(r.inverse).toMatchObject([{ op: "type.setExtends", typeId: "ty_lim", extends: null }]);
    const back = accept(r.doc, [{ op: "type.setExtends", typeId: "ty_lim", extends: null }]);
    expect(structOf(back.doc, "ty_lim").extends).toBeUndefined();
  });
});
