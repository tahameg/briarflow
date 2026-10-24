/**
 * defineNode, cfg, definePack, catalog, descriptors (phase-1.md §5.9; node-api.md §1–§7).
 */
import { describe, expect, it } from "vitest";
import {
  CatalogError,
  NodeDefinitionError,
  PackDefinitionError,
  cfg,
  createCatalog,
  defineEnum,
  defineNode,
  definePack,
  defineStruct,
  t,
  toNodeDescriptor,
  type AnyNodeDefinition,
  type NodeDescriptor,
} from "@briarflow/core";
import {
  briarTestPack,
  catchError,
  duplicatePackPair,
  expectBriarError,
  kitPack,
  namespaceConflictPair,
  testCatalog,
  wordsPack,
} from "@briarflow/testing";

const any = (def: unknown) => def as AnyNodeDefinition;

describe("defineNode defaults", () => {
  const def = defineNode({
    type: "openai.chatCompletion",
    inputs: { maxTokens: t.int(), prompt: { type: t.text(), title: "Your prompt" } },
    outputs: { text: t.text() },
    run: () => ({ text: "" }),
  });

  it("applies every default of node-api.md §1", () => {
    expect(def).toMatchObject({
      kind: "nodeDefinition",
      type: "openai.chatCompletion",
      title: "Chat completion",
      category: "Openai",
      description: "",
      cache: true,
      cacheVersion: "1",
      timeoutMs: 300_000,
      retry: { maxAttempts: 1 },
      secrets: [],
    });
    expect(def.icon).toBeUndefined();
    expect(def.concurrency).toBeUndefined();
    expect(def.deprecated).toBeUndefined();
    expect(def.config).toEqual({});
  });

  it("keeps explicit values", () => {
    const explicit = defineNode({
      type: "acme.generateImage",
      title: "Generate image",
      description: "d",
      category: "Image",
      icon: "image",
      color: "peach",
      secrets: ["ACME_API_KEY"],
      cache: false,
      cacheVersion: "2",
      timeoutMs: 0,
      retry: { maxAttempts: 5, initialDelayMs: 100 },
      concurrency: 2,
      deprecated: "Use acme.v2",
      outputs: { image: t.image() },
      run: () => ({ image: { mediaId: "med_1" } }),
    });
    expect(explicit).toMatchObject({
      title: "Generate image",
      description: "d",
      category: "Image",
      icon: "image",
      color: "peach",
      secrets: ["ACME_API_KEY"],
      cache: false,
      cacheVersion: "2",
      timeoutMs: 0,
      retry: { maxAttempts: 5, initialDelayMs: 100 },
      concurrency: 2,
      deprecated: "Use acme.v2",
    });
  });

  it("retry: n → { maxAttempts: n + 1 }", () => {
    const make = (retry: number) => defineNode({ type: "demo.r", retry, run: () => ({}) }).retry;
    expect(make(2)).toEqual({ maxAttempts: 3 });
    expect(make(0)).toEqual({ maxAttempts: 1 });
  });

  it("derives port titles from names", () => {
    const ports = def.inputs as Record<string, unknown>;
    expect(ports.maxTokens).toBeDefined();
    const descriptor = toNodeDescriptor(any(def), { name: "openai", version: "1.0.0" });
    expect(descriptor.inputs.map((p) => [p.name, p.title])).toEqual([
      ["maxTokens", "Max tokens"],
      ["prompt", "Your prompt"],
    ]);
    expect(descriptor.outputs[0]!.title).toBe("Text");
  });

  it.each([
    ["words.shout", "Shout"],
    ["text.toUpperCase", "To upper case"],
    ["openai.chat", "Chat"],
    ["image.resize_fast", "Resize fast"],
  ])("title of %s is %j", (type, title) => {
    expect(defineNode({ type, run: () => ({}) }).title).toBe(title);
  });

  it("run is kept and callable", async () => {
    const shout = defineNode({ type: "demo.shout", inputs: { text: t.text() }, outputs: { text: t.text() }, run: ({ inputs }) => ({ text: inputs.text.toUpperCase() }) });
    const out = await shout.run({ inputs: { text: "hi" }, config: {}, node: { id: "n_1", type: "demo.shout", position: { x: 0, y: 0 } }, ctx: {} as never });
    expect(out).toEqual({ text: "HI" });
  });
});

