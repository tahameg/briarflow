import { describe, expect, it, vi } from "vitest";
import { createContextEditor, type Command, type EditorChange } from "@briarflow/authoring";
import { validateContext } from "@briarflow/core";
import { testCatalog } from "@briarflow/testing";
import { KIT, emptyDoc, richDoc } from "./fixtures/docs.js";
import { flowOf, frozen, nodeOf, options, strip } from "./fixtures/helpers.js";

const rename = (name: string): Command => ({ op: "context.rename", name });
const viewport: Command = { op: "flow.setViewport", flowId: KIT, viewport: { x: 1, y: 2, zoom: 2 } };

function editor(doc = richDoc(), extra: { historyLimit?: number } = {}) {
  return createContextEditor(frozen(doc), { ...options(), ...extra });
}

describe("createContextEditor", () => {
  it("starts with the given document, its diagnostics and empty stacks", () => {
    const doc = frozen(richDoc());
    const e = createContextEditor(doc, options());
    expect(e.doc).toBe(doc);
    expect(e.diagnostics).toEqual(validateContext(doc, testCatalog()));
    expect(e.canUndo).toBe(false);
    expect(e.canRedo).toBe(false);
    expect(e.undoStack).toEqual([]);
    expect(e.redoStack).toEqual([]);
    expect(e.undo()).toBeUndefined();
    expect(e.redo()).toBeUndefined();
  });
});

