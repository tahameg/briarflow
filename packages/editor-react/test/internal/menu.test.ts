import { describe, expect, it } from "vitest";
import type { FlowDocument } from "@briarflow/core";
import { collectItems, leafCount, mergeItems, nextEnabled, searchItems, separatorsBefore } from "../../src/menu.js";
import type { ContextMenuItem, ContextMenuTarget } from "../../src/menu.js";
import { duplicateCommands } from "../../src/duplicate.js";

const run = () => undefined;
const labels = (items: readonly ContextMenuItem[]) => items.map((i) => i.label);

describe("mergeItems", () => {
  it("sorts by order and keeps contribution order for ties", () => {
    const merged = mergeItems([
      [{ id: "del", label: "Delete", order: 900, run }, { id: "a", label: "A", order: 200, run }],
      [{ id: "b", label: "B", order: 200, run }, { id: "add", label: "Add", order: 100, run }],
    ]);
    expect(labels(merged)).toEqual(["Add", "A", "B", "Delete"]);
  });

  it("lets a later item with the same id replace an earlier one", () => {
    const merged = mergeItems([[{ id: "x", label: "Old", order: 200, run }], [{ id: "x", label: "New", order: 200, run }]]);
    expect(labels(merged)).toEqual(["New"]);
  });

  it("merges submenus with the same id", () => {
    const merged = mergeItems([
      [{ id: "text", label: "Text", items: [{ id: "t1", label: "Template", run }] }],
      [{ id: "text", label: "Text", items: [{ id: "t2", label: "Join", run }] }],
    ]);
    expect(labels(merged[0]!.items!)).toEqual(["Template", "Join"]);
  });
});

describe("collectItems", () => {
  const target: ContextMenuTarget = { kind: "edge", flowId: "f", edgeId: "e" };

  it("asks every contributor, adds local items and drops empty entries", () => {
    const items = collectItems(
      [(t) => (t.kind === "edge" ? [{ id: "go", label: "Go", order: 800, run }] : null), () => false, () => [{ id: "empty", label: "Empty", items: [] }]],
      target,
      [{ id: "local", label: "Local", order: 100, run }],
    );
    expect(labels(items)).toEqual(["Local", "Go"]);
  });
});

describe("separatorsBefore", () => {
  it("separates items whose order band or group differs", () => {
    const items: ContextMenuItem[] = [
      { id: "a", label: "a", order: 100, run },
      { id: "b", label: "b", order: 150, run },
      { id: "c", label: "c", order: 200, run },
      { id: "d", label: "d", order: 210, group: "x", run },
    ];
    expect([...separatorsBefore(items)]).toEqual([2, 3]);
  });
});

describe("searchItems", () => {
  const items: ContextMenuItem[] = [
    { id: "text", label: "Text", items: [{ id: "tpl", label: "Template", hint: "text.template", run }, { id: "join", label: "Join lines", run }] },
    { id: "ai", label: "AI", items: [{ id: "llm", label: "Fake LLM", keywords: ["chat"], run }, { id: "off", label: "Off", disabled: true, run }] },
    { id: "fit", label: "Fit view", run },
  ];

  it("finds runnable items at any depth with their path", () => {
    expect(searchItems(items, "templ")).toEqual([{ item: items[0]!.items![0], path: ["Text"] }]);
    expect(searchItems(items, "chat").map((h) => h.item.id)).toEqual(["llm"]);
  });

  it("matches every word against label, path and hint, and puts prefix matches first", () => {
    expect(searchItems(items, "text join").map((h) => h.item.id)).toEqual(["join"]);
    const flat: ContextMenuItem[] = [
      { id: "make", label: "Make list", run },
      { id: "ops", label: "List ops", run },
    ];
    expect(searchItems(flat, "list").map((h) => h.item.id)).toEqual(["ops", "make"]);
  });

  it("skips disabled items and returns nothing for an empty query", () => {
    expect(searchItems(items, "off")).toEqual([]);
    expect(searchItems(items, "  ")).toEqual([]);
  });

  it("counts leaves", () => {
    expect(leafCount(items)).toBe(5);
  });
});

describe("nextEnabled", () => {
  it("skips disabled items and wraps", () => {
    const list = [{}, { disabled: true }, {}];
    expect(nextEnabled(list, 0, 1)).toBe(2);
    expect(nextEnabled(list, 2, 1)).toBe(0);
    expect(nextEnabled(list, -1, 1)).toBe(0);
    expect(nextEnabled(list, 0, -1)).toBe(2);
    expect(nextEnabled([{ disabled: true }], 0, 1)).toBe(-1);
  });
});

describe("duplicateCommands", () => {
  const flow = {
    id: "f",
    nodes: [
      { id: "n_in", type: "briar.input", position: { x: 0, y: 0 } },
      { id: "n_a", type: "text.template", position: { x: 100, y: 0 }, title: "A", config: { k: 1 }, values: { template: "hi" } },
      { id: "n_b", type: "text.join", position: { x: 300, y: 0 } },
      { id: "n_c", type: "text.join", position: { x: 500, y: 0 } },
    ],
    edges: [
      { id: "e_1", from: { node: "n_in", port: "x" }, to: { node: "n_a", port: "x" } },
      { id: "e_2", from: { node: "n_a", port: "text" }, to: { node: "n_b", port: "a" } },
      { id: "e_3", from: { node: "n_b", port: "text" }, to: { node: "n_c", port: "a" } },
    ],
  } as unknown as FlowDocument;

  it("copies nodes with their data and only the edges between copies", () => {
    let i = 0;
    const { commands, ids } = duplicateCommands(flow, ["n_in", "n_a", "n_b"], { x: 10, y: 20 }, () => `n_new${++i}`);
    expect([...ids.entries()]).toEqual([
      ["n_a", "n_new1"],
      ["n_b", "n_new2"],
    ]);
    expect(commands).toEqual([
      { op: "node.add", flowId: "f", id: "n_new1", type: "text.template", position: { x: 110, y: 20 }, title: "A", config: { k: 1 }, values: { template: "hi" } },
      { op: "node.add", flowId: "f", id: "n_new2", type: "text.join", position: { x: 310, y: 20 } },
      { op: "edge.connect", flowId: "f", from: { node: "n_new1", port: "text" }, to: { node: "n_new2", port: "a" } },
    ]);
  });

  it("never reuses an existing id", () => {
    const seq = ["n_a", "n_fresh"];
    const { ids } = duplicateCommands(flow, ["n_c"], undefined, () => seq.shift()!);
    expect(ids.get("n_c")).toBe("n_fresh");
  });
});
