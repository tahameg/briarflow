/**
 * Test node packs built with the public API (docs/tasks/phase-1.md §6.2).
 *
 * Every pack is created lazily (functions, memoized) so that importing this module never
 * calls `defineNode` / `definePack`: suites that do not need packs still load while those
 * functions are unimplemented.
 */
import {
  cfg,
  createCatalog,
  defineEnum,
  defineNode,
  definePack,
  defineStruct,
  isValidFieldName,
  t,
  type AnyNodeDefinition,
  type NodeCatalog,
  type NodePack,
  type PortError,
  type PortMap,
  type PortOptions,
  type TypeRef,
  type UnknownValue,
} from "@briarflow/core";

function memo<T>(create: () => T): () => T {
  let cached: { value: T } | undefined;
  return () => {
    cached ??= { value: create() };
    return cached.value;
  };
}

function unknownRef(kind: string, id: string): PortError {
  return { error: { code: "config.unknown_ref", message: `${kind} "${id}" does not exist in this flow.` } };
}

function portFromRef(type: TypeRef, extra: { description?: string; default?: unknown } = {}): PortOptions {
  const port: PortOptions = { type: t.fromRef(type) };
  if (extra.description !== undefined) port.description = extra.description;
  if (extra.default !== undefined) port.default = extra.default as UnknownValue;
  return port;
}

/**
 * Placeholders of a `text.template` template in order of first appearance (node-api.md §9):
 * `{name}` is a placeholder, `{{` / `}}` are literal braces. Returns a `PortError` for an
 * unclosed brace or an invalid placeholder name.
 */
