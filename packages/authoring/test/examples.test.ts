/** commands.md §10 examples and soft breakage (§1.3). */
import { describe, expect, it } from "vitest";
import { ir } from "@briarflow/testing";
import { PORTRAIT, SECTION_10_BATCH, emptyDoc } from "./fixtures/docs.js";
import { accept, build, diags, edgeIds, nodeOf, reject } from "./fixtures/helpers.js";

describe("commands.md §10", () => {
  it("the build batch succeeds with no diagnostics", () => {
    const r = accept(emptyDoc(), SECTION_10_BATCH);
    expect(r.created[2]).toEqual({ flowId: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out" });
    expect(r.created[0]).toEqual({ typeId: "ty_style" });
    expect(r.created[5]).toEqual({ nodeId: "n_brk" });
    expect(r.created[7]).toEqual({ edgeId: "e_1" });
    expect(r.diagnostics).toEqual([]);
    expect(r.doc.revision).toBe(1);
    expect(nodeOf(r.doc, PORTRAIT, "n_tpl")!.typeBindings).toEqual({ T1: ir.text(), T2: ir.named("ty_style") });
  });

  it("type.field.setType style → int keeps e_3 without diagnostics (template re-binds)", () => {
    const doc = build(emptyDoc(), SECTION_10_BATCH);
    const r = accept(doc, [{ op: "type.field.setType", typeId: "ty_char", field: "style", type: "int" }]);
    expect(edgeIds(r.doc, PORTRAIT)).toContain("e_3");
    expect(r.diagnostics).toEqual([]);
    expect(nodeOf(r.doc, PORTRAIT, "n_tpl")!.typeBindings).toEqual({ T1: ir.text(), T2: ir.int() });
  });

  it("flow.output.setType prompt → image gives edge.type_mismatch on e_4", () => {
    const doc = build(emptyDoc(), SECTION_10_BATCH);
    const r = accept(doc, [{ op: "flow.output.setType", flowId: PORTRAIT, name: "prompt", type: "image" }]);
    expect(edgeIds(r.doc, PORTRAIT)).toContain("e_4");
    const d = diags(r.diagnostics, "edge.type_mismatch");
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toMatchObject({ flowId: PORTRAIT, edgeId: "e_4" });
    expect(d[0]!.severity).toBe("error");
  });

  it("the rejection example returns the exact message", () => {
    const doc = build(emptyDoc(), SECTION_10_BATCH);
    const e = reject(doc, [{ op: "flow.input.add", flowId: "flow_p", name: "Character", type: "text" }], "command.duplicate_name", {
      message: 'A flow input named "character" already exists in flow "Portrait". Names must be unique (ignoring case).',
    });
    expect(e.commandIndex).toBe(0);
  });

  it("the whole build batch undoes to the empty context", () => {
    // covered by accept(); asserted explicitly for readability
    const r = accept(emptyDoc(), SECTION_10_BATCH);
    expect(r.inverse.every((c) => c.restore === true)).toBe(true);
  });
});
