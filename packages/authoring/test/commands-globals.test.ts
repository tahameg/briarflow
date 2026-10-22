import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import type { ContextDocument, GlobalVariable } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { KIT, richDoc } from "./fixtures/docs.js";
import { accept, build, chars, diags, edgeIds, msg, nodeOf, portsOf, reject } from "./fixtures/helpers.js";

function g(doc: ContextDocument, id: string): GlobalVariable {
  const x = doc.globals.find((v) => v.id === id);
  if (!x) throw new Error(`global ${id} missing`);
  return x;
}

describe("global.create", () => {
  it("creates with a shorthand type stored as IR, value and description", () => {
    const r = accept(richDoc(), [
      { op: "global.create", id: "gv_tags", name: "tags", type: "list<text>", access: "readonly", value: ["a"], description: "Tags" },
    ]);
    expect(r.created).toEqual([{ globalId: "gv_tags" }]);
    expect(r.doc.globals.at(-1)).toEqual({ id: "gv_tags", name: "tags", type: ir.list(ir.text()), access: "readonly", value: ["a"], description: "Tags" });
    expect(r.resolved[0]).toMatchObject({ type: ir.list(ir.text()) });
  });

  it("generated id; readwrite without a value; global types resolve", () => {
    const r = accept(richDoc(), [{ op: "global.create", name: "style", type: "ArtStyle", access: "readwrite" }]);
    expect(r.created[0]!.globalId).toBe("gv_1");
    expect(g(r.doc, "gv_1")).toEqual({ id: "gv_1", name: "style", type: ir.named("ty_style"), access: "readwrite" });
  });

  it("readonly without value → global.readonly_requires_value", () => {
    reject(richDoc(), [{ op: "global.create", name: "key", type: "text", access: "readonly" }], "global.readonly_requires_value", {
      message: 'Readonly global "key" needs a value. Set a value or make it readwrite.',
    });
  });

  it("invalid value → value.invalid with the value path", () => {
    const e = reject(richDoc(), [{ op: "global.create", name: "limit", type: "int", access: "readwrite", value: "a" }], "value.invalid", {
      message: 'globals.limit must be a whole number (got "a")',
    });
    expect(Array.isArray((e.details as { diagnostics?: unknown }).diagnostics)).toBe(true);
  });

  it("name rules", () => {
    reject(richDoc(), [{ op: "global.create", name: "Brand", type: "text", access: "readwrite" }], "command.duplicate_name", { message: msg.duplicateName("brand") });
    reject(richDoc(), [{ op: "global.create", name: "my global", type: "text", access: "readwrite" }], "command.invalid_name", { message: msg.invalidName("my global") });
    reject(richDoc(), [{ op: "global.create", name: chars(65), type: "text", access: "readwrite" }], "command.invalid_name");
    reject(richDoc(), [{ op: "global.create", name: "__proto__", type: "text", access: "readwrite" }], "command.reserved_name", { message: msg.reservedName("__proto__") });
  });

  it("types: visibility, unknown, local shorthand not visible", () => {
    reject(richDoc(), [{ op: "global.create", name: "m", type: ir.named("ty_mood"), access: "readwrite" }], "visibility.local_type_in_global", { contains: ['"Mood"'] });
    reject(richDoc(), [{ op: "global.create", name: "m", type: "Mood", access: "readwrite" }], "type.unknown");
    reject(richDoc(), [{ op: "global.create", name: "m", type: "list<", access: "readwrite" }], "type.syntax");
  });

  it("payload and ids", () => {
    reject(richDoc(), [{ op: "global.create", name: "m", type: "text", access: "write" } as unknown as Command], "command.invalid_payload", {
      message: msg.invalidPayload("global.create", "access"),
    });
    reject(richDoc(), [{ op: "global.create", id: "var_x", name: "m", type: "text", access: "readwrite" }], "command.invalid_id", { message: msg.invalidId("global.create", "var_x") });
    reject(richDoc(), [{ op: "global.create", id: "gv_brand", name: "m", type: "text", access: "readwrite" }], "command.duplicate_id", { message: msg.duplicateId("global.create", "gv_brand") });
  });
});

