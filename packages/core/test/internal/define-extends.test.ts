/**
 * defineStruct with extends and static fields (types.md §1.3, node-api.md §7).
 */
import { describe, expect, it } from "vitest";
import { BUILTIN, createCatalog, defineNode, definePack, defineStruct, normalizeValue, scopeForContext, createContextDocument, t } from "@briarflow/core";

describe("defineStruct extends", () => {
  it("extends a built-in through its spec; the pack qualifies the id and keeps the base", () => {
    const Title = defineStruct("Title", { maxLength: { type: t.optional(t.int()), static: true, default: 5 } }, { extends: t.text() });
    expect(Title.decl.extends).toBe(BUILTIN.Text);
    const node = defineNode({ type: "demo.echo", inputs: { title: t.ref(Title) }, outputs: { title: t.ref(Title) }, run: ({ inputs }) => ({ title: inputs.title }) });
    const pack = definePack({ name: "demo", version: "1.0.0", nodes: [node], types: [Title] });
    const catalog = createCatalog([pack]);
    const decl = catalog.getType("demo.Title");
    expect(decl).toMatchObject({ kind: "struct", extends: "briar.Text" });
    const scope = scopeForContext(createContextDocument({ name: "x" }), catalog);
    const type = { kind: "named", id: "demo.Title" } as const;
    expect(normalizeValue({ value: "hello" }, type, scope)).toEqual({ ok: true, value: { value: "hello" } });
    const r = normalizeValue({ value: "too long" }, type, scope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]?.message).toBe("value.value must be at most 5 characters long");
  });

  it("refuses instance fields on an extending struct and a non-struct base", () => {
    expect(() => defineStruct("Odd", { extra: t.int() }, { extends: t.text() })).toThrow(/must be static/);
    expect(() => defineStruct("Odd", {}, { extends: t.int() })).toThrow(/extends needs a struct/);
  });
});
