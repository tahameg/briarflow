import {
  cfg,
  createCatalog,
  createContextDocument,
  createFlowDocument,
  createSequentialIdGenerator,
  defineNode,
  definePack,
  t,
  type ContextDocument,
  type FlowDocument,
  type NodeInstance,
  type Edge,
} from "@briarflow/core";

const passthrough = () => ({}) as never;

export const structBreak = defineNode({
  type: "briar.struct.break",
  config: { typeId: cfg.typeId({ kind: "struct" }) },
  inputs: {},
  outputs: {},
  resolvePorts({ config, scope }) {
    const decl = scope.resolveType(config.typeId);
    if (!decl || decl.kind !== "struct") return { error: { code: "config.unknown_ref", message: "Pick a struct type." } };
    return {
      inputs: { value: t.fromRef({ kind: "named", id: decl.id }) },
      outputs: Object.fromEntries(decl.fields.map((f) => [f.name, t.fromRef(f.type)])),
    };
  },
  run: passthrough,
});

export const textTemplate = defineNode({
  type: "text.template",
  config: { template: cfg.text({ multiline: true }) },
  outputs: { text: t.text() },
  resolvePorts({ config }) {
    const names = [...new Set([...config.template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1] as string))];
    return {
      inputs: Object.fromEntries(names.map((n, i) => [n, t.var(`T${i + 1}`)])),
      outputs: { text: t.text() },
    };
  },
  run: () => ({ text: "" }),
});

export const listGet = defineNode({
  type: "list.get",
  inputs: { list: t.list(t.var("T")), index: { type: t.int(), default: 0 } },
  outputs: { item: t.optional(t.var("T")) },
  run: () => ({}),
});

const varNode = (type: string, write: boolean, key: "variableId" | "globalId") =>
  defineNode({
    type,
    config: { [key]: key === "variableId" ? cfg.flowVariable() : cfg.global({ writable: write }) },
    outputs: {},
    resolvePorts: ({ config, scope }) => {
      const id = (config as Record<string, string>)[key];
      const v = key === "variableId" ? scope.flow.variables.find((x) => x.id === id) : scope.globals.find((x) => x.id === id);
      if (!v) return { error: { code: "variable.unknown", message: "missing" } };
      return write ? { inputs: { value: t.fromRef(v.type) }, outputs: { value: t.fromRef(v.type) } } : { outputs: { value: t.fromRef(v.type) } };
    },
    run: passthrough,
  });

export const toText = defineNode({ type: "convert.toText", inputs: { value: t.var("T") }, outputs: { text: t.text() }, run: () => ({ text: "" }) });
export const add1 = defineNode({ type: "briar.add1", inputs: { value: t.int() }, outputs: { value: t.int() }, run: () => ({ value: 1 }) });

export const briarPack = definePack({
  name: "briar",
  version: "1.0.0",
  namespaces: ["text", "list", "convert"],
  nodes: [
    structBreak,
    textTemplate,
    listGet,
    toText,
    add1,
    varNode("briar.variable.get", false, "variableId"),
    varNode("briar.variable.set", true, "variableId"),
    varNode("briar.global.get", false, "globalId"),
    varNode("briar.global.set", true, "globalId"),
  ],
});

export const catalog = createCatalog([briarPack]);

export function emptyContext(): ContextDocument {
  const ids = createSequentialIdGenerator();
  return createContextDocument({ name: "Test", id: "ctx_t", idGenerator: ids, clock: () => new Date("2026-01-01T00:00:00Z") });
}

export function node(id: string, type: string, extra: Partial<NodeInstance> = {}): NodeInstance {
  return { id, type, position: { x: 0, y: 0 }, ...extra };
}

export function edge(id: string, from: string, fromPort: string, to: string, toPort: string): Edge {
  return { id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

/** Portrait context of phase-1.md §6. */
export function portraitContext(): ContextDocument {
  const doc = emptyContext();
  const flow: FlowDocument = {
    ...createFlowDocument({ name: "Portrait", id: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out" }),
    inputs: [{ name: "character", type: { kind: "named", id: "ty_char" } }],
    outputs: [{ name: "prompt", type: { kind: "primitive", name: "text" } }],
  };
  return {
    ...doc,
    types: [
      { kind: "enum", id: "ty_style", name: "ArtStyle", members: [{ value: "anime" }, { value: "pixel", label: "Pixel art" }] },
      {
        kind: "struct",
        id: "ty_char",
        name: "Character",
        fields: [
          { name: "name", type: { kind: "primitive", name: "text" } },
          { name: "age", type: { kind: "primitive", name: "int", constraints: { min: 0 } }, default: 30 },
          { name: "style", type: { kind: "named", id: "ty_style" } },
          { name: "nickname", type: { kind: "optional", of: { kind: "primitive", name: "text" } } },
        ],
      },
    ],
    flows: [
      {
        ...flow,
        nodes: [
          ...flow.nodes,
          node("n_brk", "briar.struct.break", { config: { typeId: "ty_char" } }),
          node("n_tpl", "text.template", { config: { template: "Draw {name} in {style} style" } }),
        ],
        edges: [
          edge("e_1", "n_in", "character", "n_brk", "value"),
          edge("e_2", "n_brk", "name", "n_tpl", "name"),
          edge("e_3", "n_brk", "style", "n_tpl", "style"),
          edge("e_4", "n_tpl", "text", "n_out", "prompt"),
        ],
      },
    ],
  };
}

export function withFlow(doc: ContextDocument, change: (f: FlowDocument) => FlowDocument): ContextDocument {
  return { ...doc, flows: doc.flows.map((f) => (f.id === "flow_p" ? change(f) : f)) };
}
