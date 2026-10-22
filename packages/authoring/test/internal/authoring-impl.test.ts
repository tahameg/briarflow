import { describe, expect, it } from "vitest";
import { applyCommands, createContextEditor, type BatchResult, type Command } from "@briarflow/authoring";
import { createContextDocument, createSequentialIdGenerator, type ContextDocument } from "@briarflow/core";
import { testCatalog } from "@briarflow/testing";

const clock = () => new Date("2026-03-03T00:00:00Z");
const opts = () => ({ catalog: testCatalog(), idGenerator: createSequentialIdGenerator(), clock });

function empty(): ContextDocument {
  return createContextDocument({ name: "T", id: "ctx_t", idGenerator: createSequentialIdGenerator(), clock: () => new Date("2026-01-01T00:00:00Z") });
}

function strip(doc: ContextDocument) {
  return { ...doc, revision: 0, updatedAt: "" };
}

function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

/** Applies, asserts ok, and checks the undo + redo invariants. */
function ok(doc: ContextDocument, commands: Command[]): Extract<BatchResult, { ok: true }> {
  const start = freeze(structuredClone(doc));
  const r = applyCommands(start, commands, opts());
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  if (r.changed) {
    expect(r.inverse.every((c) => c.restore === true)).toBe(true);
    const undone = applyCommands(r.doc, r.inverse, opts());
    if (!undone.ok) throw new Error(`undo failed: ${undone.error.code}: ${undone.error.message}`);
    expect(strip(undone.doc)).toEqual(strip(start));
    const redone = applyCommands(start, r.resolved, { ...opts(), idGenerator: (p) => `${p}_never` });
    if (!redone.ok) throw new Error(`redo failed: ${redone.error.code}`);
    expect(strip(redone.doc)).toEqual(strip(r.doc));
  }
  return r;
}

function err(doc: ContextDocument, commands: Command[]) {
  const r = applyCommands(doc, commands, opts());
  if (r.ok) throw new Error("expected rejection");
  return r.error;
}

