import { describe, expect, it } from "vitest";
import { applyCommand, applyCommands, COMMAND_OPS, CommandError, isCommandOp, type Command } from "@briarflow/authoring";
import { createSequentialIdGenerator, validateContext } from "@briarflow/core";
import { ir, testCatalog } from "@briarflow/testing";
import { KIT, emptyDoc, richDoc } from "./fixtures/docs.js";
import { accept, clock, flowOf, frozen, nodeOf, NOW, options, reject } from "./fixtures/helpers.js";

describe("COMMAND_OPS / isCommandOp", () => {
  it("lists 69 ops in spec order", () => {
    expect(COMMAND_OPS).toHaveLength(69);
    expect(COMMAND_OPS[0]).toBe("context.rename");
    expect(COMMAND_OPS[COMMAND_OPS.length - 1]).toBe("flow.exec.set");
    expect(new Set(COMMAND_OPS).size).toBe(69);
  });
  it("isCommandOp", () => {
    expect(isCommandOp("node.move")).toBe(true);
    expect(isCommandOp("node.teleport")).toBe(false);
    expect(isCommandOp(5)).toBe(false);
  });
});

describe("common payload rules", () => {
  it("unknown op → command.unknown_op naming the op", () => {
    reject(emptyDoc(), [{ op: "node.teleport" } as unknown as Command], "command.unknown_op", {
      message: 'Unknown command "node.teleport". See docs/specs/commands.md for the list.',
    });
  });

  it.each([
    ["a number", 5],
    ["null", null],
    ["a list", []],
    ["an object without op", { name: "x" }],
    ["an object with a non-string op", { op: 3 }],
  ])("%s as a command → command.invalid_payload", (_label, command) => {
    reject(emptyDoc(), [command as unknown as Command], "command.invalid_payload");
  });

  it("non-boolean restore → command.invalid_payload", () => {
    reject(emptyDoc(), [{ op: "context.rename", name: "X", restore: "yes" } as unknown as Command], "command.invalid_payload", {
      message: /^Command context\.rename: restore .+\.$/,
    });
  });

  it("restore: false and true are accepted on any command", () => {
    accept(emptyDoc(), [{ op: "context.rename", name: "X", restore: false }]);
    accept(emptyDoc(), [{ op: "context.rename", name: "X", restore: true }]);
  });

  it("wrong JSON type on a nested field → command.invalid_payload", () => {
    reject(
      richDoc(),
      [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: "1", y: 2 } } as unknown as Command],
      "command.invalid_payload",
      { message: /^Command node\.move: position.* .+\.$/ },
    );
  });
});

describe("batch atomicity", () => {
  it("a rejection at index k returns k and leaves the document untouched", () => {
    const doc = richDoc();
    const error = reject(
      doc,
      [
        { op: "context.rename", name: "Changed" },
        { op: "flow.create", id: "flow_new", name: "New" },
        { op: "flow.rename", flowId: "flow_nope", name: "X" },
        { op: "context.rename", name: "Never" },
      ],
      "command.unknown_ref",
      { index: 2 },
    );
    expect(error.commandIndex).toBe(2);
    expect(error.op).toBe("flow.rename");
    expect((error.details as Record<string, unknown>).kind).toBe("flow");
    expect((error.details as Record<string, unknown>).id).toBe("flow_nope");
  });

  it("CommandError.at relocates an error", () => {
    const e = new CommandError("command.unknown_ref", "m", { details: { kind: "flow", id: "x" }, commandIndex: 0, op: "a" });
    const moved = e.at(3, "flow.rename");
    expect(moved.commandIndex).toBe(3);
    expect(moved.details).toEqual({ kind: "flow", id: "x", commandIndex: 3, op: "flow.rename" });
  });

  it("applyCommand reports commandIndex 0", () => {
    const r = applyCommand(frozen(emptyDoc()), { op: "flow.rename", flowId: "flow_x", name: "Y" }, options());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.commandIndex).toBe(0);
      expect((r.error.details as Record<string, unknown>).commandIndex).toBe(0);
      expect(r.error.op).toBe("flow.rename");
    }
  });

  it("later commands see earlier ones (create a flow, then add nodes to it)", () => {
    const r = accept(emptyDoc(), [
      { op: "flow.create", id: "flow_a", name: "A" },
      { op: "node.add", flowId: "flow_a", id: "n_s", type: "kit.textSource", position: { x: 0, y: 0 } },
      { op: "node.add", flowId: "flow_a", id: "n_t", type: "kit.sinkText", position: { x: 1, y: 0 } },
      { op: "edge.connect", flowId: "flow_a", id: "e_a", from: { node: "n_s", port: "text" }, to: { node: "n_t", port: "value" } },
    ]);
    expect(flowOf(r.doc, "flow_a").edges).toEqual([{ id: "e_a", from: { node: "n_s", port: "text" }, to: { node: "n_t", port: "value" } }]);
    expect(r.created[1]).toEqual({ nodeId: "n_s" });
  });

  it("an empty batch is unchanged", () => {
    const doc = frozen(richDoc());
    const r = applyCommands(doc, [], options());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.changed).toBe(false);
      expect(r.doc).toBe(doc);
      expect(r.created).toEqual([]);
    }
  });
});

