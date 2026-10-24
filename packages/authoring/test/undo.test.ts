/**
 * Generic undo / redo invariants over a corpus that covers every op (phase-2.md §5.1):
 * apply → undo (inverse) gives back the original (jsonEquals, minus revision/updatedAt) and
 * redo gives back the post-apply document — both through applyCommands and through the editor.
 */
import { describe, expect, it } from "vitest";
import { applyCommands, COMMAND_OPS, createContextEditor, type Command } from "@briarflow/authoring";
import { jsonEquals, type ContextDocument } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { KIT, PORTRAIT, SECTION_10_BATCH, emptyDoc, richDoc } from "./fixtures/docs.js";
import { accept, build, frozen, options, strip } from "./fixtures/helpers.js";

const G = { kind: "global" } as const;
const F = { kind: "flow", flowId: KIT } as const;
const at = { x: 5, y: 6 };

interface Case {
  name: string;
  doc?: () => ContextDocument;
  batch: Command[];
}

const withLines = () => build(richDoc(), [{ op: "flow.exec.enable", flowId: KIT }]);

const withTone = () =>
  build(richDoc(), [
    { op: "type.defineEnum", scope: G, id: "ty_tone", name: "Tone", members: ["soft"] },
    { op: "flow.input.add", flowId: KIT, name: "b", type: "text", default: "x", description: "B" },
    { op: "flow.output.add", flowId: KIT, name: "o2", type: "text", description: "O" },
    { op: "node.setValue", flowId: KIT, nodeId: "n_out", port: "summary", value: "fb" },
  ]);