describe("apply / applyBatch", () => {
  it("apply changes doc, records one entry with resolved commands and inverse", () => {
    const e = editor();
    const r = e.apply({ op: "flow.create", name: "New" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created.flowId).toBe("flow_1");
    expect(e.doc).toBe(r.doc);
    expect(e.diagnostics).toEqual(r.diagnostics);
    expect(e.canUndo).toBe(true);
    expect(e.undoStack).toHaveLength(1);
    expect(e.undoStack[0]!.commands).toEqual(r.resolved);
    expect(e.undoStack[0]!.inverse).toEqual(r.inverse);
  });

  it("applyBatch records one entry for the whole batch", () => {
    const e = editor();
    const r = e.applyBatch([rename("A"), rename("B"), { op: "flow.rename", flowId: KIT, name: "K" }]);
    expect(r.ok).toBe(true);
    expect(e.undoStack).toHaveLength(1);
    expect(e.doc.revision).toBe(2);
  });

  it("a failed apply records nothing, keeps doc and the redo stack", () => {
    const e = editor();
    e.apply(rename("A"));
    e.undo();
    const before = e.doc;
    const r = e.applyBatch([rename("B"), { op: "flow.rename", flowId: "flow_x", name: "Y" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.commandIndex).toBe(1);
    expect(e.doc).toBe(before);
    expect(e.undoStack).toHaveLength(0);
    expect(e.redoStack).toHaveLength(1);
  });

  it("an unchanged apply records nothing and keeps the redo stack", () => {
    const e = editor();
    e.apply(rename("A"));
    e.undo();
    const r = e.apply({ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 100, y: 600 } });
    expect(r.ok && r.changed).toBe(false);
    expect(e.undoStack).toHaveLength(0);
    expect(e.canRedo).toBe(true);
  });

  it("a new changed apply clears the redo stack", () => {
    const e = editor();
    e.apply(rename("A"));
    e.undo();
    expect(e.canRedo).toBe(true);
    e.apply(rename("B"));
    expect(e.canRedo).toBe(false);
    expect(e.redoStack).toEqual([]);
  });

  it("a viewport-only batch changes doc/revision, records nothing and keeps the redo stack", () => {
    const e = editor();
    e.apply(rename("A"));
    e.undo();
    const rev = e.doc.revision;
    const r = e.apply(viewport);
    expect(r.ok).toBe(true);
    expect(e.doc.revision).toBe(rev + 1);
    expect(flowOf(e.doc, KIT).ui).toEqual({ viewport: { x: 1, y: 2, zoom: 2 } });
    expect(e.undoStack).toHaveLength(0);
    expect(e.canRedo).toBe(true);
  });

  it("a batch mixing viewport and other commands is recorded (inverse without the viewport)", () => {
    const e = editor();
    e.applyBatch([viewport, rename("A")]);
    expect(e.undoStack).toHaveLength(1);
    expect(e.undoStack[0]!.inverse.map((c) => c.op)).toEqual(["context.rename"]);
  });
});

describe("undo / redo", () => {
  it("undo applies the inverse as a new batch (revision goes up); redo re-applies with restore", () => {
    const e = editor();
    const d0 = e.doc;
    e.apply({ op: "node.remove", flowId: KIT, nodeId: "n_src" });
    const d1 = e.doc;
    const u = e.undo()!;
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(strip(e.doc)).toEqual(strip(d0));
    expect(e.doc.revision).toBe(d0.revision + 2);
    expect(u.resolved.every((c) => c.restore === true)).toBe(true);
    expect(e.canUndo).toBe(false);
    expect(e.canRedo).toBe(true);
    expect(e.redoStack).toHaveLength(1);

    const r = e.redo()!;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(strip(e.doc)).toEqual(strip(d1));
    expect(r.resolved.every((c) => c.restore === true)).toBe(true);
    expect(e.canRedo).toBe(false);
    expect(e.undoStack).toHaveLength(1);
    expect(e.undoStack[0]!.inverse).toEqual(r.inverse);
    expect(nodeOf(e.doc, KIT, "n_src")).toBeUndefined();
  });

  it("multiple steps undo in reverse order", () => {
    const e = editor(emptyDoc());
    e.apply(rename("A"));
    e.apply(rename("B"));
    e.apply(rename("C"));
    e.undo();
    expect(e.doc.name).toBe("B");
    e.undo();
    expect(e.doc.name).toBe("A");
    e.redo();
    expect(e.doc.name).toBe("B");
    e.undo();
    e.undo();
    expect(e.doc.name).toBe("Test");
    expect(e.undo()).toBeUndefined();
    expect(e.redoStack).toHaveLength(3);
  });

  it("undo after a redo restores the generated ids (resolved ids reused)", () => {
    const e = editor(emptyDoc());
    const r = e.apply({ op: "flow.create", name: "A" });
    const id = r.ok ? r.created.flowId : undefined;
    e.undo();
    e.redo();
    expect(e.doc.flows.map((f) => f.id)).toEqual([id]);
  });

  it("historyLimit drops the oldest entries", () => {
    const e = editor(emptyDoc(), { historyLimit: 2 });
    e.apply(rename("A"));
    e.apply(rename("B"));
    e.apply(rename("C"));
    expect(e.undoStack).toHaveLength(2);
    expect(e.undoStack[0]!.commands).toEqual([rename("B")]);
    e.undo();
    e.undo();
    expect(e.doc.name).toBe("A");
    expect(e.canUndo).toBe(false);
  });

  it("default history depth is 200", () => {
    const e = editor(emptyDoc());
    for (let i = 0; i < 205; i++) e.apply(rename(`N${i}`));
    expect(e.undoStack).toHaveLength(200);
  });
});

describe("reset / clearHistory", () => {
  it("reset replaces the document, clears history and notifies 'reset'", () => {
    const e = editor();
    e.apply(rename("A"));
    const changes: EditorChange[] = [];
    e.subscribe((c) => changes.push(c));
    const fresh = frozen(emptyDoc());
    e.reset(fresh);
    expect(e.doc).toBe(fresh);
    expect(e.undoStack).toEqual([]);
    expect(e.redoStack).toEqual([]);
    expect(e.diagnostics).toEqual(validateContext(fresh, testCatalog()));
    expect(changes).toHaveLength(1);
    expect(changes[0]!.kind).toBe("reset");
    expect(changes[0]!.doc).toBe(fresh);
    expect(changes[0]!.result).toBeUndefined();
  });

  it("clearHistory keeps the document", () => {
    const e = editor();
    e.apply(rename("A"));
    e.apply(rename("B"));
    e.undo();
    const doc = e.doc;
    e.clearHistory();
    expect(e.doc).toBe(doc);
    expect(e.canUndo).toBe(false);
    expect(e.canRedo).toBe(false);
  });
});

describe("subscribe", () => {
  it("listeners run synchronously after apply / undo / redo with changed: true", () => {
    const e = editor();
    const seen: [string, number][] = [];
    e.subscribe((c) => {
      expect(c.doc).toBe(e.doc);
      seen.push([c.kind, c.doc.revision]);
      expect(c.result?.ok).toBe(true);
    });
    e.apply(rename("A"));
    e.undo();
    e.redo();
    expect(seen).toEqual([
      ["apply", 2],
      ["undo", 3],
      ["redo", 4],
    ]);
  });

  it("no notification for failed or unchanged applies", () => {
    const e = editor();
    const fn = vi.fn();
    e.subscribe(fn);
    e.apply(rename("Rich"));
    e.apply({ op: "flow.rename", flowId: "flow_x", name: "Y" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("viewport-only changes notify (doc changed)", () => {
    const e = editor();
    const fn = vi.fn();
    e.subscribe(fn);
    e.apply(viewport);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const e = editor();
    const fn = vi.fn();
    const off = e.subscribe(fn);
    e.apply(rename("A"));
    off();
    e.apply(rename("B"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener does not break the editor or other listeners", () => {
    const e = editor();
    const other = vi.fn();
    e.subscribe(() => {
      throw new Error("boom");
    });
    e.subscribe(other);
    const r = e.apply(rename("A"));
    expect(r.ok).toBe(true);
    expect(e.doc.name).toBe("A");
    expect(other).toHaveBeenCalledTimes(1);
    expect(e.canUndo).toBe(true);
  });
});

describe("immutability", () => {
  it("documents handed out by the editor are never mutated by later edits", () => {
    const e = editor();
    e.apply(rename("A"));
    const snapshotDoc = e.doc;
    const copy = structuredClone(snapshotDoc);
    e.apply({ op: "node.move", flowId: KIT, nodeId: "n_src", position: { x: 1, y: 1 } });
    e.undo();
    e.undo();
    expect(snapshotDoc).toEqual(copy);
  });
});