export function templatePlaceholders(template: string): string[] | PortError {
  const names: string[] = [];
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{" && template[i + 1] === "{") {
      i += 2;
      continue;
    }
    if (ch === "}" && template[i + 1] === "}") {
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i + 1);
      if (end < 0) return { error: { code: "text.invalid_template", message: `Unclosed "{" at position ${i}.` } };
      const name = template.slice(i + 1, end);
      if (!isValidFieldName(name)) {
        return {
          error: {
            code: "text.invalid_placeholder",
            message: `"{${name}}" is not a valid placeholder. Use letters, digits and _; start with a letter or _.`,
          },
        };
      }
      if (!names.includes(name)) names.push(name);
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return names;
}

// ---------------------------------------------------------------------------------------------
// briar test pack: stands in for @briarflow/nodes-std until phase 3
// ---------------------------------------------------------------------------------------------

function createBriarTestPack(): NodePack {
  const RoundingMode = defineEnum("RoundingMode", ["round", "floor", "ceil", "trunc"]);

  const variableGet = defineNode({
    type: "briar.variable.get",
    title: "Get variable",
    category: "Variables",
    cache: false,
    config: { variableId: cfg.flowVariable({ title: "Variable" }) },
    outputs: { value: t.var("V") },
    resolvePorts({ config, scope }) {
      const variable = scope.flow.variables.find((v) => v.id === config.variableId);
      if (!variable) return unknownRef("Variable", config.variableId);
      return { outputs: { value: t.fromRef(variable.type) } };
    },
    run: () => ({}),
  });

  const variableSet = defineNode({
    type: "briar.variable.set",
    title: "Set variable",
    category: "Variables",
    cache: false,
    config: { variableId: cfg.flowVariable({ title: "Variable" }) },
    inputs: { value: t.var("V") },
    outputs: { value: t.var("V") },
    resolvePorts({ config, scope }) {
      const variable = scope.flow.variables.find((v) => v.id === config.variableId);
      if (!variable) return unknownRef("Variable", config.variableId);
      return { inputs: { value: t.fromRef(variable.type) }, outputs: { value: t.fromRef(variable.type) } };
    },
    run: ({ inputs }) => ({ value: inputs.value }),
  });

  const globalGet = defineNode({
    type: "briar.global.get",
    title: "Get global",
    category: "Variables",
    cache: false,
    config: { globalId: cfg.global({ title: "Global" }) },
    outputs: { value: t.var("G") },
    resolvePorts({ config, scope }) {
      const global = scope.globals.find((g) => g.id === config.globalId);
      if (!global) return unknownRef("Global", config.globalId);
      return { outputs: { value: t.fromRef(global.type) } };
    },
    run: () => ({}),
  });

  const globalSet = defineNode({
    type: "briar.global.set",
    title: "Set global",
    category: "Variables",
    cache: false,
    config: { globalId: cfg.global({ title: "Global", writable: true }) },
    inputs: { value: t.var("G") },
    outputs: { value: t.var("G") },
    resolvePorts({ config, scope }) {
      const global = scope.globals.find((g) => g.id === config.globalId);
      if (!global) return unknownRef("Global", config.globalId);
      return { inputs: { value: t.fromRef(global.type) }, outputs: { value: t.fromRef(global.type) } };
    },
    run: ({ inputs }) => ({ value: inputs.value }),
  });

  const structMake = defineNode({
    type: "briar.struct.make",
    title: "Make struct",
    category: "Data",
    config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }) },
    outputs: { value: t.var("S") },
    resolvePorts({ config, scope }) {
      const decl = scope.resolveType(config.typeId);
      if (!decl || decl.kind !== "struct") return unknownRef("Struct", config.typeId);
      const inputs: PortMap = {};
      for (const f of decl.fields) {
        const extra: { description?: string; default?: unknown } = {};
        if (f.description !== undefined) extra.description = f.description;
        if (f.default !== undefined) extra.default = f.default;
        inputs[f.name] = portFromRef(f.type, extra);
      }
      return { inputs, outputs: { value: t.fromRef({ kind: "named", id: decl.id }) } };
    },
    run: ({ inputs }) => ({ value: { ...inputs } }),
  });

  const structBreak = defineNode({
    type: "briar.struct.break",
    title: "Break struct",
    category: "Data",
    config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }) },
    inputs: { value: t.var("S") },
    resolvePorts({ config, scope }) {
      const decl = scope.resolveType(config.typeId);
      if (!decl || decl.kind !== "struct") return unknownRef("Struct", config.typeId);
      const outputs: PortMap = {};
      for (const f of decl.fields) outputs[f.name] = portFromRef(f.type, f.description === undefined ? {} : { description: f.description });
      return { inputs: { value: t.fromRef({ kind: "named", id: decl.id }) }, outputs };
    },
    run: ({ inputs }) => ({ ...(inputs.value as Record<string, UnknownValue>) }),
  });

  const constant = defineNode({
    type: "briar.constant",
    title: "Constant",
    category: "Data",
    config: { type: cfg.type({ title: "Type" }) },
    inputs: { value: t.var("V") },
    outputs: { value: t.var("V") },
    resolvePorts({ config }) {
      return { inputs: { value: t.fromRef(config.type) }, outputs: { value: t.fromRef(config.type) } };
    },
    run: ({ inputs }) => ({ value: inputs.value }),
  });

  const template = defineNode({
    type: "text.template",
    title: "Text template",
    category: "Text",
    config: { template: cfg.text({ multiline: true, title: "Template" }) },
    outputs: { text: t.text() },
    resolvePorts({ config }) {
      const names = templatePlaceholders(config.template);
      if (!Array.isArray(names)) return names;
      const inputs: PortMap = {};
      names.forEach((name, i) => {
        inputs[name] = t.var(`T${i + 1}`);
      });
      return { inputs, outputs: { text: t.text() } };
    },
    run: ({ config }) => ({ text: config.template }),
  });

  const join = defineNode({
    type: "text.join",
    title: "Join text",
    inputs: { items: t.list(t.text()), separator: { type: t.text(), default: "" } },
    outputs: { text: t.text() },
    run: ({ inputs }) => ({ text: inputs.items.join(inputs.separator) }),
  });

  const listGet = defineNode({
    type: "list.get",
    title: "Get item",
    inputs: { list: t.list(t.var("T")), index: t.int() },
    outputs: { item: t.optional(t.var("T")) },
    run: ({ inputs }) => ({ item: inputs.list.at(inputs.index) ?? null }),
  });

  const toText = defineNode({
    type: "convert.toText",
    title: "To text",
    inputs: { value: t.var("T") },
    outputs: { text: t.text() },
    run: ({ inputs }) => ({ text: typeof inputs.value === "string" ? inputs.value : JSON.stringify(inputs.value) }),
  });

  const floatToInt = defineNode({
    type: "convert.floatToInt",
    title: "Float to int",
    inputs: { value: t.float(), mode: { type: t.ref(RoundingMode), default: "round" } },
    outputs: { value: t.int() },
    run: ({ inputs }) => ({ value: Math.round(inputs.value) }),
  });

  const nodes: AnyNodeDefinition[] = [
    variableGet,
    variableSet,
    globalGet,
    globalSet,
    structMake,
    structBreak,
    constant,
    template,
    join,
    listGet,
    toText,
    floatToInt,
  ] as unknown as AnyNodeDefinition[];

  return definePack({
    name: "briar",
    version: "1.0.0-test",
    title: "Briar (test stand-in)",
    description: "Port-level stand-in for @briarflow/nodes-std used by core tests.",
    namespaces: ["text", "list", "convert"],
    types: [RoundingMode],
    nodes,
  });
}

/** Pack `briar` (namespaces `text`, `list`, `convert`) standing in for nodes-std. */
export const briarTestPack: () => NodePack = memo(createBriarTestPack);

// ---------------------------------------------------------------------------------------------
// kit pack: tiny sources/sinks used to build validation fixtures
// ---------------------------------------------------------------------------------------------

