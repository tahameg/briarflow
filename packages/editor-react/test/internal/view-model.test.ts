import { describe, expect, it } from "vitest";
import { applyCommands } from "@briarflow/authoring";
import { createCatalog, createContextDocument, validateContext } from "@briarflow/core";
import type { ContextDocument, TypeRef } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { buildFlowView, canConnect } from "../../src/graph.js";
import { initialConfig, paletteGroups, snap } from "../../src/palette.js";
import { isListType, ledFamily, typeStyle } from "../../src/theme.js";
import { initialValue, widgetKind } from "../../src/values.js";

const catalog = createCatalog([stdPack]);

function sample(): ContextDocument {
  const doc = createContextDocument({ id: "ctx_1", name: "Test", clock: () => new Date("2026-01-01T00:00:00.000Z") });
  const r = applyCommands(
    doc,
    [
      { op: "type.defineEnum", scope: { kind: "global" }, name: "Style", id: "ty_style", members: ["anime", "noir"] },
      { op: "flow.create", name: "Portrait", id: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "flow.input.add", flowId: "flow_p", name: "count", type: "int" },
      { op: "flow.input.add", flowId: "flow_p", name: "style", type: "Style" },
      { op: "flow.output.add", flowId: "flow_p", name: "text", type: "text" },
      { op: "node.add", flowId: "flow_p", type: "text.join", id: "n_join", position: { x: 300, y: 0 } },
      { op: "edge.connect", flowId: "flow_p", id: "e_1", from: { node: "n_join", port: "text" }, to: { node: "n_out", port: "text" } },
    ],
    { catalog },
  );
  if (!r.ok) throw r.error;
  return r.doc;
}

describe("buildFlowView", () => {
  it("maps nodes, ports, sources and edge colors", () => {
    const doc = sample();
    const view = buildFlowView(doc, "flow_p", catalog, validateContext(doc, catalog), undefined)!;
    expect(view.nodes.map((n) => n.title)).toEqual(["Input", "Output", "Join text"]);
    const input = view.byId.get("n_in")!;
    expect(input.builtin).toBe(true);
    expect(input.outputs.map((p) => [p.name, p.typeText])).toEqual([
      ["count", "int"],
      ["style", "Style"],
    ]);
    expect(input.outputs[1]!.style.shape).toBe("diamond");
    const out = view.byId.get("n_out")!;
    expect(out.inputs[0]!.source).toMatchObject({ nodeId: "n_join", port: "text", edgeId: "e_1" });
    expect(view.edges[0]!.color).toBe("var(--bf-mint)");
  });

  it("gives ports an LED family, a list flag and a wire count", () => {
    const doc = sample();
    const view = buildFlowView(doc, "flow_p", catalog, [], undefined)!;
    const [count, style] = view.byId.get("n_in")!.outputs;
    expect([count!.led, count!.links, style!.led]).toEqual(["num", 0, "data"]);
    const join = view.byId.get("n_join")!;
    expect(join.outputs[0]).toMatchObject({ led: "text", links: 1 });
    expect(join.inputs.find((p) => p.name === "items")?.list).toBe(true);
    expect(view.byId.get("n_out")!.inputs[0]!.links).toBe(1);
    expect(view.edges[0]!.family).toBe("text");
  });

  it("checks connections with assignability", () => {
    const doc = sample();
    const view = buildFlowView(doc, "flow_p", catalog, [], undefined)!;
    expect(canConnect(view, { node: "n_in", port: "count" }, { node: "n_join", port: "separator" })).toBe(false);
    expect(canConnect(view, { node: "n_join", port: "text" }, { node: "n_join", port: "separator" })).toBe(false);
    expect(canConnect(view, { node: "n_join", port: "text" }, { node: "n_out", port: "text" })).toBe(true);
  });

  it("returns undefined for an unknown flow", () => {
    expect(buildFlowView(sample(), "flow_nope", catalog, [], undefined)).toBeUndefined();
  });
});

describe("helpers", () => {
  it("styles list and optional types", () => {
    const s = typeStyle({ kind: "optional", of: { kind: "list", of: { kind: "primitive", name: "image" } } });
    expect(s).toMatchObject({ token: "peach", hollow: true, optional: true, shape: "square" });
    expect(typeStyle({ kind: "var", name: "T" }).unbound).toBe(true);
  });

  it("groups the palette and searches", () => {
    const groups = paletteGroups(catalog.descriptors(), "join");
    expect(groups.flatMap((g) => g.nodes.map((n) => n.type))).toEqual(["text.join"]);
  });

  it("builds a starting config for config-required nodes", () => {
    const doc = sample();
    expect(initialConfig(catalog.get("briar.constant"), doc, "flow_p", catalog)).toEqual({ type: "text" });
    expect(initialConfig(catalog.get("text.join"), doc, "flow_p", catalog)).toBeUndefined();
    expect(snap({ x: 13, y: 29 })).toEqual({ x: 12, y: 24 });
  });

  it("picks widgets and initial values", () => {
    expect(widgetKind({ kind: "primitive", name: "image" }, undefined)).toBe("media");
    expect(initialValue({ kind: "primitive", name: "int", constraints: { min: 3 } }, undefined)).toBe(3);
    expect(initialValue({ kind: "list", of: { kind: "primitive", name: "text" } }, undefined)).toEqual([]);
  });
});

describe("ledFamily", () => {
  const t = (name: string) => ({ kind: "primitive", name }) as TypeRef;

  it("groups types by family through lists and optionals", () => {
    expect([t("text"), t("int"), t("float"), t("boolean"), t("image"), t("audio"), t("file")].map(ledFamily)).toEqual(["text", "num", "num", "bool", "media", "media", "data"]);
    expect(ledFamily({ kind: "optional", of: { kind: "list", of: t("int") } })).toBe("num");
    expect(ledFamily({ kind: "named", id: "ty_style" })).toBe("data");
    expect(ledFamily({ kind: "var", name: "T" })).toBe("any");
  });

  it("marks lists, optional or not", () => {
    expect(isListType({ kind: "list", of: t("text") })).toBe(true);
    expect(isListType({ kind: "optional", of: { kind: "list", of: t("text") } })).toBe(true);
    expect(isListType(t("text"))).toBe(false);
  });
});
