import { describe, expect, it } from "vitest";
import { applyCommands } from "@briarflow/authoring";
import { createCatalog, createContextDocument } from "@briarflow/core";
import type { RunState } from "@briarflow/editor";
import { imagePack } from "@briarflow/nodes-image";
import { stdPack } from "@briarflow/nodes-std";
import { buildFlowView, visualMediaKind } from "../../src/graph.js";

const catalog = createCatalog([stdPack, imagePack]);
const img = { mediaId: "med_1" };

function doc() {
  const r = applyCommands(
    createContextDocument({ id: "ctx_1", name: "T" }),
    [
      { op: "flow.create", name: "F", id: "flow_f", inputNodeId: "n_in", outputNodeId: "n_out" },
      { op: "node.add", flowId: "flow_f", type: "image.split", id: "n_split", position: { x: 0, y: 0 } },
      { op: "node.add", flowId: "flow_f", type: "text.join", id: "n_join", position: { x: 0, y: 0 } },
    ],
    { catalog },
  );
  if (!r.ok) throw r.error;
  return r.doc;
}

describe("media previews", () => {
  it("knows which port types are visual media", () => {
    expect(visualMediaKind({ kind: "primitive", name: "image" })).toBe("image");
    expect(visualMediaKind({ kind: "list", of: { kind: "optional", of: { kind: "primitive", name: "video" } } })).toBe("video");
    expect(visualMediaKind({ kind: "primitive", name: "audio" })).toBeUndefined();
  });

  it("gives image-output nodes a preview with the last run's media", () => {
    const before = buildFlowView(doc(), "flow_f", catalog, [], undefined)!;
    expect(before.byId.get("n_split")!.media?.map((m) => [m.port, m.kind, m.refs.length])).toEqual([
      ["red", "image", 0],
      ["green", "image", 0],
      ["blue", "image", 0],
      ["alpha", "image", 0],
    ]);
    expect(before.byId.get("n_join")!.media).toBeUndefined();
    const run = { flowId: "flow_f", nodes: { n_split: { status: "done", outputs: { red: img, green: img, blue: img, alpha: null } } } } as unknown as RunState;
    const after = buildFlowView(doc(), "flow_f", catalog, [], run)!;
    expect(after.byId.get("n_split")!.media?.map((m) => m.refs.length)).toEqual([1, 1, 1, 0]);
  });
});