function createKitPack(): NodePack {
  const nodes = [
    defineNode({ type: "kit.textSource", outputs: { text: t.text() }, run: () => ({ text: "a" }) }),
    defineNode({ type: "kit.intSource", outputs: { value: t.int() }, run: () => ({ value: 1 }) }),
    defineNode({ type: "kit.floatSource", outputs: { value: t.float() }, run: () => ({ value: 1.5 }) }),
    defineNode({ type: "kit.textListSource", outputs: { list: t.list(t.text()) }, run: () => ({ list: ["a"] }) }),
    defineNode({ type: "kit.intListSource", outputs: { list: t.list(t.int()) }, run: () => ({ list: [1] }) }),
    defineNode({
      type: "kit.imageSource",
      outputs: { image: t.image() },
      run: () => ({ image: { uri: "briar-media://m_kit", mime: "image/png" } }),
    }),
    defineNode({
      type: "kit.passText",
      inputs: { value: t.text() },
      outputs: { value: t.text() },
      run: ({ inputs }) => ({ value: inputs.value }),
    }),
    defineNode({
      type: "kit.addOne",
      inputs: { value: t.int() },
      outputs: { value: t.int() },
      run: ({ inputs }) => ({ value: inputs.value + 1 }),
    }),
    defineNode({
      type: "kit.same",
      inputs: { a: t.var("T"), b: t.var("T") },
      outputs: { out: t.var("T") },
      run: ({ inputs }) => ({ out: inputs.a }),
    }),
    defineNode({ type: "kit.sinkText", inputs: { value: t.text() }, run: () => ({}) }),
    defineNode({ type: "kit.sinkInt", inputs: { value: t.int() }, run: () => ({}) }),
    defineNode({ type: "kit.sinkOptional", inputs: { value: t.optional(t.text()) }, run: () => ({}) }),
    defineNode({ type: "kit.sinkDefault", inputs: { value: { type: t.text(), default: "x" } }, run: () => ({}) }),
    defineNode({ type: "kit.sinkConstrained", inputs: { value: t.int({ min: 0, max: 10 }) }, run: () => ({}) }),
    defineNode({
      type: "kit.configured",
      config: {
        count: cfg.int({ min: 0, max: 3, default: 1 }),
        mode: cfg.choice(["a", "b"], { default: "a" }),
        label: cfg.text({ optional: true }),
        flag: cfg.boolean({ default: false }),
      },
      outputs: { text: t.text() },
      run: ({ config }) => ({ text: `${config.mode}${config.count}` }),
    }),
  ] as unknown as AnyNodeDefinition[];

  return definePack({ name: "kit", version: "0.0.1", title: "Test kit", nodes });
}

/** Pack `kit`: sources, sinks and generic helpers for validation fixtures. */
export const kitPack: () => NodePack = memo(createKitPack);

/** Catalog of {@link briarTestPack} and {@link kitPack}. */
export const testCatalog: () => NodeCatalog = memo(() => createCatalog([briarTestPack(), kitPack()]));

// ---------------------------------------------------------------------------------------------
// words pack from docs/guides/writing-nodes.md
// ---------------------------------------------------------------------------------------------

function createWordsPack(): NodePack {
  const Tone = defineEnum("Tone", ["calm", "excited", "angry"]);
  const Stats = defineStruct("Stats", {
    words: t.int({ min: 0 }),
    characters: t.int({ min: 0 }),
    tone: t.ref(Tone),
  });

  const shout = defineNode({
    type: "words.shout",
    title: "Shout",
    description: "Uppercases text and adds exclamation marks.",
    inputs: {
      text: t.text(),
      marks: { type: t.int({ min: 0, max: 10 }), default: 1, description: "How many ! to add." },
    },
    outputs: { text: t.text() },
    run: ({ inputs }) => ({ text: inputs.text.toUpperCase() + "!".repeat(inputs.marks) }),
  });

  const count = defineNode({
    type: "words.count",
    title: "Count words",
    inputs: { text: t.text({ multiline: true }) },
    outputs: { stats: t.ref(Stats) },
    run({ inputs }) {
      const words = inputs.text.trim().split(/\s+/).filter(Boolean).length;
      const tone = inputs.text.includes("!") ? "excited" : "calm";
      return { stats: { words, characters: [...inputs.text].length, tone } };
    },
  });

  return definePack({
    name: "words",
    version: "0.1.0",
    title: "Words",
    types: [Tone, Stats],
    nodes: [shout, count] as unknown as AnyNodeDefinition[],
  });
}

/** The `words` pack of the writing-nodes guide (types `words.Tone`, `words.Stats`). */
export const wordsPack: () => NodePack = memo(createWordsPack);

// ---------------------------------------------------------------------------------------------
// Conflicting packs for createCatalog
// ---------------------------------------------------------------------------------------------

function ping(type: string): AnyNodeDefinition {
  return defineNode({ type, outputs: { text: t.text() }, run: () => ({ text: "pong" }) }) as unknown as AnyNodeDefinition;
}

/** Two different packs with the same name `dup` (`catalog.duplicate_pack`). */
export function duplicatePackPair(): [NodePack, NodePack] {
  return [
    definePack({ name: "dup", version: "1.0.0", nodes: [ping("dup.one")] }),
    definePack({ name: "dup", version: "2.0.0", nodes: [ping("dup.two")] }),
  ];
}

/** Two packs that both claim the namespace `shared` (`catalog.namespace_conflict`). */
export function namespaceConflictPair(): [NodePack, NodePack] {
  return [
    definePack({ name: "alpha", version: "1.0.0", namespaces: ["shared"], nodes: [ping("shared.alpha")] }),
    definePack({ name: "beta", version: "1.0.0", namespaces: ["shared"], nodes: [ping("shared.beta")] }),
  ];
}
