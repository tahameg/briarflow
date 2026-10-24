import { describe, expect, it } from "vitest";
import {
  bindTypeVars,
  computeVariableOrder,
  createCatalog,
  decodeCursor,
  defineEnum,
  defineNode,
  definePack,
  defineStruct,
  deserializeContext,
  encodeCursor,
  flowSignatureSchema,
  resolveFlowPorts,
  serializeContext,
  t,
  toNodeDescriptor,
  validateContext,
  validateFlow,
  type ContextDocument,
  type Diagnostic,
  type MediaStore,
  type TypeRef,
} from "@briarflow/core";
import { briarPack, catalog, edge, node, portraitContext, withFlow } from "./fixtures.js";

const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);
const text: TypeRef = { kind: "primitive", name: "text" };
const int: TypeRef = { kind: "primitive", name: "int" };

describe("defineNode / definePack / catalog / descriptors", () => {
  it("applies defaults", () => {
    const def = defineNode({
      type: "openai.chatCompletion",
      inputs: { maxTokens: { type: t.int(), default: 5 } },
      outputs: { text: t.text() },
      retry: 2,
      run: () => ({ text: "" }),
    });
    expect(def.title).toBe("Chat completion");
    expect(def.category).toBe("Openai");
    expect(def.retry).toEqual({ maxAttempts: 3 });
    expect(def.timeoutMs).toBe(300_000);
    const d = toNodeDescriptor(def, { name: "openai", version: "1.0.0" });
    expect(d.inputs[0]).toEqual({ name: "maxTokens", type: int, title: "Max tokens", default: 5, widget: null });
    expect(d.outputs[0]).toEqual({ name: "text", type: text, title: "Text" });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it("rejects bad definitions", () => {
    const run = () => ({});
    expect(() => defineNode({ type: "Bad", run })).toThrow(/type must look like/);
    expect(() => defineNode({ type: "a.b", inputs: { "1x": t.text() }, run })).toThrow(/not a valid port name/);
    expect(() => defineNode({ type: "a.b", inputs: { n: { type: t.int({ min: 0 }), default: -1 } }, run })).toThrow(/invalid default/);
    expect(() => defineNode({ type: "a.b", outputs: { n: { type: t.int(), default: 1 } }, run: () => ({ n: 1 }) })).toThrow(/output ports cannot/);
    expect(() => defineNode({ type: "a.b", config: { m: cfg_choice() }, run })).toThrow(/not one of the choices/);
  });

  it("qualifies pack types and refs", () => {
    const Tone = defineEnum("Tone", ["calm", "angry"]);
    const Stats = defineStruct("Stats", { tone: t.ref(Tone), words: { type: t.int(), default: 0 } });
    const n = defineNode({ type: "words.count", outputs: { stats: t.ref(Stats) }, run: () => ({ stats: { tone: "calm", words: 1 } }) });
    const pack = definePack({ name: "words", version: "0.1.0", types: [Tone, Stats], nodes: [n] });
    expect(pack.types.map((x) => x.id)).toEqual(["words.Tone", "words.Stats"]);
    const stats = pack.types[1];
    expect(stats?.kind === "struct" && stats.fields[0]?.type).toEqual({ kind: "named", id: "words.Tone" });
    expect(toNodeDescriptor(pack.nodes[0]!, pack).outputs[0]?.type).toEqual({ kind: "named", id: "words.Stats" });
    expect(() => definePack({ name: "words", version: "0.1.0", nodes: [n] })).toThrow(/not a type of this pack/);
    expect(() => definePack({ name: "other", version: "0.1.0", types: [Tone, Stats], nodes: [n] })).toThrow(/outside this pack's namespaces/);
    expect(() => createCatalog([pack, pack])).toThrow(expect.objectContaining({ code: "catalog.duplicate_pack" }));
    const p2 = definePack({ name: "x", version: "1.0.0", namespaces: ["words"], nodes: [] });
    expect(() => createCatalog([pack, p2])).toThrow(expect.objectContaining({ code: "catalog.namespace_conflict" }));
  });
});

function cfg_choice() {
  return { kind: "choice", required: false, choices: ["a"], default: "b" } as never;
}

describe("serialization", () => {
  it("round-trips deterministically", () => {
    const doc = portraitContext();
    const s = serializeContext(doc);
    expect(s.endsWith("}\n")).toBe(true);
    expect(deserializeContext(s)).toEqual(doc);
    const reordered = JSON.parse(JSON.stringify(doc, Object.keys(doc).reverse()));
    expect(serializeContext({ ...reordered, ...doc })).toBe(s);
  });

  it("reports format errors with paths", () => {
    const doc = JSON.parse(serializeContext(portraitContext()));
    doc.flows[0].nodes[2].position.x = "a";
    expect(() => deserializeContext(doc)).toThrow(expect.objectContaining({ code: "format.invalid", details: { path: "flows[0].nodes[2].position.x" } }));
    expect(() => deserializeContext("{")).toThrow(expect.objectContaining({ code: "format.invalid" }));
    expect(() => deserializeContext({ ...portraitContext(), formatVersion: 2 })).toThrow(expect.objectContaining({ code: "format.unsupported_version" }));
  });
});

describe("validation", () => {
  it("portrait context is valid and binds template generics", () => {
    const doc = portraitContext();
    expect(validateContext(doc, catalog)).toEqual([]);
    const ports = resolveFlowPorts(doc, "flow_p", catalog);
    const tpl = ports.nodes.get("n_tpl");
    expect(tpl?.inputs.map((p) => p.name)).toEqual(["name", "style"]);
    expect(tpl?.typeBindings).toEqual({ T1: text, T2: { kind: "named", id: "ty_style" } });
  });

  it("reports edge mismatches, unconnected inputs/outputs and cycles", () => {
    const doc = withFlow(portraitContext(), (f) => ({
      ...f,
      outputs: [{ name: "prompt", type: int }],
      nodes: [...f.nodes, node("n_add", "briar.add1"), node("n_add2", "briar.add1")],
      edges: [...f.edges, edge("e_5", "n_add", "value", "n_add2", "value"), edge("e_6", "n_add2", "value", "n_add", "value")],
    }));
    const ds = validateFlow(doc, "flow_p", catalog);
    expect(codes(ds)).toContain("edge.type_mismatch");
    expect(ds.find((d) => d.code === "edge.type_mismatch")?.message).toContain("Template (n_tpl).text (text) to Output (n_out).prompt (int)");
    expect(ds.find((d) => d.code === "flow.cycle")?.message).toContain("Add1 (n_add) → Add1 (n_add2) → Add1 (n_add)");
  });

  it("reports generic conflicts and unbound generics", () => {
    const doc = withFlow(portraitContext(), (f) => ({
      ...f,
      nodes: [...f.nodes, node("n_get", "list.get")],
    }));
    const ds = validateFlow(doc, "flow_p", catalog);
    expect(ds.filter((d) => d.code === "node.generic_unbound").map((d) => d.path)).toEqual([{ flowId: "flow_p", nodeId: "n_get", port: "list" }]);
    expect(bindTypeVars([
      { port: "a", direction: "input", pattern: { kind: "var", name: "T" }, other: text },
      { port: "b", direction: "input", pattern: { kind: "var", name: "T" }, other: int },
    ])).toMatchObject({ ok: false, conflict: { varName: "T" } });
  });

  it("orders variables (examples A-D)", () => {
    const base = withFlow(portraitContext(), (f) => ({
      ...f,
      variables: [
        { id: "var_x", name: "x", type: int, access: "private", default: 0 },
        { id: "var_y", name: "y", type: int, access: "private" },
      ],
      nodes: [
        ...f.nodes,
        node("n_gx", "briar.variable.get", { config: { variableId: "var_x" } }),
        node("n_sy", "briar.variable.set", { config: { variableId: "var_y" } }),
        node("n_gy", "briar.variable.get", { config: { variableId: "var_y" } }),
        node("n_sx", "briar.variable.set", { config: { variableId: "var_x" } }),
      ],
      edges: [...f.edges, edge("e_a", "n_gx", "value", "n_sy", "value"), edge("e_b", "n_gy", "value", "n_sx", "value")],
    }));
    const order = computeVariableOrder(base, "flow_p", catalog);
    expect(order.implicitEdges).toEqual([
      { from: "n_sx", to: "n_gx", variable: { kind: "flow", variableId: "var_x" } },
      { from: "n_sy", to: "n_gy", variable: { kind: "flow", variableId: "var_y" } },
    ]);
    expect(codes(order.diagnostics)).toEqual(["flow.cycle"]);
    expect(order.diagnostics[0]?.message).toContain("⇢ (writes var");
  });

  it("checks global types, visibility and globals", () => {
    const doc: ContextDocument = {
      ...portraitContext(),
      types: [...portraitContext().types, { kind: "struct", id: "ty_loop", name: "Loop", fields: [{ name: "next", type: { kind: "list", of: { kind: "named", id: "ty_loop" } } }] }],
      globals: [{ id: "gv_1", name: "brand", type: text, access: "readonly" }],
    };
    expect(codes(validateContext(doc, catalog))).toEqual(["type.recursive", "global.readonly_requires_value"]);
  });

  it("builds signature schemas", () => {
    const s = flowSignatureSchema(portraitContext(), "flow_p", catalog);
    expect(s.inputs["required"]).toEqual(["character"]);
    expect(Object.keys(s.inputs["$defs"] as object)).toEqual(["ArtStyle", "Character"]);
  });

  it("throws flow.not_found", () => {
    expect(() => validateFlow(portraitContext(), "flow_x", catalog)).toThrow(expect.objectContaining({ code: "flow.not_found" }));
  });
  void briarPack;
});

describe("cursors", () => {
  it("round-trips cursors", () => {
    const c = encodeCursor({ updatedAt: "2026-01-01T00:00:00.000Z", id: "ctx_ü", search: "mark" });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, " mark ")).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z", id: "ctx_ü", search: "mark" });
    expect(() => decodeCursor(c, "other")).toThrow(expect.objectContaining({ code: "store.invalid_cursor" }));
    expect(() => decodeCursor("!!")).toThrow(expect.objectContaining({ code: "store.invalid_cursor" }));
  });
});

describe("JSON Schema compiles with Ajv 2020", () => {
  it("validates the portrait signature", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false });
    const { inputs } = flowSignatureSchema(portraitContext(), "flow_p", catalog);
    const validate = ajv.compile(inputs);
    expect(validate({ character: { name: "Aria", style: "anime" } })).toBe(true);
    expect(validate({ character: { name: "Aria", style: "Anime" } })).toBe(false);
  });
});