describe("defineNode validation (node_def.invalid)", () => {
  const run = () => ({});
  const cases: [string, () => unknown, string][] = [
    ["type without namespace", () => defineNode({ type: "shout", run }), "type"],
    ["type with uppercase namespace", () => defineNode({ type: "Text.tmpl", run }), "type"],
    ["type with uppercase name", () => defineNode({ type: "text.Tmpl", run }), "type"],
    ["type with a dash", () => defineNode({ type: "text.my-node", run }), "type"],
    ["input name starting with a digit", () => defineNode({ type: "demo.bad", inputs: { "1abc": t.text() }, run }), "1abc"],
    ["input name with a dash", () => defineNode({ type: "demo.bad", inputs: { "max-tokens": t.text() }, run }), "max-tokens"],
    ["output name invalid", () => defineNode({ type: "demo.bad", outputs: { "a b": t.text() }, run: () => ({ "a b": "" }) }), "a b"],
    ["reserved input name", () => defineNode({ type: "demo.bad", inputs: { constructor: t.text() }, run }), "constructor"],
    ["reserved output name", () => defineNode({ type: "demo.bad", outputs: { prototype: t.text() }, run: () => ({ prototype: "" }) }), "prototype"],
    [
      "output default",
      () => defineNode({ type: "demo.bad", outputs: { out: { type: t.text(), default: "x" } }, run: () => ({ out: "" }) }),
      "out",
    ],
    ["input default violating a constraint", () => defineNode({ type: "demo.bad", inputs: { n: { type: t.int({ min: 0 }), default: -1 } }, run }), "n"],
    [
      "input default of the wrong type",
      () => defineNode({ type: "demo.bad", inputs: { n: { type: t.int(), default: "x" as unknown as number } }, run }),
      "n",
    ],
    [
      "choice default not in choices",
      () => defineNode({ type: "demo.bad", config: { mode: cfg.choice(["a", "b"], { default: "c" as "a" }) }, run }),
      "mode",
    ],
    ["invalid config key", () => defineNode({ type: "demo.bad", config: { "bad-key": cfg.text() }, run }), "bad-key"],
    [
      "config int default out of range",
      () => defineNode({ type: "demo.bad", config: { count: cfg.int({ min: 0, max: 3, default: 9 }) }, run }),
      "count",
    ],
    ["negative timeout", () => defineNode({ type: "demo.bad", timeoutMs: -1, run }), "timeoutMs"],
    ["negative retry", () => defineNode({ type: "demo.bad", retry: -1, run }), "retry"],
  ];

  it.each(cases)("%s", (_label, build, fieldName) => {
    const error = expectBriarError(build, "node_def.invalid", NodeDefinitionError);
    expect(error.message).toContain(fieldName);
  });

  it("message names the node type", () => {
    const error = catchError(() => defineNode({ type: "text.tmpl", inputs: { "1x": t.text() }, run: () => ({}) })) as Error;
    expect(error.message).toContain("text.tmpl");
  });
});

describe("cfg", () => {
  it("required unless default or optional", () => {
    expect(cfg.text()).toMatchObject({ kind: "text", required: true });
    expect(cfg.text({ default: "x" })).toMatchObject({ kind: "text", required: false, default: "x" });
    expect(cfg.text({ optional: true })).toMatchObject({ kind: "text", required: false });
    expect(cfg.int({ min: 0, max: 3 })).toMatchObject({ kind: "int", required: true, min: 0, max: 3 });
    expect(cfg.choice(["a", "b"], { default: "a" })).toMatchObject({ kind: "choice", choices: ["a", "b"], default: "a", required: false });
    expect(cfg.typeId({ kind: "struct" })).toMatchObject({ kind: "typeId", typeKind: "struct", required: true });
    expect(cfg.typeId()).toMatchObject({ typeKind: "any" });
    expect(cfg.global({ writable: true })).toMatchObject({ kind: "global", writable: true });
    expect(cfg.flowVariable()).toMatchObject({ kind: "flowVariable", required: true });
    expect(cfg.type()).toMatchObject({ kind: "type", required: true });
    expect(cfg.boolean({ default: false })).toMatchObject({ kind: "boolean", required: false, default: false });
  });
});

