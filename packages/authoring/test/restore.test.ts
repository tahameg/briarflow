/**
 * `restore: true` (commands.md §1.1a): value / type / visibility / access checks become
 * diagnostics; structural checks still reject.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { ir } from "@briarflow/testing";
import { KIT, richDoc } from "./fixtures/docs.js";
import { accept, build, diags, expectUndoRoundTrip, nodeOf, reject } from "./fixtures/helpers.js";

const at = { x: 0, y: 0 };
const R = <C extends Command>(c: C): C => ({ ...c, restore: true });

interface SoftCase {
  name: string;
  setup?: Command[];
  command: Command;
  normalCode: string;
  diagnostic: string;
}

const softCases: SoftCase[] = [
  {
    name: "value.invalid on node.setValue → node.invalid_value",
    command: { op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: 11 },
    normalCode: "value.invalid",
    diagnostic: "node.invalid_value",
  },
  {
    name: "value.invalid on node.add values → node.invalid_value",
    command: { op: "node.add", flowId: KIT, id: "n_x", type: "kit.sinkText", position: at, values: { value: 5 } },
    normalCode: "value.invalid",
    diagnostic: "node.invalid_value",
  },
  {
    name: "media.* on a constant → node.invalid_value",
    command: { op: "node.add", flowId: KIT, id: "n_x", type: "briar.constant", position: at, config: { type: "image" }, values: { value: { uri: "ftp://x", mime: "image/png" } } },
    normalCode: "media.invalid_ref",
    diagnostic: "node.invalid_value",
  },
  {
    name: "type.invalid_default on type.field.setDefault",
    command: { op: "type.field.setDefault", typeId: "ty_char", field: "age", value: -1 },
    normalCode: "type.invalid_default",
    diagnostic: "type.invalid_default",
  },
  {
    name: "type.invalid_default on type.field.add",
    command: { op: "type.field.add", typeId: "ty_char", name: "rank", type: "int", default: "x" },
    normalCode: "type.invalid_default",
    diagnostic: "type.invalid_default",
  },
  {
    name: "type.invalid_default on flow.input.setDefault",
    command: { op: "flow.input.setDefault", flowId: KIT, name: "topic", value: 3 },
    normalCode: "type.invalid_default",
    diagnostic: "type.invalid_default",
  },
  {
    name: "value.invalid on global.setValue → global.invalid_value",
    command: { op: "global.setValue", globalId: "gv_count", value: "x" },
    normalCode: "value.invalid",
    diagnostic: "global.invalid_value",
  },
  {
    name: "value.invalid on global.create → global.invalid_value",
    command: { op: "global.create", id: "gv_x", name: "x", type: "int", access: "readwrite", value: "x" },
    normalCode: "value.invalid",
    diagnostic: "global.invalid_value",
  },
  {
    name: "value.invalid on flow.variable.setDefault → variable.invalid_default",
    command: { op: "flow.variable.setDefault", flowId: KIT, variableId: "var_n", value: "x" },
    normalCode: "value.invalid",
    diagnostic: "variable.invalid_default",
  },
  {
    name: "value.invalid on flow.variable.create → variable.invalid_default",
    command: { op: "flow.variable.create", flowId: KIT, id: "var_x", name: "x", type: "int", access: "private", default: [] },
    normalCode: "value.invalid",
    diagnostic: "variable.invalid_default",
  },
  {
    name: "edge.type_mismatch",
    setup: [{ op: "node.add", flowId: KIT, id: "n_int", type: "kit.intSource", position: at }],
    command: { op: "edge.connect", flowId: KIT, id: "e_x", from: { node: "n_int", port: "value" }, to: { node: "n_pass", port: "value" } },
    normalCode: "edge.type_mismatch",
    diagnostic: "edge.type_mismatch",
  },
  {
    name: "edge.generic_conflict → node.generic_conflict",
    setup: [{ op: "node.add", flowId: KIT, id: "n_int", type: "kit.intSource", position: at }],
    command: { op: "edge.connect", flowId: KIT, id: "e_x", from: { node: "n_int", port: "value" }, to: { node: "n_same", port: "b" } },
    normalCode: "edge.generic_conflict",
    diagnostic: "node.generic_conflict",
  },
  {
    name: "visibility.local_type_in_global (global.create)",
    command: { op: "global.create", id: "gv_m", name: "m", type: ir.named("ty_mood"), access: "readwrite" },
    normalCode: "visibility.local_type_in_global",
    diagnostic: "visibility.local_type_in_global",
  },
  {
    name: "visibility.local_type_in_global (type.field.add)",
    command: { op: "type.field.add", typeId: "ty_char", name: "m", type: ir.optional(ir.named("ty_mood")) },
    normalCode: "visibility.local_type_in_global",
    diagnostic: "visibility.local_type_in_global",
  },
  {
    name: "visibility.local_type_in_public_signature",
    command: { op: "flow.input.add", flowId: KIT, name: "m", type: "Mood" },
    normalCode: "visibility.local_type_in_public_signature",
    diagnostic: "visibility.local_type_in_public_signature",
  },
  {
    name: "visibility.local_type_in_public_variable",
    command: { op: "flow.variable.setAccess", flowId: KIT, variableId: "var_mood", access: "public" },
    normalCode: "visibility.local_type_in_public_variable",
    diagnostic: "visibility.local_type_in_public_variable",
  },
  {
    name: "variable.write_to_readonly",
    command: { op: "node.add", flowId: KIT, id: "n_w", type: "briar.global.set", position: at, config: { globalId: "gv_brand" } },
    normalCode: "variable.write_to_readonly",
    diagnostic: "variable.write_to_readonly",
  },
];

describe("restore: true downgrades value/type/visibility/access checks", () => {
  it.each(softCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const doc = build(richDoc(), c.setup ?? []);
    reject(doc, [c.command], c.normalCode);
    const r = accept(doc, [R(c.command)]);
    expect(diags(r.diagnostics, c.diagnostic).length, `diagnostic ${c.diagnostic} expected`).toBeGreaterThan(0);
    expect(r.resolved[0]!.restore).toBe(true);
  });

  it("value.generic_unbound with restore is accepted and the value stored", () => {
    const cmd: Command = { op: "node.add", flowId: KIT, id: "n_g", type: "kit.same", position: at, values: { a: 1 } };
    reject(richDoc(), [cmd], "value.generic_unbound");
    const r = accept(richDoc(), [R(cmd)]);
    expect(nodeOf(r.doc, KIT, "n_g")!.values).toEqual({ a: 1 });
  });

  it("the effect is identical with and without restore", () => {
    const cmd: Command = { op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "value", value: 7 };
    const a = accept(richDoc(), [cmd]);
    const b = accept(richDoc(), [R(cmd)]);
    expect(b.doc).toEqual(a.doc);
  });
});

const structural: [string, Command[], string][] = [
  ["command.invalid_payload", [{ op: "context.rename", name: "" }], "command.invalid_payload"],
  ["command.unknown_op", [{ op: "node.teleport" } as unknown as Command], "command.unknown_op"],
  ["command.unknown_ref", [{ op: "node.remove", flowId: KIT, nodeId: "n_x" }], "command.unknown_ref"],
  ["node.unknown_type", [{ op: "node.add", flowId: KIT, type: "x.y", position: at }], "node.unknown_type"],
  ["config.unknown_ref", [{ op: "node.add", flowId: KIT, type: "briar.variable.get", position: at, config: { variableId: "var_x" } }], "config.unknown_ref"],
  ["config.invalid", [{ op: "node.add", flowId: KIT, type: "kit.configured", position: at, config: { count: 9 } }], "config.invalid"],
  ["command.invalid_id", [{ op: "flow.create", id: "x", name: "X" }], "command.invalid_id"],
  ["command.duplicate_id", [{ op: "flow.create", id: "flow_k", name: "X" }], "command.duplicate_id"],
  ["command.invalid_name", [{ op: "global.create", name: "a b", type: "int", access: "readwrite" }], "command.invalid_name"],
  ["command.duplicate_name", [{ op: "global.create", name: "COUNT", type: "int", access: "readwrite" }], "command.duplicate_name"],
  ["command.reserved_name", [{ op: "global.create", name: "constructor", type: "int", access: "readwrite" }], "command.reserved_name"],
  ["type.invalid_name", [{ op: "type.defineEnum", scope: { kind: "global" }, name: "lower" }], "type.invalid_name"],
  ["type.reserved_name", [{ op: "type.defineEnum", scope: { kind: "global" }, name: "List" }], "type.reserved_name"],
  ["type.duplicate_name", [{ op: "type.defineEnum", scope: { kind: "global" }, name: "ARTSTYLE" }], "type.duplicate_name"],
  ["type.recursive", [{ op: "type.field.add", typeId: "ty_char", name: "me", type: "Character?" }], "type.recursive"],
  ["type.invalid_constraint", [{ op: "type.field.add", typeId: "ty_char", name: "l", type: "list<text>[4..1]" }], "type.invalid_constraint"],
  ["type.duplicate_member", [{ op: "type.enum.addMember", typeId: "ty_style", value: "ANIME" }], "type.duplicate_member"],
  ["type.in_use", [{ op: "type.delete", typeId: "ty_style" }], "type.in_use"],
  ["global.in_use", [{ op: "global.delete", globalId: "gv_brand" }], "global.in_use"],
  ["variable.in_use", [{ op: "flow.variable.delete", flowId: KIT, variableId: "var_n" }], "variable.in_use"],
  ["global.readonly_requires_value", [{ op: "global.clearValue", globalId: "gv_brand" }], "global.readonly_requires_value"],
  ["node.unknown_port", [{ op: "node.setValue", flowId: KIT, nodeId: "n_c", port: "nope", value: 1 }], "node.unknown_port"],
  ["edge.unknown_port", [{ op: "edge.connect", flowId: KIT, from: { node: "n_src", port: "nope" }, to: { node: "n_pass", port: "value" } }], "edge.unknown_port"],
  ["edge.wrong_direction", [{ op: "edge.connect", flowId: KIT, from: { node: "n_sink", port: "value" }, to: { node: "n_pass", port: "value" } }], "edge.wrong_direction"],
  ["edge.self_loop", [{ op: "edge.connect", flowId: KIT, from: { node: "n_pass", port: "value" }, to: { node: "n_pass", port: "value" } }], "edge.self_loop"],
  ["node.builtin_singleton", [{ op: "node.add", flowId: KIT, type: "briar.input", position: at }], "node.builtin_singleton"],
  ["node.builtin_protected", [{ op: "node.remove", flowId: KIT, nodeId: "n_out" }], "node.builtin_protected"],
];

describe("restore: true does not relax structural checks", () => {
  it.each(structural)("%s still rejects", (_label, batch, code) => {
    reject(richDoc(), batch.map((c) => ({ ...c, restore: true }) as Command), code);
  });

  it("edge.cycle still rejects", () => {
    const d = build(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_p1", type: "kit.passText", position: at },
      { op: "node.add", flowId: KIT, id: "n_p2", type: "kit.passText", position: at },
      { op: "edge.connect", flowId: KIT, from: { node: "n_p1", port: "value" }, to: { node: "n_p2", port: "value" } },
    ]);
    reject(d, [{ op: "edge.connect", flowId: KIT, from: { node: "n_p2", port: "value" }, to: { node: "n_p1", port: "value" }, restore: true }], "edge.cycle");
  });
});

describe("commands.md §1.1a example", () => {
  it("narrowing a field, clearing the soft-broken constant and undoing restores it with its diagnostic", () => {
    // Character.age is int (no min) and n_make.age = -1 …
    const start = build(richDoc(), [
      { op: "type.field.setType", typeId: "ty_char", field: "age", type: "int" },
      { op: "type.field.clearDefault", typeId: "ty_char", field: "age" },
      { op: "node.setValue", flowId: KIT, nodeId: "n_make", port: "age", value: -1 },
    ]);
    // … the user narrows age to int{min:0} (soft breakage)
    const narrowed = accept(start, [{ op: "type.field.setType", typeId: "ty_char", field: "age", type: ir.int({ min: 0 }) }]);
    expect(diags(narrowed.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_make" && d.path.port === "age")).toBe(true);
    // … deletes the constant
    const cleared = accept(narrowed.doc, [{ op: "node.clearValue", flowId: KIT, nodeId: "n_make", port: "age" }]);
    expect(diags(cleared.diagnostics, "node.invalid_value").some((d) => d.path.nodeId === "n_make")).toBe(false);
    expect(cleared.inverse).toEqual([{ op: "node.setValue", flowId: KIT, nodeId: "n_make", port: "age", value: -1, restore: true }]);
    // … and presses undo
    const undone = expectUndoRoundTrip(narrowed.doc, cleared);
    expect(nodeOf(undone, KIT, "n_make")!.values!.age).toBe(-1);
    // without restore the same command rejects
    reject(cleared.doc, [{ op: "node.setValue", flowId: KIT, nodeId: "n_make", port: "age", value: -1 }], "value.invalid");
  });
});
