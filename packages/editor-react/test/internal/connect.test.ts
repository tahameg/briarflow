import { describe, expect, it } from "vitest";
import { applyCommands } from "@briarflow/authoring";
import { createCatalog, createContextDocument } from "@briarflow/core";
import type { ContextDocument, TypeRef } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { matchConnectTargets } from "../../src/connect.js";

const catalog = createCatalog([stdPack]);
const t = (name: string) => ({ kind: "primitive", name }) as TypeRef;

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
      { key: "parseInt", type: "convert.parseInt" },
      { key: "length", type: "list.length" },
    ];
    expect(matchConnectTargets(doc(), "flow_f", catalog, t("text"), "out", probes)).toEqual([
      { key: "join", port: "separator", portTitle: "Separator", generic: false },
      { key: "toText", port: "value", portTitle: "Value", generic: true },
      { key: "parseInt", port: "text", portTitle: "Text", generic: false },
    ]);
  });

  it("finds outputs that can feed a dragged input, variables included", () => {
    const probes = [
      { key: "parseInt", type: "convert.parseInt" },
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