describe("no-op batches", () => {
  const cases: [string, Command[]][] = [
    ["node.move to the same position", [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 100, y: 600 } }]],
    ["edge.connect of an existing edge", [{ op: "edge.connect", flowId: KIT, from: { node: "n_src", port: "text" }, to: { node: "n_sink", port: "value" } }]],
    ["flow.rename to the same name", [{ op: "flow.rename", flowId: KIT, name: "Kit" }]],
    ["type.rename to the same name", [{ op: "type.rename", typeId: "ty_char", name: "Character" }]],
    ["global.rename to the same name", [{ op: "global.rename", globalId: "gv_count", name: "count" }]],
    ["node.clearValue without a value", [{ op: "node.clearValue", flowId: KIT, nodeId: "n_sink", port: "value" }]],
    ["type.moveScope to the same scope", [{ op: "type.moveScope", typeId: "ty_unused", to: { kind: "global" } }]],
    ["rename and rename back", [
      { op: "flow.rename", flowId: KIT, name: "Other" },
      { op: "flow.rename", flowId: KIT, name: "Kit" },
    ]],
  ];
  it.each(cases)("%s → changed: false, same revision, input object returned, inverse []", (_label, batch) => {
    const doc = frozen(richDoc());
    const r = applyCommands(doc, batch, options());
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.doc).toBe(doc);
    expect(r.doc.revision).toBe(1);
    expect(r.doc.updatedAt).toBe(doc.updatedAt);
    expect(r.inverse).toEqual([]);
    expect(r.resolved).toHaveLength(batch.length);
    expect(r.created).toHaveLength(batch.length);
  });

  it("edge.connect of an existing edge reports its id", () => {
    const r = accept(richDoc(), [{ op: "edge.connect", flowId: KIT, from: { node: "n_src", port: "text" }, to: { node: "n_sink", port: "value" } }]);
    expect(r.created[0]!.edgeId).toBe("e_2");
  });
});

describe("revision and updatedAt", () => {
  it("a changed batch bumps the revision exactly once and sets updatedAt from the clock", () => {
    const r = accept(richDoc(), [
      { op: "context.rename", name: "A" },
      { op: "context.rename", name: "B" },
      { op: "flow.rename", flowId: KIT, name: "K" },
    ]);
    expect(r.doc.revision).toBe(2);
    expect(r.doc.updatedAt).toBe(NOW);
    expect(r.doc.createdAt).toBe(richDoc().createdAt);
  });

  it("uses the injected clock on every batch", () => {
    let t = Date.parse("2026-05-05T00:00:00.000Z");
    const ticking = () => new Date((t += 1000));
    const o = options({ clock: ticking });
    const a = applyCommands(richDoc(), [{ op: "context.rename", name: "A" }], o);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = applyCommands(a.doc, [{ op: "context.rename", name: "B" }], o);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(a.doc.updatedAt).toBe("2026-05-05T00:00:01.000Z");
    expect(b.doc.updatedAt).toBe("2026-05-05T00:00:02.000Z");
    expect(b.doc.revision).toBe(3);
  });

  it("diagnostics are the full validateContext output", () => {
    const r = accept(richDoc(), [{ op: "context.rename", name: "A" }]);
    expect(r.diagnostics).toEqual(validateContext(r.doc, testCatalog()));
    expect(r.diagnostics.length).toBeGreaterThan(0); // richDoc has warnings (variable.unused, …)
  });
});

