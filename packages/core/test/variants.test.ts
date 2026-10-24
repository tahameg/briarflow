/**
 * node-api.md §1.2: nodes with variants (one type, several shapes picked on the node).
 */
import { describe, expect, it } from "vitest";
import {
  cfg,
  createCatalog,
  createCatalogFromDescriptors,
  createContextDocument,
  createFlowDocument,
  defineNode,
  definePack,
  nodeDefinition,
  resolveFlowPorts,
  t,
  toNodeDescriptor,
  validateContext,
  variant,
  variantDefinition,
} from "../src/index.js";
import type { ContextDocument, NodeInstance } from "../src/index.js";

const prompt = { prompt: t.text() };
const image = defineNode({
  type: "img.generate",
  pure: true,
  variants: {
    title: "Model",
    default: "best",
    options: {
      fast: variant({ title: "Fast", inputs: prompt, outputs: { image: t.image() }, run: () => ({ image: { uri: "x", mime: "image/png" } }) }),
      best: variant({
        title: "Best",
        description: "Slow and sharp.",
        config: { steps: cfg.int({ min: 1, max: 50, default: 20 }) },
        inputs: { ...prompt, negative: t.optional(t.text()) },
        outputs: { image: t.image(), seed: t.int() },
        run: ({ config }) => ({ image: { uri: "y", mime: "image/png" }, seed: config.steps }),
      }),
    },
  },
});
const pack = definePack({ name: "img", version: "1.0.0", nodes: [image] });

function docWith(node: Partial<NodeInstance>): ContextDocument {
  // Without execution lines, so every node is checked.
  const { execEdges: _lines, ...flow } = createFlowDocument({ name: "F", id: "flow_f", inputNodeId: "n_in", outputNodeId: "n_out" });
  const doc = createContextDocument({ name: "C", id: "ctx_c" });
  return { ...doc, flows: [{ ...flow, nodes: [...flow.nodes, { id: "n_img", type: "img.generate", position: { x: 0, y: 0 }, ...node }] }] };
}

describe("defineNode with variants", () => {
  it("returns the default variant, linked to every variant", () => {
    expect(image.variant).toBe("best");
    expect(Object.keys(image.inputs)).toEqual(["prompt", "negative"]);
    expect(image.variants?.options.map((o) => [o.name, o.title])).toEqual([
      ["fast", "Fast"],
      ["best", "Best"],
    ]);
    const fast = variantDefinition(image, "fast");
    expect(fast?.variant).toBe("fast");
    expect(fast?.variants).toBe(image.variants);
    expect(fast?.pure).toBe(true);
    expect(Object.keys(fast?.outputs ?? {})).toEqual(["image"]);
    expect(variantDefinition(image, undefined)).toBe(image);
    expect(variantDefinition(image, "nope")).toBeUndefined();
  });

  it("answers itself (no variant) for plain nodes", () => {
    const plain = defineNode({ type: "img.plain", run: () => ({}) });
    expect(variantDefinition(plain, undefined)).toBe(plain);
    expect(variantDefinition(plain, "x")).toBeUndefined();
  });

  it.each([
    ["shape on the node", { inputs: {}, variants: { options: { a: variant({ run: () => ({}) }) } } }, "declares inputs on each variant"],
    ["no options", { variants: { options: {} } }, "at least one variant"],
    ["bad name", { variants: { options: { "a b": variant({ run: () => ({}) }) } } }, 'variant "a b": is not a valid variant name'],
    ["missing default", { variants: { default: "z", options: { a: variant({ run: () => ({}) }) } } }, 'variants.default "z"'],
    ["not from variant()", { variants: { options: { a: { run: () => ({}) } } } }, "must be made with variant"],
    ["bad port", { variants: { options: { a: variant({ inputs: { "1x": t.text() }, run: () => ({}) }) } } }, 'variant "a"'],
    ["conversion", { conversion: true, pure: true, variants: { options: { a: variant({ run: () => ({}) }) } } }, "conversion node cannot have variants"],
  ])("rejects %s", (_name, extra, message) => {
    expect(() => defineNode({ type: "img.bad", ...(extra as object) } as never)).toThrow(message);
  });
});

describe("placed nodes", () => {
  const catalog = createCatalog([pack]);

  it("resolve the ports of their variant (default when unset)", () => {
    const ports = (n: Partial<NodeInstance>) => resolveFlowPorts(docWith(n), "flow_f", catalog).nodes.get("n_img");
    expect(ports({ variant: "fast" })?.outputs.map((p) => p.name)).toEqual(["image"]);
    expect(ports({})?.inputs.map((p) => p.name)).toEqual(["prompt", "negative"]);
    expect(ports({ variant: "fast" })?.definition?.variant).toBe("fast");
    expect(nodeDefinition(catalog, { type: "img.generate", variant: "fast" })?.variant).toBe("fast");
  });

  it("validate config against their variant", () => {
    expect(validateContext(docWith({ variant: "best", config: { steps: 5 } }), catalog).filter((d) => d.code.startsWith("config."))).toEqual([]);
    expect(validateContext(docWith({ variant: "fast", config: { steps: 5 } }), catalog).map((d) => d.code)).toContain("config.invalid");
  });

  it("report an unknown variant", () => {
    const diags = validateContext(docWith({ variant: "huge" }), catalog);
    expect(diags.find((d) => d.code === "node.unknown_variant")).toMatchObject({
      path: { flowId: "flow_f", nodeId: "n_img" },
      details: { variant: "huge", variants: ["fast", "best"] },
    });
  });
});

describe("descriptors", () => {
  it("list every variant and rebuild them", () => {
    const d = toNodeDescriptor(image, pack);
    expect(d.inputs.map((p) => p.name)).toEqual(["prompt", "negative"]);
    expect(d.variants).toMatchObject({ title: "Model", default: "best" });
    expect(d.variants?.options.map((o) => [o.name, o.outputs.map((p) => p.name), o.config.map((c) => c.name)])).toEqual([
      ["fast", ["image"], []],
      ["best", ["image", "seed"], ["steps"]],
    ]);
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);

    const rebuilt = createCatalogFromDescriptors({ packs: [{ name: "img", version: "1.0.0" }], nodes: [d], types: [] });
    const fast = nodeDefinition(rebuilt, { type: "img.generate", variant: "fast" });
    expect(fast?.variant).toBe("fast");
    expect(Object.keys(fast?.outputs ?? {})).toEqual(["image"]);
    expect(resolveFlowPorts(docWith({ variant: "fast" }), "flow_f", rebuilt).nodes.get("n_img")?.outputs.map((p) => p.name)).toEqual(["image"]);
    expect(toNodeDescriptor(rebuilt.get("img.generate")!, pack)).toEqual(d);
  });
});