describe("definePack", () => {
  it("qualifies type ids and refs in struct fields and node ports (words pack)", () => {
    const pack = wordsPack();
    expect(pack).toMatchObject({ kind: "nodePack", name: "words", version: "0.1.0", title: "Words", namespaces: ["words"] });
    expect(pack.description).toBe("");
    expect(pack.types.map((x) => x.id)).toEqual(["words.Tone", "words.Stats"]);
    const stats = pack.types[1]!;
    expect(stats.kind === "struct" && stats.fields.find((f) => f.name === "tone")?.type).toEqual({ kind: "named", id: "words.Tone" });
    const count = pack.nodes.find((n) => n.type === "words.count")!;
    const descriptor = toNodeDescriptor(count, pack);
    expect(descriptor.outputs[0]!.type).toEqual({ kind: "named", id: "words.Stats" });
  });

  it("qualifies bare string refs to the pack's own types (lists and optionals too)", () => {
    const Role = defineEnum("Role", ["user"]);
    const node = defineNode({
      type: "chat.send",
      inputs: { role: t.ref("Role"), roles: t.list(t.optional(t.parse("Role"))) },
      run: () => ({}),
    });
    const pack = definePack({ name: "chat", version: "1.0.0", types: [Role], nodes: [any(node)] });
    const descriptor = toNodeDescriptor(pack.nodes[0]!, pack);
    expect(descriptor.inputs[0]!.type).toEqual({ kind: "named", id: "chat.Role" });
    expect(descriptor.inputs[1]!.type).toEqual({ kind: "list", of: { kind: "optional", of: { kind: "named", id: "chat.Role" } } });
  });

  it("does not mutate the input definitions", () => {
    const Tone = defineEnum("Tone", ["calm"]);
    const before = structuredClone(Tone.decl);
    definePack({ name: "moods", version: "1.0.0", types: [Tone], nodes: [] });
    expect(Tone.decl).toEqual(before);
  });

  it("namespaces always include the pack name", () => {
    expect(briarTestPack().namespaces).toEqual(expect.arrayContaining(["briar", "text", "list", "convert"]));
    expect(briarTestPack().types.map((x) => x.id)).toEqual(["briar.RoundingMode"]);
  });

  const node = (type: string) => any(defineNode({ type, run: () => ({}) }));
  const cases: [string, () => unknown][] = [
    ["invalid pack name", () => definePack({ name: "Words", version: "1.0.0", nodes: [] })],
    ["pack name too long", () => definePack({ name: "a".repeat(33), version: "1.0.0", nodes: [] })],
    ["invalid version", () => definePack({ name: "w", version: "one", nodes: [] })],
    ["node outside the pack's namespaces", () => definePack({ name: "w", version: "1.0.0", nodes: [node("other.x")] })],
    ["duplicate node types", () => definePack({ name: "w", version: "1.0.0", nodes: [node("w.x"), node("w.x")] })],
    [
      "duplicate type names",
      () => definePack({ name: "w", version: "1.0.0", types: [defineEnum("Tone", ["a"]), defineStruct("Tone", {})], nodes: [] }),
    ],
    [
      "type names differing only in case",
      () => definePack({ name: "w", version: "1.0.0", types: [defineEnum("Tone", ["a"]), defineEnum("TONE", ["b"])], nodes: [] }),
    ],
    [
      "unresolved ref in a node port",
      () => definePack({ name: "w", version: "1.0.0", nodes: [any(defineNode({ type: "w.x", inputs: { a: t.ref("Missing") }, run: () => ({}) }))] }),
    ],
    [
      "unresolved ref in a struct field",
      () => definePack({ name: "w", version: "1.0.0", types: [defineStruct("S", { a: t.ref("Missing") })], nodes: [] }),
    ],
    [
      "pack type referencing another pack's type",
      () => definePack({ name: "w", version: "1.0.0", types: [defineStruct("S", { a: t.ref("openai.ChatMessage") })], nodes: [] }),
    ],
    ["invalid extra namespace", () => definePack({ name: "w", version: "1.0.0", namespaces: ["Bad"], nodes: [] })],
  ];

  it.each(cases)("%s → pack.invalid", (_label, build) => {
    expectBriarError(build, "pack.invalid", PackDefinitionError);
  });
});

describe("createCatalog", () => {
  it("resolves node types, packs and types", () => {
    const catalog = testCatalog();
    expect(catalog.packs.map((p) => p.name)).toEqual(["briar", "kit"]);
    expect(catalog.has("text.template")).toBe(true);
    expect(catalog.get("text.template")?.title).toBe("Text template");
    expect(catalog.get("ghost.node")).toBeUndefined();
    expect(catalog.has("ghost.node")).toBe(false);
    expect(catalog.packOf("kit.same")?.name).toBe("kit");
    expect(catalog.packOf("convert.toText")?.name).toBe("briar");
    expect(catalog.getType("briar.RoundingMode")?.kind).toBe("enum");
    expect(catalog.getType("RoundingMode")).toBeUndefined();
    expect(catalog.types.map((x) => x.id)).toEqual(["briar.RoundingMode"]);
  });

  it("built-in input/output nodes are not catalog entries", () => {
    const catalog = testCatalog();
    expect(catalog.get("briar.input")).toBeUndefined();
    expect(catalog.get("briar.output")).toBeUndefined();
    expect(catalog.has("briar.input")).toBe(false);
  });

  it("descriptors() lists every node in pack then node order", () => {
    const catalog = createCatalog([wordsPack(), kitPack()]);
    const types = catalog.descriptors().map((d) => d.type);
    expect(types.slice(0, 2)).toEqual(["words.shout", "words.count"]);
    expect(types).toHaveLength(2 + kitPack().nodes.length);
    expect(catalog.types.map((x) => x.id)).toEqual(["words.Tone", "words.Stats"]);
  });

  it("an empty catalog works", () => {
    const catalog = createCatalog([]);
    expect(catalog.descriptors()).toEqual([]);
    expect(catalog.types).toEqual([]);
  });

  it("same pack name twice → catalog.duplicate_pack", () => {
    expectBriarError(() => createCatalog(duplicatePackPair()), "catalog.duplicate_pack", CatalogError);
  });

  it("two packs claiming one namespace → catalog.namespace_conflict", () => {
    expectBriarError(() => createCatalog(namespaceConflictPair()), "catalog.namespace_conflict", CatalogError);
  });

  it("a pack claiming another pack's name as namespace → catalog.namespace_conflict", () => {
    const thief = definePack({ name: "thief", version: "1.0.0", namespaces: ["words"], nodes: [] });
    expectBriarError(() => createCatalog([wordsPack(), thief]), "catalog.namespace_conflict", CatalogError);
  });
});

