/**
 * Media inputs before a node runs (media.md §1, §4): the entry must exist and fit the struct's
 * kind and limits; empty facts (a format-1 value's mime) are filled from the entry.
 */
import { describe, expect, it } from "vitest";
import { definePack, defineNode, t, type ImageValue } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { context, edge, field, flow, ir, node, testEngine } from "./helpers.js";

const seen: ImageValue[] = [];
const look = defineNode({
  type: "probe.look",
  inputs: { image: t.image() },
  outputs: { mime: t.string() },
  run: ({ inputs }) => {
    seen.push(inputs.image);
    return { mime: inputs.image.mime };
  },
});
const probePack = definePack({ name: "probe", version: "1.0.0", nodes: [look] });

function doc() {
  return context([
    flow({
      id: "flow_m",
      name: "Media",
      inputs: [field("image", ir.image())],
      outputs: [field("mime", ir.string())],
      nodes: [node("n_look", "probe.look")],
      edges: [edge("n_in.image", "n_look.image"), edge("n_look.mime", "n_out.mime")],
    }),
  ]);
}

describe("media inputs", () => {
  it("fills an empty mime and unknown facts from the registry entry", async () => {
    const { engine, media } = testEngine({ packs: [stdPack, probePack] });
    const entry = await media.put(new Uint8Array([1, 2, 3]), { mime: "image/png", filename: "a.png", meta: { width: 4, height: 2 } });
    seen.length = 0;
    const result = await engine.run({ context: doc(), flowId: "flow_m", inputs: { image: { data: { mediaId: entry.id }, mime: "" } } }).result;
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ mime: "image/png" });
    expect(seen[0]).toEqual({ data: { mediaId: entry.id }, mime: "image/png", name: "a.png", size: 3, width: 4, height: 2 });
  });

  it("fails on missing media and on media of another kind", async () => {
    const { engine, media } = testEngine({ packs: [stdPack, probePack] });
    const missing = await engine.run({ context: doc(), flowId: "flow_m", inputs: { image: { data: { mediaId: "med_ghost" }, mime: "image/png" } } }).result;
    expect(missing.error?.cause?.code).toBe("media.not_found");
    const sound = await media.put(new Uint8Array([1]), { mime: "audio/wav" });
    const wrong = await engine.run({ context: doc(), flowId: "flow_m", inputs: { image: { data: { mediaId: sound.id }, mime: "image/png" } } }).result;
    expect(wrong.error?.cause?.code).toBe("media.kind_mismatch");
  });
});
