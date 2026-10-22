import { createCatalogFromDescriptors, definePack, defineNode, t, validateContext } from "@briarflow/core";
import type { NodeDescriptor } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { catalogFromNodeTypes } from "../../src/index.js";
import { baseDoc } from "./fakes.js";

const shout = defineNode({
  type: "words.shout",
  title: "Shout",
  inputs: { text: { type: t.text(), widget: "textarea" }, marks: { type: t.int({ min: 0 }), default: 1 } },
  outputs: { text: t.text() },
  run: ({ inputs }) => ({ text: inputs.text }),
});
const wordsPack = definePack({ name: "words", version: "0.1.0", nodes: [shout] });

const descriptor = (over: Partial<NodeDescriptor>): NodeDescriptor => ({
  type: "py.upscale",
  pack: { name: "py", version: "1.0.0" },
  title: "Upscale",
  description: "",
  category: "Image",
  icon: "image",
  color: "mint",
  inputs: [{ name: "factor", type: { kind: "primitive", name: "int" }, title: "Factor", default: 2, widget: null }],
  outputs: [{ name: "image", type: { kind: "primitive", name: "image" }, title: "Image" }],
  config: [{ name: "mode", kind: "choice", required: false, title: "Mode", default: "fast", choices: ["fast", "best"] }],
  dynamicPorts: false,
  secrets: [],
  cache: true,
  timeoutMs: 1000,
  retry: { maxAttempts: 1 },
  concurrency: null,
  deprecated: null,
  ...over,
});

describe("catalogFromNodeTypes", () => {
  it("rebuilds definitions whose descriptors round-trip, without run", () => {
    const d = descriptor({});
    const { catalog, approximateTypes } = catalogFromNodeTypes({ packs: [{ name: "py", version: "1.0.0" }], nodes: [d], types: [] });
    expect(approximateTypes).toEqual([]);
    expect(catalog.has("py.upscale")).toBe(true);
    expect(catalog.packOf("py.upscale")?.name).toBe("py");
    expect(catalog.descriptors()).toEqual([d]);
    expect(() => catalog.get("py.upscale")!.run({} as never)).toThrow(/descriptor/);
    expect(validateContext(baseDoc(), catalog)).toEqual(validateContext(baseDoc(), catalog));
  });

  it("prefers local packs over descriptors and reports descriptor-only dynamic nodes", () => {
    const dyn = descriptor({ type: "py.template", dynamicPorts: true });
    const info = {
      packs: [
        { name: "words", version: "0.1.0" },
        { name: "py", version: "1.0.0" },
      ],
      nodes: [...wordsPack.nodes.map((n) => descriptor({ type: n.type, pack: { name: "words", version: "0.1.0" } })), dyn],
      types: [],
    };
    const { catalog, approximateTypes } = catalogFromNodeTypes(info, { localPacks: [wordsPack] });
    expect(catalog.get("words.shout")).toBe(wordsPack.nodes[0]);
    expect(approximateTypes).toEqual(["py.template"]);
  });

  it("assigns pack types by id prefix", () => {
    const type = { kind: "enum" as const, id: "py.Mode", name: "Mode", members: [{ value: "a" }] };
    const { catalog } = catalogFromNodeTypes({ packs: [{ name: "py", version: "1.0.0" }], nodes: [descriptor({})], types: [type] });
    expect(catalog.getType("py.Mode")).toEqual(type);
  });
});

describe("createCatalogFromDescriptors (core, via REQ-8)", () => {
  it("carries approximateTypes on the catalog and matches the editor wrapper", () => {
    const dyn = descriptor({ type: "py.template", dynamicPorts: true });
    const info = { packs: [{ name: "py", version: "1.0.0" }], nodes: [descriptor({}), dyn], types: [] };
    const catalog = createCatalogFromDescriptors(info);
    expect(catalog.approximateTypes).toEqual(["py.template"]);
    expect(catalogFromNodeTypes(info).approximateTypes).toEqual(["py.template"]);
    expect(() => catalog.get("py.upscale")!.run({} as never)).toThrow(/descriptor/);
  });
});
