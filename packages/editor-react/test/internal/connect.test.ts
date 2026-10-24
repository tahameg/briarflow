import { describe, expect, it } from "vitest";
import { applyCommands } from "@briarflow/authoring";
import { createCatalog, createContextDocument, defineNode, definePack, t as types, variant } from "@briarflow/core";
import type { ContextDocument, TypeRef } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { matchConnectTargets } from "../../src/connect.js";
import { buildFlowView } from "../../src/graph.js";

const catalog = createCatalog([stdPack]);
const t = (name: string) => ({ kind: "primitive", name }) as TypeRef;
const prim = t;

function doc(): ContextDocument {
  const r = applyCommands(
    createContextDocument({ id: "ctx_1", name: "T", clock: () => new Date("2026-01-01T00:00:00.000Z") }),
    [
      { op: "flow.create", name: "F", id: "flow_f", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "flow.variable.create", flowId: "flow_f", name: "tone", type: "text", access: "private", id: "var_tone" },
    ],
    { catalog },
  );
  if (!r.ok) throw r.error;
  return r.doc;
}

describe("matchConnectTargets", () => {
  it("finds inputs that accept a dragged output, exact before generic", () => {
    const probes = [
      { key: "join", type: "text.join" },
      { key: "toText", type: "convert.toText" },
      { key: "asInt", type: "convert.asInt" },
      { key: "length", type: "list.length" },
    ];
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("text"), "out", probes)).toEqual([
      { key: "join", port: "separator", portTitle: "Separator", generic: false },
      { key: "toText", port: "value", portTitle: "Value", generic: true },
      { key: "asInt", port: "value", portTitle: "Value", generic: true },
    ]);
  });

  it("a generic limited by oneOf takes only its types", () => {
    const probes = [{ key: "asInt", type: "convert.asInt" }];
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("json"), "out", probes).map((m) => m.key)).toEqual(["asInt"]);
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("int"), "out", probes)).toEqual([]);
  });

  it("finds outputs that can feed a dragged input, variables included", () => {
    const probes = [
      { key: "asInt", type: "convert.asInt" },
      { key: "join", type: "text.join" },
      { key: "get:tone", type: "briar.variable.get", config: { variableId: "var_tone" } },
    ];
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("text"), "in", probes).map((m) => [m.key, m.port])).toEqual([
      ["join", "text"],
      ["get:tone", "value"],
    ]);
  });

  it("binds generic ports: list<$T> takes a list but not a single value", () => {
    const probes = [{ key: "length", type: "list.length" }];
    expect(matchConnectTargets(doc(), "flow_f", catalog, { kind: "list", of: t("text") }, "out", probes)).toEqual([{ key: "length", port: "list", portTitle: "List", generic: true }]);
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("text"), "out", probes)).toEqual([]);
  });

  it("returns nothing for an unknown flow", () => {
    expect(matchConnectTargets(doc(), "flow_x", catalog, t("text"), "out", [{ key: "join", type: "text.join" }])).toEqual([]);
  });
});

describe("variants", () => {
  const shaped = defineNode({
    type: "vary.shaped",
    pure: true,
    variants: {
      title: "Shape",
      options: {
        text: variant({ inputs: { value: types.text() }, outputs: { out: types.text() }, run: ({ inputs }) => ({ out: inputs.value }) }),
        number: variant({ title: "Number", inputs: { value: types.int() }, outputs: { out: types.int() }, run: ({ inputs }) => ({ out: inputs.value }) }),
      },
    },
  });
  const withVariants = createCatalog([stdPack, definePack({ name: "vary", version: "1.0.0", nodes: [shaped] })]);

  it("matches each variant on its own ports", () => {
    const probes = [
      { key: "text", type: "vary.shaped", variant: "text" },
      { key: "number", type: "vary.shaped", variant: "number" },
    ];
    expect(matchConnectTargets(doc(), "flow_f", withVariants, prim("int"), "out", probes).map((m) => m.key)).toEqual(["number"]);
    expect(matchConnectTargets(doc(), "flow_f", withVariants, prim("text"), "out", probes).map((m) => m.key)).toEqual(["text"]);
  });

  it("shows the picked variant on the canvas", () => {
    const r = applyCommands(doc(), [{ op: "node.add", flowId: "flow_f", id: "n_v", type: "vary.shaped", variant: "number", position: { x: 0, y: 0 } }], { catalog: withVariants });
    if (!r.ok) throw r.error;
    const node = buildFlowView(r.doc, "flow_f", withVariants, [], undefined)!.byId.get("n_v")!;
    expect(node.variant).toEqual({
      title: "Shape",
      current: "number",
      known: true,
      options: [
        { name: "text", title: "text" },
        { name: "number", title: "Number" },
      ],
    });
    expect(node.inputs.map((p) => p.typeText)).toEqual(["int"]);
    expect(node.definition?.variant).toBe("number");
  });
});
