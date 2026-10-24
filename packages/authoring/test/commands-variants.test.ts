import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { resolveFlowPorts } from "@briarflow/core";
import { testCatalog } from "@briarflow/testing";
import { KIT, richDoc } from "./fixtures/docs.js";
import { accept, build, flowOf, nodeOf, reject } from "./fixtures/helpers.js";

const at = { x: 0, y: 0 };
const add = (extra: Record<string, unknown> = {}): Command => ({ op: "node.add", flowId: KIT, id: "n_sh", type: "kit.shaped", position: at, ...extra }) as Command;
const setVariant = (variant: string, extra: Record<string, unknown> = {}): Command => ({ op: "node.setVariant", flowId: KIT, nodeId: "n_sh", variant, ...extra }) as Command;
const ports = (doc: ReturnType<typeof richDoc>) => {
  const n = resolveFlowPorts(doc, KIT, testCatalog()).nodes.get("n_sh");
  return { inputs: n?.inputs.map((p) => p.name), outputs: n?.outputs.map((p) => p.name) };
};

describe("node.add with variants", () => {
  it("stores the default variant when none is given, and its ports apply", () => {
    const r = accept(richDoc(), [add()]);
    expect(nodeOf(r.doc, KIT, "n_sh")?.variant).toBe("text");
    expect(r.resolved[0]).toMatchObject({ variant: "text" });
    expect(ports(r.doc)).toEqual({ inputs: ["value", "extra"], outputs: ["out"] });
  });

  it("takes an explicit variant and validates config against it", () => {
    const r = accept(richDoc(), [add({ variant: "number", config: { mode: "c" } })]);
    expect(nodeOf(r.doc, KIT, "n_sh")).toMatchObject({ variant: "number", config: { mode: "c" } });
    expect(ports(r.doc)).toEqual({ inputs: ["value"], outputs: ["out", "double"] });
    reject(richDoc(), [add({ variant: "number", config: { mode: "b" } })], "config.invalid");
  });

  it("rejects unknown variants and variants on types without them", () => {
    reject(richDoc(), [add({ variant: "nope" })], "node.unknown_variant", { contains: ["text, number"] });
    reject(richDoc(), [{ op: "node.add", flowId: KIT, type: "kit.sinkText", position: at, variant: "x" } as Command], "node.unknown_variant", { contains: ["no variants"] });
  });
});

describe("node.setVariant", () => {
  it("switches ports, keeps config the new variant accepts and drops the rest", () => {
    const doc = build(richDoc(), [add({ config: { mode: "a", label: "L" } })]);
    const r = accept(doc, [setVariant("number")]);
    expect(nodeOf(r.doc, KIT, "n_sh")).toMatchObject({ variant: "number", config: { mode: "a" } });
    expect(ports(r.doc)).toEqual({ inputs: ["value"], outputs: ["out", "double"] });
  });

  it("drops a carried value the new variant rejects (falls back to its default)", () => {
    const doc = build(richDoc(), [add({ config: { mode: "b" } })]);
    const r = accept(doc, [setVariant("number")]);
    expect(nodeOf(r.doc, KIT, "n_sh")?.config).toBeUndefined();
  });

  it("removes wires and constants of vanished ports; undo restores them", () => {
    const doc = build(richDoc(), [
      add({ values: { extra: 3 } }),
      { op: "node.add", flowId: KIT, id: "n_ai", type: "kit.addOne", position: at },
      { op: "edge.connect", flowId: KIT, id: "e_x", from: { node: "n_ai", port: "value" }, to: { node: "n_sh", port: "extra" } },
    ]);
    const r = accept(doc, [setVariant("number")]);
    expect(flowOf(r.doc, KIT).edges.some((e) => e.id === "e_x")).toBe(false);
    expect(nodeOf(r.doc, KIT, "n_sh")?.values).toBeUndefined();
  });

  it("takes a whole config instead of carrying one over", () => {
    const doc = build(richDoc(), [add()]);
    const r = accept(doc, [setVariant("number", { config: { mode: "a" } })]);
    expect(nodeOf(r.doc, KIT, "n_sh")?.config).toEqual({ mode: "a" });
  });

  it("is a no-op for the current variant and rejects unknown ones", () => {
    const doc = build(richDoc(), [add()]);
    expect(accept(doc, [setVariant("text")]).changed).toBe(false);
    reject(doc, [setVariant("nope")], "node.unknown_variant");
  });
});