const SECTION_10: Command[] = [
  { op: "type.defineEnum", scope: { kind: "global" }, id: "ty_style", name: "ArtStyle", members: ["anime", "pixel"] },
  {
    op: "type.defineStruct",
    scope: { kind: "global" },
    id: "ty_char",
    name: "Character",
    fields: [
      { name: "name", type: "text" },
      { name: "style", type: "ArtStyle" },
    ],
  },
  { op: "flow.create", id: "flow_p", name: "Portrait", inputNodeId: "n_in", outputNodeId: "n_out" },
  { op: "flow.input.add", flowId: "flow_p", name: "character", type: "Character" },
  { op: "flow.output.add", flowId: "flow_p", name: "prompt", type: "text" },
  { op: "node.add", flowId: "flow_p", id: "n_brk", type: "briar.struct.break", position: { x: 200, y: 0 }, config: { typeId: "ty_char" } },
  { op: "node.add", flowId: "flow_p", id: "n_tpl", type: "text.template", position: { x: 420, y: 0 }, config: { template: "Draw {name} in {style} style" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_1", from: { node: "n_in", port: "character" }, to: { node: "n_brk", port: "value" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_2", from: { node: "n_brk", port: "name" }, to: { node: "n_tpl", port: "name" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_3", from: { node: "n_brk", port: "style" }, to: { node: "n_tpl", port: "style" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_4", from: { node: "n_tpl", port: "text" }, to: { node: "n_out", port: "prompt" } },
];

function portrait(): ContextDocument {
  return ok(empty(), SECTION_10).doc;
}

describe("commands.md §10 examples", () => {
  it("builds the example flow without diagnostics", () => {
    const r = ok(empty(), SECTION_10);
    expect(r.created[2]).toEqual({ flowId: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out" });
    expect(r.diagnostics).toEqual([]);
    expect(r.doc.revision).toBe(1);
    expect(r.doc.flows[0]?.nodes.find((n) => n.id === "n_tpl")?.typeBindings).toBeDefined();
  });

  it("soft breakage: field type change re-binds the template, output type change mismatches", () => {
    const a = ok(portrait(), [{ op: "type.field.setType", typeId: "ty_char", field: "style", type: "int" }]);
    expect(a.diagnostics).toEqual([]);
    const b = ok(portrait(), [{ op: "flow.output.setType", flowId: "flow_p", name: "prompt", type: "image" }]);
    expect(b.diagnostics.map((d) => [d.code, d.path.edgeId])).toContainEqual(["edge.type_mismatch", "e_4"]);
  });

  it("rejection example has the exact message and index", () => {
    const e = err(portrait(), [{ op: "flow.input.add", flowId: "flow_p", name: "Character", type: "text" }]);
    expect(e.code).toBe("command.duplicate_name");
    expect(e.commandIndex).toBe(0);
    expect(e.message).toBe('A flow input named "character" already exists in flow "Portrait". Names must be unique (ignoring case).');
  });
});

describe("structural follow-up", () => {
  it("field rename follows ports, edges and stored values", () => {
    const d = ok(portrait(), [
      { op: "global.create", id: "gv_hero", name: "hero", type: "Character", access: "readwrite", value: { name: "A", style: "anime" } },
    ]).doc;
    const r = ok(d, [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "title" }]);
    const flow = r.doc.flows[0]!;
    expect(flow.edges.find((e) => e.id === "e_2")?.from.port).toBe("title");
    expect(r.doc.globals[0]?.value).toEqual({ title: "A", style: "anime" });
    expect(r.diagnostics).toEqual([]);
  });

  it("field remove prunes edges and undo restores them", () => {
    const r = ok(portrait(), [{ op: "type.field.remove", typeId: "ty_char", field: "style" }]);
    expect(r.doc.flows[0]!.edges.map((e) => e.id)).toEqual(["e_1", "e_2", "e_4"]);
  });

  it("enum member rename rewrites constants", () => {
    const d = ok(portrait(), [
      { op: "node.add", flowId: "flow_p", id: "n_c", type: "briar.constant", position: { x: 0, y: 0 }, config: { type: "ArtStyle" }, values: { value: "anime" } },
    ]).doc;
    const r = ok(d, [{ op: "type.enum.renameMember", typeId: "ty_style", value: "anime", newValue: "manga" }]);
    expect(r.doc.flows[0]!.nodes.find((n) => n.id === "n_c")?.values).toEqual({ value: "manga" });
  });

  it("node.remove, flow.delete, flow.duplicate round-trip", () => {
    ok(portrait(), [{ op: "node.remove", flowId: "flow_p", nodeId: "n_brk" }]);
    ok(portrait(), [{ op: "flow.delete", flowId: "flow_p" }]);
    const dup = ok(portrait(), [{ op: "flow.duplicate", flowId: "flow_p" }]);
    expect(dup.doc.flows[1]?.name).toBe("Portrait copy");
  });

  it("global delete with cascade restores nodes and edges on undo", () => {
    const d = ok(portrait(), [
      { op: "global.create", id: "gv_n", name: "n", type: "text", access: "readwrite" },
      { op: "node.add", flowId: "flow_p", id: "n_g", type: "briar.global.get", position: { x: 0, y: 0 }, config: { globalId: "gv_n" } },
      { op: "node.add", flowId: "flow_p", id: "n_s", type: "kit.sinkText", position: { x: 0, y: 0 } },
      { op: "edge.connect", flowId: "flow_p", id: "e_g", from: { node: "n_g", port: "value" }, to: { node: "n_s", port: "value" } },
    ]).doc;
    expect(err(d, [{ op: "global.delete", globalId: "gv_n" }]).code).toBe("global.in_use");
    const r = ok(d, [{ op: "global.delete", globalId: "gv_n", cascade: true }]);
    expect(r.doc.flows[0]!.nodes.some((n) => n.id === "n_g")).toBe(false);
  });

  it("edge.connect replaces, rejects cycles and mismatches", () => {
    const d = ok(portrait(), [
      { op: "node.add", flowId: "flow_p", id: "n_a", type: "kit.passText", position: { x: 0, y: 0 } },
      { op: "node.add", flowId: "flow_p", id: "n_b", type: "kit.passText", position: { x: 0, y: 0 } },
      { op: "node.add", flowId: "flow_p", id: "n_i", type: "kit.intSource", position: { x: 0, y: 0 } },
      { op: "edge.connect", flowId: "flow_p", id: "e_ab", from: { node: "n_a", port: "value" }, to: { node: "n_b", port: "value" } },
    ]).doc;
    expect(err(d, [{ op: "edge.connect", flowId: "flow_p", from: { node: "n_b", port: "value" }, to: { node: "n_a", port: "value" } }]).code).toBe(
      "edge.cycle",
    );
    expect(err(d, [{ op: "edge.connect", flowId: "flow_p", from: { node: "n_i", port: "value" }, to: { node: "n_a", port: "value" } }]).code).toBe(
      "edge.type_mismatch",
    );
    const r = ok(d, [{ op: "edge.connect", flowId: "flow_p", id: "e_new", from: { node: "n_brk", port: "name" }, to: { node: "n_b", port: "value" } }]);
    expect(r.created[0]).toEqual({ edgeId: "e_new", replacedEdgeId: "e_ab" });
    const same = applyCommands(d, [{ op: "edge.connect", flowId: "flow_p", from: { node: "n_a", port: "value" }, to: { node: "n_b", port: "value" } }], opts());
    expect(same.ok && same.changed).toBe(false);
  });
});

describe("restore", () => {
  it("spec example: invalid constant comes back on undo", () => {
    const d = ok(empty(), [
      { op: "type.defineStruct", scope: { kind: "global" }, id: "ty_c", name: "C", fields: [{ name: "age", type: "int" }] },
      { op: "flow.create", id: "flow_p", name: "P" },
      // Without execution lines every node is checked (on a line, an unused node is not).
      { op: "flow.exec.set", flowId: "flow_p", edges: null },
      { op: "node.add", flowId: "flow_p", id: "n_make", type: "briar.struct.make", position: { x: 0, y: 0 }, config: { typeId: "ty_c" }, values: { age: -1 } },
      { op: "type.field.setType", typeId: "ty_c", field: "age", type: { kind: "primitive", name: "int", constraints: { min: 0 } } },
    ]).doc;
    const r = ok(d, [{ op: "node.clearValue", flowId: "flow_p", nodeId: "n_make", port: "age" }]);
    expect(r.inverse).toEqual([{ op: "node.setValue", flowId: "flow_p", nodeId: "n_make", port: "age", value: -1, restore: true }]);
    expect(err(r.doc, [{ op: "node.setValue", flowId: "flow_p", nodeId: "n_make", port: "age", value: -1 }]).code).toBe("value.invalid");
    const back = applyCommands(r.doc, r.inverse, opts());
    expect(back.ok && back.diagnostics.map((x) => x.code)).toContain("node.invalid_value");
  });
});

describe("editor", () => {
  it("undo/redo, viewport not recorded, listeners", () => {
    const editor = createContextEditor(empty(), opts());
    const kinds: string[] = [];
    editor.subscribe((c) => kinds.push(c.kind));
    expect(editor.undo()).toBeUndefined();
    editor.applyBatch(SECTION_10);
    const built = editor.doc;
    editor.apply({ op: "flow.setViewport", flowId: "flow_p", viewport: { x: 1, y: 2, zoom: 1 } });
    expect(editor.undoStack).toHaveLength(1);
    editor.apply({ op: "node.move", flowId: "flow_p", nodeId: "n_tpl", position: { x: 1, y: 1 } });
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.doc.flows[0]!.nodes.find((n) => n.id === "n_tpl")?.position).toEqual({ x: 420, y: 0 });
    expect(editor.canRedo).toBe(true);
    editor.redo();
    expect(editor.doc.flows[0]!.nodes.find((n) => n.id === "n_tpl")?.position).toEqual({ x: 1, y: 1 });
    editor.undo();
    editor.undo();
    expect(editor.doc.flows).toHaveLength(0);
    editor.redo();
    expect(strip({ ...editor.doc, flows: editor.doc.flows.map((f) => ({ ...f, ui: undefined })) as never })).toEqual(
      strip({ ...built, flows: built.flows.map((f) => ({ ...f, ui: undefined })) as never }),
    );
    expect(kinds).toEqual(["apply", "apply", "apply", "undo", "redo", "undo", "undo", "redo"]);
    expect(editor.doc.revision).toBe(8);
  });
});