describe("ids", () => {
  it("generated ids come from the injected generator and appear in resolved", () => {
    const prefixes: string[] = [];
    const seq = createSequentialIdGenerator();
    const gen = (p: string) => {
      prefixes.push(p);
      return seq(p);
    };
    const r = accept(emptyDoc(), [{ op: "flow.create", name: "A" }], { opts: options({ idGenerator: gen }) });
    const created = r.created[0]!;
    expect(created.flowId).toBe("flow_1");
    expect(prefixes).toContain("flow");
    expect(prefixes.filter((p) => p === "n")).toHaveLength(2);
    expect([created.inputNodeId, created.outputNodeId].sort()).toEqual(["n_1", "n_2"]);
    expect(r.resolved[0]).toMatchObject({ op: "flow.create", name: "A", id: "flow_1", inputNodeId: created.inputNodeId, outputNodeId: created.outputNodeId });
    expect(r.doc.flows[0]!.id).toBe("flow_1");
  });

  it("a generated id already used in its domain is skipped (generator called again)", () => {
    // flow_k already has e_1 … e_4; a sequential generator starts at e_1
    const r = accept(richDoc(), [
      { op: "node.add", flowId: KIT, id: "n_t2", type: "kit.sinkText", position: { x: 0, y: 0 } },
      { op: "edge.connect", flowId: KIT, from: { node: "n_src", port: "text" }, to: { node: "n_t2", port: "value" } },
    ]);
    const id = r.created[1]!.edgeId!;
    expect(id).toMatch(/^e_/);
    expect(["e_1", "e_2", "e_3", "e_4"]).not.toContain(id);
    expect(r.resolved[1]).toMatchObject({ id });
  });

  it("sequential generator yields n_1 for the first node", () => {
    const r = accept(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.textSource", position: { x: 0, y: 0 } }]);
    expect(r.created[0]!.nodeId).toBe("n_1");
  });

  it("resolved keeps restore as given and fills nothing else in", () => {
    const r = accept(richDoc(), [
      { op: "context.rename", name: "A" },
      { op: "context.rename", name: "B", restore: true },
    ]);
    expect(r.resolved[0]).toEqual({ op: "context.rename", name: "A" });
    expect(r.resolved[1]).toEqual({ op: "context.rename", name: "B", restore: true });
  });

  it("resolved replaces shorthand types with IR", () => {
    const r = accept(richDoc(), [
      { op: "global.create", id: "gv_list", name: "names", type: "list<Character?>", access: "readwrite" },
      { op: "type.defineStruct", scope: { kind: "global" }, id: "ty_x", name: "X", fields: [{ name: "a", type: "text?" }] },
      { op: "node.add", flowId: KIT, id: "n_k", type: "briar.constant", position: { x: 0, y: 0 }, config: { type: "int" } },
    ]);
    expect(r.resolved[0]).toMatchObject({ type: ir.list(ir.optional(ir.named("ty_char"))) });
    expect(r.resolved[1]).toMatchObject({ fields: [{ name: "a", type: ir.optional(ir.text()) }] });
    expect(r.resolved[2]).toMatchObject({ config: { type: ir.int() } });
    expect(nodeOf(r.doc, KIT, "n_k")!.config).toEqual({ type: ir.int() });
  });

  it("default options work (random ids, real clock)", () => {
    const r = applyCommands(emptyDoc(), [{ op: "flow.create", name: "A" }], { catalog: testCatalog() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.created[0]!.flowId).toMatch(/^flow_[A-Za-z0-9_-]+$/);
      expect(Number.isNaN(Date.parse(r.doc.updatedAt))).toBe(false);
    }
    void clock;
  });
});

describe("immutability and structural sharing", () => {
  it("never mutates a deep-frozen input and shares untouched flows", () => {
    const doc = frozen(richDoc());
    const r = applyCommands(doc, [{ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 1, y: 2 } }], options());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).not.toBe(doc);
    expect(r.doc.flows[0]).toBe(doc.flows[0]); // flow_p untouched
    expect(r.doc.types).toBe(doc.types);
    expect(nodeOf(doc, KIT, "n_src")!.position).toEqual({ x: 100, y: 600 });
  });
});