describe("toNodeDescriptor", () => {
  it("matches the JSON shape of node-api.md §7 (words.shout)", () => {
    const pack = wordsPack();
    const shout = pack.nodes.find((n) => n.type === "words.shout")!;
    const d = toNodeDescriptor(shout, pack);
    expect(d).toMatchObject({
      type: "words.shout",
      pack: { name: "words", version: "0.1.0" },
      title: "Shout",
      description: "Uppercases text and adds exclamation marks.",
      category: "Words",
      icon: null,
      color: null,
      config: [],
      dynamicPorts: false,
      secrets: [],
      cache: true,
      timeoutMs: 300_000,
      retry: { maxAttempts: 1 },
      concurrency: null,
      deprecated: null,
    });
    expect(d.inputs.map((p) => p.name)).toEqual(["text", "marks"]);
    expect(d.inputs[0]).toMatchObject({ name: "text", type: { kind: "primitive", name: "text" }, title: "Text" });
    expect("default" in d.inputs[0]!).toBe(false);
    expect(d.inputs[1]).toMatchObject({
      name: "marks",
      type: { kind: "primitive", name: "int", constraints: { min: 0, max: 10 } },
      title: "Marks",
      description: "How many ! to add.",
      default: 1,
    });
    expect(d.outputs).toEqual([expect.objectContaining({ name: "text", type: { kind: "primitive", name: "text" }, title: "Text" })]);
  });

  it("keeps a null default (present, not omitted)", () => {
    const def = defineNode({ type: "demo.n", inputs: { seed: { type: t.optional(t.int()), default: null } }, run: () => ({}) });
    const d = toNodeDescriptor(any(def), { name: "demo", version: "1.0.0" });
    expect(d.inputs[0]).toHaveProperty("default", null);
  });

  it("describes config fields and dynamic ports (text.template)", () => {
    const pack = briarTestPack();
    const d = toNodeDescriptor(pack.nodes.find((n) => n.type === "text.template")!, pack);
    expect(d.dynamicPorts).toBe(true);
    expect(d.config).toEqual([expect.objectContaining({ name: "template", kind: "text", required: true, multiline: true, title: "Template" })]);
    expect(d.pack).toEqual({ name: "briar", version: "1.0.0-test" });
  });

  it("describes every config kind (kit.configured)", () => {
    const pack = kitPack();
    const d = toNodeDescriptor(pack.nodes.find((n) => n.type === "kit.configured")!, pack);
    expect(d.config.map((c) => c.name)).toEqual(["count", "mode", "label", "flag"]);
    expect(d.config[0]).toMatchObject({ kind: "int", required: false, default: 1, min: 0, max: 3 });
    expect(d.config[1]).toMatchObject({ kind: "choice", choices: ["a", "b"], default: "a" });
    expect(d.config[2]).toMatchObject({ kind: "text", required: false });
    expect(d.config[2]).not.toHaveProperty("default");
  });

  it("survives a JSON round-trip unchanged for every test node", () => {
    for (const pack of [briarTestPack(), kitPack(), wordsPack()]) {
      for (const def of pack.nodes) {
        const d: NodeDescriptor = toNodeDescriptor(def, pack);
        expect(JSON.parse(JSON.stringify(d))).toEqual(d);
        expect(d).not.toHaveProperty("run");
        expect(d).not.toHaveProperty("resolvePorts");
      }
    }
  });

  it("catalog descriptors equal toNodeDescriptor", () => {
    const catalog = testCatalog();
    const pack = briarTestPack();
    expect(catalog.descriptors()[0]).toEqual(toNodeDescriptor(pack.nodes[0]!, pack));
  });
});
