import { describe, expect, it } from "vitest";
import {
  BriarError,
  cfg,
  createCatalog,
  createCatalogFromDescriptors,
  defineEnum,
  defineNode,
  definePack,
  definitionFromDescriptor,
  NodeError,
  packsFromDescriptors,
  t,
  toNodeDescriptor,
  type NodeTypesDescriptors,
} from "@briarflow/core";
import { briarPack } from "./fixtures.js";

const Tone = defineEnum("Tone", ["calm", "loud"]);
const shout = defineNode({
  type: "words.shout",
  description: "Shouts.",
  icon: "megaphone",
  color: "peach",
  inputs: { text: { type: t.text({ minLength: 1 }), description: "What to shout", widget: "textarea" }, marks: { type: t.int(), default: 1 } },
  outputs: { text: t.text(), tone: t.ref(Tone) },
  config: { style: cfg.choice(["a", "b"], { default: "a" }), note: cfg.text({ optional: true, multiline: true }) },
  secrets: ["API_KEY"],
  cache: false,
  timeoutMs: 1000,
  retry: 2,
  concurrency: 2,
  deprecated: "Use words.yell.",
  run: ({ inputs }) => ({ text: inputs.text.toUpperCase(), tone: "loud" as const }),
});
const wordsPack = definePack({ name: "words", version: "0.1.0", title: "Words", types: [Tone], nodes: [shout] });

function snapshot(...packs: (typeof wordsPack)[]): NodeTypesDescriptors {
  const catalog = createCatalog(packs);
  return {
    packs: packs.map((p) => ({ name: p.name, version: p.version, title: p.title })),
    nodes: catalog.descriptors(),
    types: [...catalog.types],
  };
}

describe("definitionFromDescriptor", () => {
  it("round-trips through toNodeDescriptor", () => {
    const d = toNodeDescriptor(shout, wordsPack);
    expect(toNodeDescriptor(definitionFromDescriptor(d), wordsPack)).toEqual(d);
  });

  it("has a run that throws node.descriptor_only", () => {
    const def = definitionFromDescriptor(toNodeDescriptor(shout, wordsPack));
    expect(def.resolvePorts).toBeUndefined();
    let caught: unknown;
    try {
      def.run({} as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NodeError);
    expect((caught as BriarError).code).toBe("node.descriptor_only");
    expect((caught as NodeError).retryable).toBe(false);
  });
});

describe("packsFromDescriptors / createCatalogFromDescriptors", () => {
  it("rebuilds packs with namespaces and pack types", () => {
    const [words] = packsFromDescriptors(snapshot(wordsPack));
    expect(words?.name).toBe("words");
    expect(words?.title).toBe("Words");
    expect(words?.types.map((x) => x.id)).toEqual(["words.Tone"]);
    expect(words?.nodes.map((n) => n.type)).toEqual(["words.shout"]);

    const [briar] = packsFromDescriptors(snapshot(briarPack));
    expect(briar?.namespaces).toEqual(["briar", "text", "list", "convert"]);
  });

  it("creates packs that only node descriptors mention", () => {
    const info = snapshot(wordsPack);
    const packs = packsFromDescriptors({ ...info, packs: [] });
    expect(packs.map((p) => [p.name, p.version, p.title])).toEqual([["words", "0.1.0", "words"]]);
  });

  it("builds a catalog, reports dynamic-port types and prefers local packs", () => {
    const info = snapshot(briarPack, wordsPack);
    const remote = createCatalogFromDescriptors(info);
    expect(remote.has("words.shout")).toBe(true);
    expect(remote.getType("words.Tone")?.kind).toBe("enum");
    expect(remote.approximateTypes).toEqual(expect.arrayContaining(["text.template", "briar.struct.break"]));
    expect(remote.approximateTypes).not.toContain("words.shout");
    // Static-port nodes describe themselves exactly as the server did.
    expect(remote.descriptors().filter((d) => d.pack.name === "words")).toEqual(info.nodes.filter((d) => d.pack.name === "words"));

    const withLocal = createCatalogFromDescriptors(info, { localPacks: [briarPack] });
    expect(withLocal.approximateTypes).toEqual([]);
    expect(withLocal.get("text.template")).toBe(briarPack.nodes.find((n) => n.type === "text.template"));
    expect(withLocal.packs.map((p) => p.name)).toEqual(["briar", "words"]);
  });

  it("appends local packs the server does not list", () => {
    const catalog = createCatalogFromDescriptors(snapshot(wordsPack), { localPacks: [briarPack] });
    expect(catalog.packs.map((p) => p.name)).toEqual(["words", "briar"]);
  });
});