const CORPUS: Case[] = [
  { name: "context.rename", batch: [{ op: "context.rename", name: "Renamed" }] },
  { name: "context.setDescription set", batch: [{ op: "context.setDescription", description: "D" }] },
  { name: "context.setDescription clear", doc: () => build(richDoc(), [{ op: "context.setDescription", description: "D" }]), batch: [{ op: "context.setDescription", description: null }] },
  { name: "type.defineStruct global", batch: [{ op: "type.defineStruct", scope: G, name: "Scene", fields: [{ name: "c", type: "Character", default: { name: "x", style: "anime" } }] }] },
  { name: "type.defineStruct local", batch: [{ op: "type.defineStruct", scope: F, name: "Box", fields: [{ name: "m", type: "list<Mood>" }] }] },
  { name: "type.defineEnum", batch: [{ op: "type.defineEnum", scope: F, name: "Size", members: ["s", { value: "m", label: "Medium" }] }] },
  { name: "type.rename", batch: [{ op: "type.rename", typeId: "ty_char", name: "Persona" }] },
  { name: "type.setDescription", batch: [{ op: "type.setDescription", typeId: "ty_style", description: "Look" }] },
  { name: "type.delete global (middle position)", batch: [{ op: "type.delete", typeId: "ty_team" }] },
  { name: "type.delete global (last position)", batch: [{ op: "type.delete", typeId: "ty_unused" }] },
  {
    name: "type.delete local",
    doc: () => build(richDoc(), [{ op: "type.defineEnum", scope: F, id: "ty_tmp", name: "Tmp", members: ["x"] }, { op: "type.moveScope", typeId: "ty_unused", to: F }]),
    batch: [{ op: "type.delete", typeId: "ty_tmp" }],
  },
  { name: "type.moveScope global→flow", batch: [{ op: "type.moveScope", typeId: "ty_unused", to: F }] },
  { name: "type.moveScope flow→global (first of two)", batch: [{ op: "type.moveScope", typeId: "ty_mood", to: G }] },
  { name: "type.field.add", batch: [{ op: "type.field.add", typeId: "ty_char", name: "title", type: "text", default: "Sir", index: 0 }] },
  { name: "type.field.add required (soft)", batch: [{ op: "type.field.add", typeId: "ty_char", name: "power", type: "int" }] },
  { name: "type.field.remove (edge + constant cleanup)", batch: [{ op: "type.field.remove", typeId: "ty_char", field: "name" }] },
  { name: "type.field.remove with default", batch: [{ op: "type.field.remove", typeId: "ty_char", field: "age" }] },
  { name: "type.field.rename (value rewriting)", batch: [{ op: "type.field.rename", typeId: "ty_char", field: "name", name: "fullName" }] },
  { name: "type.field.setType (soft)", batch: [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: "text" }] },
  { name: "type.field.setType style→int (e_3 re-binds)", batch: [{ op: "type.field.setType", typeId: "ty_char", field: "style", type: "int" }] },
  { name: "type.field.reorder", batch: [{ op: "type.field.reorder", typeId: "ty_char", field: "nickname", index: 0 }] },
  { name: "type.field.setDescription", batch: [{ op: "type.field.setDescription", typeId: "ty_char", field: "age", description: "Years" }] },
  { name: "type.field.setDefault", batch: [{ op: "type.field.setDefault", typeId: "ty_char", field: "age", value: 41 }] },
  { name: "type.field.setDefault new", batch: [{ op: "type.field.setDefault", typeId: "ty_char", field: "name", value: "N" }] },
  { name: "type.field.clearDefault", batch: [{ op: "type.field.clearDefault", typeId: "ty_char", field: "age" }] },
  { name: "type.enum.addMember", batch: [{ op: "type.enum.addMember", typeId: "ty_style", value: "sketch", label: "Sketch", index: 0 }] },
  { name: "type.enum.removeMember (soft)", batch: [{ op: "type.enum.removeMember", typeId: "ty_style", value: "anime" }] },
  { name: "type.enum.removeMember with label", batch: [{ op: "type.enum.removeMember", typeId: "ty_style", value: "pixel" }] },
  { name: "type.enum.renameMember", batch: [{ op: "type.enum.renameMember", typeId: "ty_style", value: "anime", newValue: "manga" }] },
  { name: "type.enum.renameMember local", batch: [{ op: "type.enum.renameMember", typeId: "ty_mood", value: "calm", newValue: "serene" }] },
  { name: "type.enum.setMemberLabel", batch: [{ op: "type.enum.setMemberLabel", typeId: "ty_style", value: "anime", label: null }] },
  { name: "global.create", batch: [{ op: "global.create", name: "tags", type: "list<text>", access: "readonly", value: ["a"], description: "T" }] },
  { name: "global.rename", batch: [{ op: "global.rename", globalId: "gv_count", name: "total" }] },
  { name: "global.setType (soft)", batch: [{ op: "global.setType", globalId: "gv_count", type: "text" }] },
  { name: "global.setAccess", batch: [{ op: "global.setAccess", globalId: "gv_count", access: "readonly" }] },
  { name: "global.setValue", batch: [{ op: "global.setValue", globalId: "gv_hero", value: { name: "Z", age: 3, style: "pixel", nickname: "zz" } }] },
  { name: "global.setValue (first value)", batch: [{ op: "global.setValue", globalId: "gv_spare", value: "x" }] },
  { name: "global.clearValue", batch: [{ op: "global.clearValue", globalId: "gv_count" }] },
  { name: "global.setDescription", batch: [{ op: "global.setDescription", globalId: "gv_count", description: "N" }] },
  { name: "global.delete", batch: [{ op: "global.delete", globalId: "gv_hero" }] },
  { name: "global.delete cascade", batch: [{ op: "global.delete", globalId: "gv_brand", cascade: true }] },
  { name: "flow.create", batch: [{ op: "flow.create", name: "New", description: "D" }] },
  { name: "flow.rename", batch: [{ op: "flow.rename", flowId: KIT, name: "Toolkit" }] },
  { name: "flow.setDescription", batch: [{ op: "flow.setDescription", flowId: KIT, description: "D" }] },
  { name: "flow.duplicate", batch: [{ op: "flow.duplicate", flowId: KIT }] },
  { name: "flow.duplicate with typeIds", batch: [{ op: "flow.duplicate", flowId: KIT, id: "flow_k2", name: "K2", typeIds: { ty_mood: "ty_m2", ty_pair: "ty_p2" } }] },
  { name: "flow.delete first", batch: [{ op: "flow.delete", flowId: PORTRAIT }] },
  { name: "flow.delete last", batch: [{ op: "flow.delete", flowId: KIT }] },
  { name: "flow.input.add", batch: [{ op: "flow.input.add", flowId: KIT, name: "extra", type: "int", default: 1, description: "E", index: 0 }] },
  { name: "flow.input.remove", batch: [{ op: "flow.input.remove", flowId: KIT, name: "topic" }] },
  { name: "flow.input.remove (middle)", doc: withTone, batch: [{ op: "flow.input.remove", flowId: KIT, name: "topic" }] },
  { name: "flow.input.rename", batch: [{ op: "flow.input.rename", flowId: KIT, name: "topic", newName: "subject" }] },
  { name: "flow.input.setType", batch: [{ op: "flow.input.setType", flowId: KIT, name: "topic", type: "int" }] },
  { name: "flow.input.reorder", doc: withTone, batch: [{ op: "flow.input.reorder", flowId: KIT, name: "b", index: 0 }] },
  { name: "flow.input.setDescription", batch: [{ op: "flow.input.setDescription", flowId: KIT, name: "topic", description: "T" }] },
  { name: "flow.input.setDefault", batch: [{ op: "flow.input.setDefault", flowId: KIT, name: "topic", value: "dogs" }] },
  { name: "flow.input.clearDefault", batch: [{ op: "flow.input.clearDefault", flowId: KIT, name: "topic" }] },
  { name: "flow.output.add", batch: [{ op: "flow.output.add", flowId: KIT, name: "count", type: "int", index: 0 }] },
  { name: "flow.output.remove (edge + constant)", doc: withTone, batch: [{ op: "flow.output.remove", flowId: KIT, name: "summary" }] },
  { name: "flow.output.rename (edge + constant key)", doc: withTone, batch: [{ op: "flow.output.rename", flowId: KIT, name: "summary", newName: "result" }] },
  { name: "flow.output.setType", batch: [{ op: "flow.output.setType", flowId: KIT, name: "summary", type: "image" }] },
  { name: "flow.output.reorder", doc: withTone, batch: [{ op: "flow.output.reorder", flowId: KIT, name: "o2", index: 0 }] },
  { name: "flow.output.setDescription", doc: withTone, batch: [{ op: "flow.output.setDescription", flowId: KIT, name: "o2", description: null }] },
  { name: "flow.variable.create", batch: [{ op: "flow.variable.create", flowId: KIT, name: "feel", type: "Mood", access: "private", default: "angry", description: "F" }] },
  { name: "flow.variable.rename", batch: [{ op: "flow.variable.rename", flowId: KIT, variableId: "var_n", name: "counter" }] },
  { name: "flow.variable.setType", batch: [{ op: "flow.variable.setType", flowId: KIT, variableId: "var_n", type: "text" }] },
  { name: "flow.variable.setAccess", batch: [{ op: "flow.variable.setAccess", flowId: KIT, variableId: "var_n", access: "public" }] },
  { name: "flow.variable.setDefault", batch: [{ op: "flow.variable.setDefault", flowId: KIT, variableId: "var_n", value: 5 }] },
  { name: "flow.variable.clearDefault", batch: [{ op: "flow.variable.clearDefault", flowId: KIT, variableId: "var_n" }] },
  { name: "flow.variable.setDescription", batch: [{ op: "flow.variable.setDescription", flowId: KIT, variableId: "var_n", description: "C" }] },
  { name: "flow.variable.delete", batch: [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_mood" }] },
  { name: "flow.variable.delete cascade", batch: [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_n", cascade: true }] },
  { name: "node.add", batch: [{ op: "node.add", flowId: KIT, type: "briar.constant", position: at, title: "C", config: { type: "list<Character>" }, values: { value: [] } }] },
  { name: "node.remove (with edges, config, values)", batch: [{ op: "node.remove", flowId: KIT, nodeId: "n_moodc" }] },
  { name: "node.remove generic node", batch: [{ op: "node.remove", flowId: KIT, nodeId: "n_same" }] },
  { name: "node.remove template", doc: richDoc, batch: [{ op: "node.remove", flowId: PORTRAIT, nodeId: "n_tpl" }] },
  { name: "node.move", batch: [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 1.005, y: 2 } }] },
  { name: "node.setTitle", batch: [{ op: "node.setTitle", flowId: KIT, nodeId: "n_src", title: "Src" }] },
  { name: "node.setValue", batch: [{ op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: 9 }] },
  { name: "node.setValue new key", batch: [{ op: "node.setValue", flowId: KIT, nodeId: "n_sink", port: "value", value: "v" }] },
  { name: "node.clearValue", batch: [{ op: "node.clearValue", flowId: KIT, nodeId: "n_c", port: "value" }] },
  { name: "node.clearValue last key", batch: [{ op: "node.clearValue", flowId: KIT, nodeId: "n_cset", port: "value" }] },
  { name: "node.setConfig (vanished port)", batch: [{ op: "node.setConfig", flowId: PORTRAIT, nodeId: "n_tpl", config: { template: "{{style}}!" } }] },
  {
    name: "node.setVariant (vanished port, carried config)",
    batch: [
      { op: "node.add", flowId: KIT, id: "n_sh", type: "kit.shaped", position: at, config: { mode: "a", label: "L" }, values: { extra: 4 } },
      { op: "node.add", flowId: KIT, id: "n_ai", type: "kit.addOne", position: at },
      { op: "edge.connect", flowId: KIT, from: { node: "n_ai", port: "value" }, to: { node: "n_sh", port: "extra" } },
      { op: "node.setVariant", flowId: KIT, nodeId: "n_sh", variant: "number" },
    ],
  },
  { name: "node.setConfig (type change)", batch: [{ op: "node.setConfig", flowId: KIT, nodeId: "n_moodc", config: { type: "int" } }] },
  { name: "edge.connect", batch: [{ op: "node.add", flowId: KIT, id: "n_t2", type: "kit.sinkText", position: at }, { op: "edge.connect", flowId: KIT, from: { node: "n_src", port: "text" }, to: { node: "n_t2", port: "value" } }] },
  { name: "edge.connect replacing", batch: [{ op: "edge.connect", flowId: KIT, from: { node: "n_bgget", port: "value" }, to: { node: "n_sink", port: "value" } }] },
  { name: "edge.connect binds generics", batch: [{ op: "edge.connect", flowId: KIT, from: { node: "n_moodc", port: "value" }, to: { node: "n_same", port: "b" } }] },
  { name: "edge.disconnect by id", batch: [{ op: "edge.disconnect", flowId: KIT, edgeId: "e_4" }] },
  { name: "edge.disconnect by to", batch: [{ op: "edge.disconnect", flowId: KIT, to: { node: "n_out", port: "summary" } }] },
  { name: "§10 batch from empty", doc: emptyDoc, batch: [...SECTION_10_BATCH] },
  { name: "flow.exec.enable", batch: [{ op: "flow.exec.enable", flowId: KIT }] },
  { name: "flow.exec.set", batch: [{ op: "flow.exec.set", flowId: KIT, edges: [{ id: "x_9", from: { node: "n_in", port: "then" }, to: { node: "n_out", port: "in" } }] }] },
  { name: "exec.connect replacing", doc: withLines, batch: [{ op: "exec.connect", flowId: KIT, from: { node: "n_in", port: "then" }, to: { node: "n_sink", port: "in" } }] },
  { name: "exec.disconnect", doc: withLines, batch: [{ op: "exec.disconnect", flowId: KIT, edgeId: "x_1" }] },
  { name: "node.remove takes its execution lines", doc: withLines, batch: [{ op: "node.remove", flowId: KIT, nodeId: "n_sink" }] },
  {
    name: "mixed multi-command batch",
    batch: [
      { op: "flow.create", id: "flow_m", name: "Mixed", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "flow.input.add", flowId: "flow_m", name: "a", type: "Character" },
      { op: "node.add", flowId: "flow_m", id: "n_b", type: "briar.struct.break", position: at, config: { typeId: "ty_char" } },
      { op: "edge.connect", flowId: "flow_m", from: { node: "n_in", port: "a" }, to: { node: "n_b", port: "value" } },
      { op: "type.field.rename", typeId: "ty_char", field: "name", name: "label" },
      { op: "node.remove", flowId: KIT, nodeId: "n_make" },
      { op: "global.delete", globalId: "gv_count", cascade: true },
      { op: "type.field.add", typeId: "ty_char", name: "x", type: ir.optional(ir.int()) },
    ],
  },
  {
    name: "restore commands round-trip too",
    batch: [
      { op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: 99, restore: true },
      { op: "flow.variable.setAccess", flowId: KIT, variableId: "var_mood", access: "public", restore: true },
    ],
  },
];

const VIEWPORT_ONLY: Command[] = [{ op: "flow.setViewport", flowId: KIT, viewport: { x: 1, y: 2, zoom: 3 } }];

describe("undo / redo invariants (applyCommands)", () => {
  it("the corpus covers every op", () => {
    const covered = new Set([...CORPUS.flatMap((c) => c.batch.map((b) => b.op)), ...VIEWPORT_ONLY.map((c) => c.op)]);
    expect(COMMAND_OPS.filter((op) => !covered.has(op))).toEqual([]);
  });

  it.each(CORPUS.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // accept() checks: undo(inverse) == original, redo(resolved) == result, restore on inverse
    const r = accept((c.doc ?? richDoc)(), c.batch);
    expect(r.changed).toBe(true);
    expect(r.inverse.length).toBeGreaterThan(0);
  });

  it("flow.setViewport is not undoable (empty inverse) but is redoable", () => {
    const r = accept(richDoc(), VIEWPORT_ONLY, { noUndo: true });
    expect(r.inverse).toEqual([]);
  });

  it("undo then redo then undo again (chained, revisions keep going up)", () => {
    for (const c of CORPUS.slice(0, 20)) {
      const d0 = frozen((c.doc ?? richDoc)());
      const a = applyCommands(d0, c.batch, options());
      if (!a.ok) throw new Error(`${c.name}: ${a.error.message}`);
      const u = applyCommands(a.doc, a.inverse, options());
      if (!u.ok) throw new Error(`${c.name} undo: ${u.error.message}`);
      const re = applyCommands(u.doc, a.resolved.map((x) => ({ ...x, restore: true }) as Command), options());
      if (!re.ok) throw new Error(`${c.name} redo: ${re.error.message}`);
      const u2 = applyCommands(re.doc, re.inverse, options());
      if (!u2.ok) throw new Error(`${c.name} undo 2: ${u2.error.message}`);
      expect(jsonEquals(strip(u2.doc), strip(d0)), c.name).toBe(true);
      expect(u2.doc.revision).toBe(d0.revision + 4);
    }
  });
});

describe("undo / redo invariants (ContextEditor)", () => {
  it.each(CORPUS.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const d0 = frozen((c.doc ?? richDoc)());
    const editor = createContextEditor(d0, options());
    const a = editor.applyBatch(c.batch);
    expect(a.ok, a.ok ? "" : a.error.message).toBe(true);
    const after = editor.doc;
    const u = editor.undo();
    expect(u?.ok, u && !u.ok ? u.error.message : "").toBe(true);
    expect(jsonEquals(strip(editor.doc), strip(d0))).toBe(true);
    const r = editor.redo();
    expect(r?.ok, r && !r.ok ? r.error.message : "").toBe(true);
    expect(jsonEquals(strip(editor.doc), strip(after))).toBe(true);
    expect(editor.doc.revision).toBe(d0.revision + 3);
    expect(editor.undo()?.ok).toBe(true);
    expect(jsonEquals(strip(editor.doc), strip(d0))).toBe(true);
  });
});