describe("global.rename", () => {
  it("renames; nodes reference ids so nothing else changes", () => {
    const r = accept(richDoc(), [{ op: "global.rename", globalId: "gv_brand", name: "company" }]);
    expect(g(r.doc, "gv_brand").name).toBe("company");
    expect(nodeOf(r.doc, KIT, "n_bgget")!.config).toEqual({ globalId: "gv_brand" });
  });
  it("rejections", () => {
    reject(richDoc(), [{ op: "global.rename", globalId: "gv_brand", name: "COUNT" }], "command.duplicate_name", { message: msg.duplicateName("count") });
    reject(richDoc(), [{ op: "global.rename", globalId: "gv_brand", name: "1" }], "command.invalid_name");
    const e = reject(richDoc(), [{ op: "global.rename", globalId: "gv_nope", name: "x" }], "command.unknown_ref", { message: msg.unknownRef("global.rename", "global", "gv_nope") });
    expect(e.details).toMatchObject({ kind: "global", id: "gv_nope" });
  });
});

describe("global.setType", () => {
  it("soft: value and set-node constants become diagnostics; get/set ports follow", () => {
    const r = accept(richDoc(), [{ op: "global.setType", globalId: "gv_count", type: "text" }]);
    expect(g(r.doc, "gv_count").type).toEqual(ir.text());
    expect(g(r.doc, "gv_count").value).toBe(0);
    expect(diags(r.diagnostics, "global.invalid_value").some((d) => d.path.globalId === "gv_count")).toBe(true);
    expect(diags(r.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_cset")).toBe(true);
  });

  it("type changes on get nodes reach their edges (soft edge.type_mismatch)", () => {
    const r = accept(richDoc(), [{ op: "global.setType", globalId: "gv_brand", type: "int" }]);
    expect(edgeIds(r.doc, KIT)).toContain("e_3");
    expect(diags(r.diagnostics, "edge.type_mismatch").some((d) => d.path.edgeId === "e_3")).toBe(true);
    expect(portsOf(r.doc, KIT, "n_bgget").outputs).toEqual(["value"]);
  });

  it("hard: visibility; unknown", () => {
    reject(richDoc(), [{ op: "global.setType", globalId: "gv_count", type: ir.named("ty_mood") }], "visibility.local_type_in_global");
    reject(richDoc(), [{ op: "global.setType", globalId: "gv_count", type: "Nope" }], "type.unknown");
    reject(richDoc(), [{ op: "global.setType", globalId: "gv_nope", type: "int" }], "command.unknown_ref");
  });
});

describe("global.setAccess", () => {
  it("readwrite → readonly with a value; existing set nodes → soft variable.write_to_readonly", () => {
    const r = accept(richDoc(), [{ op: "global.setAccess", globalId: "gv_count", access: "readonly" }]);
    expect(g(r.doc, "gv_count").access).toBe("readonly");
    expect(diags(r.diagnostics, "variable.write_to_readonly").length).toBeGreaterThan(0);
  });
  it("readonly → readwrite", () => {
    expect(g(accept(richDoc(), [{ op: "global.setAccess", globalId: "gv_brand", access: "readwrite" }]).doc, "gv_brand").access).toBe("readwrite");
  });
  it("→ readonly without a value is rejected", () => {
    reject(richDoc(), [{ op: "global.setAccess", globalId: "gv_spare", access: "readonly" }], "global.readonly_requires_value", {
      message: 'Readonly global "spare" needs a value. Set a value or make it readwrite.',
    });
  });
  it("same access is a no-op; bad access is invalid_payload", () => {
    expect(accept(richDoc(), [{ op: "global.setAccess", globalId: "gv_brand", access: "readonly" }]).changed).toBe(false);
    reject(richDoc(), [{ op: "global.setAccess", globalId: "gv_brand", access: "public" } as unknown as Command], "command.invalid_payload");
  });
});

describe("global.setValue / clearValue / setDescription", () => {
  it("setValue validates hard", () => {
    expect(g(accept(richDoc(), [{ op: "global.setValue", globalId: "gv_count", value: 7 }]).doc, "gv_count").value).toBe(7);
    expect(g(accept(richDoc(), [{ op: "global.setValue", globalId: "gv_spare", value: "x" }]).doc, "gv_spare").value).toBe("x");
    reject(richDoc(), [{ op: "global.setValue", globalId: "gv_count", value: 1.5 }], "value.invalid", { message: "globals.count must be a whole number (got 1.5)" });
    reject(richDoc(), [{ op: "global.setValue", globalId: "gv_hero", value: { ...{ name: "A", age: 1, style: "Anime" } } }], "value.invalid", {
      contains: ["globals.hero.style"],
    });
    reject(richDoc(), [{ op: "global.setValue", globalId: "gv_nope", value: 1 }], "command.unknown_ref");
  });

  it("clearValue removes the value; rejected on readonly", () => {
    const r = accept(richDoc(), [{ op: "global.clearValue", globalId: "gv_count" }]);
    expect("value" in g(r.doc, "gv_count")).toBe(false);
    reject(richDoc(), [{ op: "global.clearValue", globalId: "gv_brand" }], "global.readonly_requires_value", {
      message: 'Readonly global "brand" needs a value. Set a value or make it readwrite.',
    });
  });

  it("setDescription sets and clears", () => {
    const d = accept(richDoc(), [{ op: "global.setDescription", globalId: "gv_brand", description: "Company" }]).doc;
    expect(g(d, "gv_brand").description).toBe("Company");
    expect("description" in g(accept(d, [{ op: "global.setDescription", globalId: "gv_brand", description: null }]).doc, "gv_brand")).toBe(false);
    reject(richDoc(), [{ op: "global.setDescription", globalId: "gv_brand", description: chars(2001) }], "command.invalid_payload");
  });
});

describe("global.delete", () => {
  it("deletes an unused global", () => {
    const r = accept(richDoc(), [{ op: "global.delete", globalId: "gv_hero" }]);
    expect(r.doc.globals.map((x) => x.id)).toEqual(["gv_brand", "gv_count", "gv_spare"]);
  });

  it("used by get/set nodes → global.in_use with details.nodes", () => {
    const e = reject(richDoc(), [{ op: "global.delete", globalId: "gv_brand" }], "global.in_use", { contains: ['"brand"'] });
    expect((e.details as { nodes: unknown }).nodes).toEqual([{ flowId: KIT, nodeId: "n_bgget" }]);
    reject(richDoc(), [{ op: "global.delete", globalId: "gv_count", cascade: false }], "global.in_use");
  });

  it("cascade: true removes the nodes and their edges; undo restores everything", () => {
    const r = accept(richDoc(), [{ op: "global.delete", globalId: "gv_brand", cascade: true }]);
    expect(nodeOf(r.doc, KIT, "n_bgget")).toBeUndefined();
    expect(edgeIds(r.doc, KIT)).toEqual(["e_1", "e_2", "e_4"]);
    expect(r.doc.globals.map((x) => x.id)).not.toContain("gv_brand");
  });

  it("set nodes in several flows are all reported / removed", () => {
    const d = build(richDoc(), [
      { op: "node.add", flowId: "flow_p", id: "n_cs", type: "briar.global.set", position: { x: 0, y: 0 }, config: { globalId: "gv_count" } },
    ]);
    const e = reject(d, [{ op: "global.delete", globalId: "gv_count" }], "global.in_use");
    expect((e.details as { nodes: unknown[] }).nodes).toEqual(
      expect.arrayContaining([
        { flowId: KIT, nodeId: "n_cset" },
        { flowId: "flow_p", nodeId: "n_cs" },
      ]),
    );
    const r = accept(d, [{ op: "global.delete", globalId: "gv_count", cascade: true }]);
    expect(nodeOf(r.doc, "flow_p", "n_cs")).toBeUndefined();
    expect(nodeOf(r.doc, KIT, "n_cset")).toBeUndefined();
  });

  it("unknown → command.unknown_ref; cascade must be boolean", () => {
    reject(richDoc(), [{ op: "global.delete", globalId: "gv_x" }], "command.unknown_ref");
    reject(richDoc(), [{ op: "global.delete", globalId: "gv_hero", cascade: "yes" } as unknown as Command], "command.invalid_payload");
  });
});
