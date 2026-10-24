/**
 * Flow/context validation, port resolution, config validation and variable ordering
 * (phase-1.md §5.10; types.md §5, §10–§11; commands.md §1.3, §9; variables.md §4–§5).
 */
import { describe, expect, it } from "vitest";
import {
  computeVariableOrder,
  hasErrors,
  resolveFlowPorts,
  validateContext,
  validateFlow,
  validateNodeConfig,
  type ContextDocument,
  type Diagnostic,
} from "@briarflow/core";
import {
  ART_STYLE_ID,
  CHARACTER_ID,
  KIT_FLOW_ID,
  PORTRAIT_FLOW_ID,
  VARIABLES_FLOW_ID,
  brokenFixtures,
  codes,
  edge,
  editFlow,
  everyTypeContext,
  expectBriarError,
  hasDiagnostic,
  ir,
  kitContext,
  node,
  portraitContext,
  testCatalog,
  variablesContext,
  withCode,
} from "@briarflow/testing";

function describeDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return JSON.stringify(diagnostics.map((d) => ({ code: d.code, severity: d.severity, path: d.path, message: d.message })), null, 1);
}

describe("clean documents", () => {
  it("portraitContext has no diagnostics", () => {
    const diagnostics = validateContext(portraitContext(), testCatalog());
    expect(diagnostics, describeDiagnostics(diagnostics)).toEqual([]);
  });

  it("everyTypeContext has no errors", () => {
    const diagnostics = validateContext(everyTypeContext(), testCatalog());
    expect(hasErrors(diagnostics), describeDiagnostics(diagnostics)).toBe(false);
  });

  it.each(["A", "B"] as const)("variables example %s has no errors", (example) => {
    const diagnostics = validateContext(variablesContext(example), testCatalog());
    expect(hasErrors(diagnostics), describeDiagnostics(diagnostics)).toBe(false);
  });

  it("validation does not mutate the document", () => {
    for (const make of [portraitContext, () => variablesContext("D"), ...brokenFixtures.map((f) => f.doc)]) {
      const doc = make();
      const copy = structuredClone(doc);
      validateContext(doc, testCatalog());
      expect(doc).toEqual(copy);
    }
  });
});

describe("diagnostic codes: positive fixtures", () => {
  it.each(brokenFixtures.map((f) => [`${f.code}: ${f.label}`, f] as const))("%s", (_label, fixture) => {
    const diagnostics = validateContext(fixture.doc(), testCatalog());
    const found = hasDiagnostic(diagnostics, { code: fixture.code, severity: fixture.severity, path: fixture.path });
    expect(found, `expected ${fixture.code} at ${JSON.stringify(fixture.path)} in ${describeDiagnostics(diagnostics)}`).toBe(true);
    const matching = withCode(diagnostics, fixture.code);
    for (const fragment of fixture.messageContains ?? []) {
      expect(matching.some((d) => d.message.includes(fragment)), `message containing ${JSON.stringify(fragment)}`).toBe(true);
    }
    for (const d of diagnostics) {
      expect(d.message.length).toBeGreaterThan(0);
      expect(["error", "warning"]).toContain(d.severity);
    }
  });

  it("every code of phase-1.md §5.10 has a fixture", () => {
    const required = [
      "flow.builtin_missing", "flow.duplicate_id", "edge.unknown_port", "edge.unknown_node", "edge.duplicate_input",
      "type.unknown_id", "type.recursive", "type.duplicate_name", "type.invalid_name", "type.reserved_name",
      "type.shadows_global", "type.enum_empty", "type.invalid_default", "visibility.local_type_in_global",
      "visibility.local_type_in_public_signature", "visibility.local_type_in_public_variable",
      "node.unknown_type", "config.invalid", "config.unknown_ref", "node.ports_unresolved", "node.invalid_value",
      "node.generic_conflict", "node.generic_unbound", "output.unconnected",
      "edge.type_mismatch", "flow.cycle", "variable.unordered_writes", "variable.read_before_write",
      "variable.write_to_readonly", "variable.unknown", "variable.unused", "variable.invalid_default", "global.invalid_value",
    ];
    const covered = new Set(brokenFixtures.map((f) => f.code));
    expect(required.filter((c) => !covered.has(c))).toEqual([]);
  });

  it("validateFlow reports the flow-level findings of a fixture too", () => {
    for (const fixture of brokenFixtures.filter((f) => f.path.flowId !== undefined)) {
      const diagnostics = validateFlow(fixture.doc(), fixture.path.flowId!, testCatalog());
      expect(hasDiagnostic(diagnostics, fixture), `${fixture.label}: ${describeDiagnostics(diagnostics)}`).toBe(true);
    }
  });
});

describe("diagnostic codes: counter-examples", () => {
  const catalog = () => testCatalog();
  const flowCodes = (doc: ContextDocument, flowId = KIT_FLOW_ID) => codes(validateFlow(doc, flowId, catalog()));

  it("an empty input is not an error: it gets its default or the type's empty value at run time", () => {
    const doc = kitContext({
      nodes: [
        node("n_empty", "kit.sinkText", { x: 0, y: 0 }),
        node("n_def", "kit.sinkDefault", { x: 0, y: 100 }),
        node("n_opt", "kit.sinkOptional", { x: 0, y: 200 }),
      ],
    });
    expect(validateFlow(doc, KIT_FLOW_ID, catalog())).toEqual([]);
  });

  it("a connected input is not an error", () => {
    const doc = kitContext({
      nodes: [node("n_t", "kit.textSource", { x: 0, y: 0 }), node("n_s", "kit.sinkText", { x: 200, y: 0 })],
      edges: [edge("e_1", "n_t.text", "n_s.value")],
    });
    expect(validateFlow(doc, KIT_FLOW_ID, catalog())).toEqual([]);
  });

  it("a constant kept on a connected port is ignored", () => {
    const doc = kitContext({
      nodes: [node("n_i", "kit.intSource", { x: 0, y: 0 }), node("n_s", "kit.sinkConstrained", { x: 200, y: 0 }, { values: { value: 50 } })],
      edges: [edge("e_1", "n_i.value", "n_s.value")],
    });
    expect(flowCodes(doc)).not.toContain("node.invalid_value");
  });

  it("int → float edges and X → X? edges are fine", () => {
    const doc = kitContext({
      nodes: [
        node("n_i", "kit.intSource", { x: 0, y: 0 }),
        node("n_f", "convert.floatToInt", { x: 200, y: 0 }),
        node("n_t", "kit.textSource", { x: 0, y: 100 }),
        node("n_o", "kit.sinkOptional", { x: 200, y: 100 }),
      ],
      edges: [edge("e_1", "n_i.value", "n_f.value"), edge("e_2", "n_t.text", "n_o.value")],
    });
    expect(validateFlow(doc, KIT_FLOW_ID, catalog())).toEqual([]);
  });

  it("generic nodes bound by their inputs have no generic diagnostics", () => {
    const doc = kitContext({
      nodes: [
        node("n_i", "kit.intSource", { x: 0, y: 0 }),
        node("n_f", "kit.floatSource", { x: 0, y: 100 }),
        node("n_same", "kit.same", { x: 200, y: 0 }),
        node("n_conv", "convert.toText", { x: 400, y: 0 }),
      ],
      edges: [edge("e_1", "n_i.value", "n_same.a"), edge("e_2", "n_f.value", "n_same.b"), edge("e_3", "n_same.out", "n_conv.value")],
    });
    expect(validateFlow(doc, KIT_FLOW_ID, catalog())).toEqual([]);
  });

  it("an unconnected generic output is harmless", () => {
    const doc = kitContext({
      nodes: [node("n_l", "kit.textListSource", { x: 0, y: 0 }), node("n_get", "list.get", { x: 200, y: 0 }, { values: { index: 0 } })],
      edges: [edge("e_1", "n_l.list", "n_get.list")],
    });
    expect(validateFlow(doc, KIT_FLOW_ID, catalog())).toEqual([]);
  });

  it("variable.read_before_write is not raised for optional or list variables, nor with a default", () => {
    for (const type of [ir.optional(ir.text()), ir.list(ir.text())]) {
      const doc = kitContext({
        variables: [{ id: "var_x", name: "x", type, access: "public" }],
        nodes: [node("n_get", "briar.variable.get", { x: 0, y: 0 }, { config: { variableId: "var_x" } })],
      });
      expect(flowCodes(doc)).not.toContain("variable.read_before_write");
    }
    const withDefault = kitContext({
      variables: [{ id: "var_x", name: "x", type: ir.text(), access: "public", default: "d" }],
      nodes: [node("n_get", "briar.variable.get", { x: 0, y: 0 }, { config: { variableId: "var_x" } })],
    });
    expect(flowCodes(withDefault)).not.toContain("variable.read_before_write");
  });

  it("variable.read_before_write is not raised when a writer is ordered before the read", () => {
    const doc = variablesContext("A");
    expect(codes(validateFlow(doc, VARIABLES_FLOW_ID, catalog()))).not.toContain("variable.read_before_write");
  });

  it("readonly globals with a value can be read; readwrite globals can be written", () => {
    const doc = kitContext({
      globals: [
        { id: "gv_ro", name: "brand", type: ir.text(), access: "readonly", value: "Acme" },
        { id: "gv_rw", name: "count", type: ir.int(), access: "readwrite", value: 0 },
      ],
      nodes: [
        node("n_get", "briar.global.get", { x: 0, y: 0 }, { config: { globalId: "gv_ro" } }),
        node("n_sink", "kit.sinkText", { x: 200, y: 0 }),
        node("n_set", "briar.global.set", { x: 0, y: 200 }, { config: { globalId: "gv_rw" }, values: { value: 1 } }),
      ],
      edges: [edge("e_1", "n_get.value", "n_sink.value")],
    });
    expect(validateContext(doc, catalog())).toEqual([]);
  });

  it("variable.unused is a warning for private variables only", () => {
    const doc = kitContext({ variables: [{ id: "var_p", name: "pub", type: ir.text(), access: "public", default: "" }] });
    expect(flowCodes(doc)).not.toContain("variable.unused");
  });

  it("shadowing a global type is only a warning", () => {
    const fixture = brokenFixtures.find((f) => f.code === "type.shadows_global")!;
    expect(hasErrors(validateContext(fixture.doc(), catalog()))).toBe(false);
  });

  it("empty structs are allowed", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (_f, d) => void d.types.push({ kind: "struct", id: "ty_e", name: "Empty", fields: [] }));
    expect(validateContext(doc, catalog())).toEqual([]);
  });

  it("private variables may use local types", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => {
      f.types.push({ kind: "enum", id: "ty_local", name: "Local", members: [{ value: "a" }] });
      f.variables.push({ id: "var_l", name: "loc", type: ir.named("ty_local"), access: "private", default: "a" });
      f.nodes.push(node("n_get", "briar.variable.get", { x: 0, y: 300 }, { config: { variableId: "var_l" } }));
    });
    expect(hasErrors(validateContext(doc, catalog()))).toBe(false);
  });
});

describe("messages", () => {
  it("edge.type_mismatch names both ends and their types", () => {
    const fixture = brokenFixtures.find((f) => f.label.startsWith("flow output retyped"))!;
    const [d] = withCode(validateFlow(fixture.doc(), PORTRAIT_FLOW_ID, testCatalog()), "edge.type_mismatch");
    expect(d!.message).toContain("text");
    expect(d!.message).toContain("image");
    expect(d!.message).toContain("prompt");
  });

  it("flow.cycle names the flow and the nodes on the loop", () => {
    const fixture = brokenFixtures.find((f) => f.label.startsWith("data cycle"))!;
    const [d] = withCode(validateFlow(fixture.doc(), KIT_FLOW_ID, testCatalog()), "flow.cycle");
    expect(d!.message).toContain("Kit");
    expect(d!.message).toContain("n_a");
    expect(d!.message).toContain("n_b");
  });

  it("flow.cycle through implicit edges marks them (variables.md example D)", () => {
    const [d] = withCode(validateFlow(variablesContext("D"), VARIABLES_FLOW_ID, testCatalog()), "flow.cycle");
    expect(d).toBeDefined();
    expect(d!.message).toContain("⇢");
  });

  it("node messages use the node label (title + id)", () => {
    const doc = kitContext({ nodes: [node("n_sink", "kit.sinkText", { x: 0, y: 0 }, { values: { value: 42 } })] });
    const [d] = withCode(validateFlow(doc, KIT_FLOW_ID, testCatalog()), "node.invalid_value");
    expect(d!.message).toContain("n_sink");
    expect(d!.message).toContain(".value");
  });

  it("a node title is used when set", () => {
    const doc = kitContext({ nodes: [node("n_sink", "kit.sinkText", { x: 0, y: 0 }, { title: "My sink", values: { value: 42 } })] });
    const [d] = withCode(validateFlow(doc, KIT_FLOW_ID, testCatalog()), "node.invalid_value");
    expect(d!.message).toContain("My sink");
  });
});

describe("determinism and composition", () => {
  it("same document → identical diagnostic arrays", () => {
    for (const fixture of brokenFixtures) {
      const a = validateContext(fixture.doc(), testCatalog());
      const b = validateContext(fixture.doc(), testCatalog());
      expect(b).toEqual(a);
    }
  });

  it("validateContext = context findings + every flow's validateFlow findings", () => {
    const doc = editFlow(
      editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void (f.edges = f.edges.filter((e) => e.id !== "e_4"))),
      PORTRAIT_FLOW_ID,
      (_f, d) => {
        d.types.push({ kind: "enum", id: "ty_empty", name: "Empty", members: [] });
        d.flows.push(...kitContext({ nodes: [node("n_sink", "kit.sinkText", { x: 0, y: 0 }, { values: { value: 42 } })] }).flows.map((f) => structuredClone(f) as never));
      },
    );
    const all = validateContext(doc, testCatalog());
    const perFlow = doc.flows.flatMap((f) => validateFlow(doc, f.id, testCatalog()));
    for (const d of perFlow) expect(all).toContainEqual(d);
    expect(codes(all)).toContain("type.enum_empty");
    expect(codes(all)).toContain("output.unconnected");
    expect(codes(all)).toContain("node.invalid_value");
    expect(all.length).toBe(perFlow.length + withCode(all, "type.enum_empty").length);
  });

  it("two flows with the same name (ignoring case) are reported", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (_f, d) => {
      d.flows.push({ ...structuredClone(d.flows[0]!), id: "flow_q", name: "PORTRAIT" });
    });
    expect(hasErrors(validateContext(doc, testCatalog()))).toBe(true);
  });

  it("unknown flow id → flow.not_found", () => {
    const doc = portraitContext();
    expectBriarError(() => validateFlow(doc, "flow_ghost", testCatalog()), "flow.not_found");
    expectBriarError(() => resolveFlowPorts(doc, "flow_ghost", testCatalog()), "flow.not_found");
    expectBriarError(() => computeVariableOrder(doc, "flow_ghost", testCatalog()), "flow.not_found");
  });
});

describe("resolveFlowPorts", () => {
  it("built-in nodes follow the flow signature", () => {
    const ports = resolveFlowPorts(portraitContext(), PORTRAIT_FLOW_ID, testCatalog());
    expect(ports.flowId).toBe(PORTRAIT_FLOW_ID);
    const input = ports.nodes.get("n_in")!;
    expect(input.definition).toBeUndefined();
    expect(input.inputs).toEqual([]);
    expect(input.outputs.map((p) => [p.name, p.type])).toEqual([["character", ir.named(CHARACTER_ID)]]);
    const output = ports.nodes.get("n_out")!;
    expect(output.outputs).toEqual([]);
    expect(output.inputs.map((p) => [p.name, p.type])).toEqual([["prompt", ir.text()]]);
  });

  it("dynamic ports from config (struct.break, text.template) with recomputed bindings", () => {
    const ports = resolveFlowPorts(portraitContext(), PORTRAIT_FLOW_ID, testCatalog());
    const brk = ports.nodes.get("n_brk")!;
    expect(brk.definition?.type).toBe("briar.struct.break");
    expect(brk.inputs.map((p) => p.name)).toEqual(["value"]);
    expect(brk.outputs.map((p) => p.name)).toEqual(["name", "age", "style", "nickname"]);
    expect(brk.outputs[1]!.type).toEqual(ir.int({ min: 0 }));
    expect(brk.diagnostics).toEqual([]);

    const tpl = ports.nodes.get("n_tpl")!;
    expect(tpl.inputs.map((p) => p.name)).toEqual(["name", "style"]);
    expect(tpl.inputs.map((p) => p.declaredType)).toEqual([ir.var("T1"), ir.var("T2")]);
    expect(tpl.inputs.map((p) => p.type)).toEqual([ir.text(), ir.named(ART_STYLE_ID)]);
    expect(tpl.typeBindings).toEqual({ T1: ir.text(), T2: ir.named(ART_STYLE_ID) });
    expect(tpl.outputs.map((p) => [p.name, p.title])).toEqual([["text", "Text"]]);
  });

  it("static ports carry titles, defaults and hasDefault", () => {
    const doc = kitContext({ nodes: [node("n_join", "text.join", { x: 0, y: 0 })] });
    const join = resolveFlowPorts(doc, KIT_FLOW_ID, testCatalog()).nodes.get("n_join")!;
    expect(join.inputs.map((p) => [p.name, p.title, p.hasDefault])).toEqual([
      ["items", "Items", false],
      ["separator", "Separator", true],
    ]);
    expect(join.inputs[1]!.default).toBe("");
  });

  it("bindings ignore stale stored typeBindings and do not depend on edge order", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => {
      f.nodes.find((n) => n.id === "n_tpl")!.typeBindings = { T1: ir.int() };
      f.edges.reverse();
    });
    const tpl = resolveFlowPorts(doc, PORTRAIT_FLOW_ID, testCatalog()).nodes.get("n_tpl")!;
    expect(tpl.typeBindings).toEqual({ T1: ir.text(), T2: ir.named(ART_STYLE_ID) });
  });

  it("removing the last constraining edge unbinds the var", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => void (f.edges = f.edges.filter((e) => e.id !== "e_3")));
    const tpl = resolveFlowPorts(doc, PORTRAIT_FLOW_ID, testCatalog()).nodes.get("n_tpl")!;
    expect(tpl.typeBindings).toEqual({ T1: ir.text() });
    expect(tpl.inputs[1]!.type).toEqual(ir.var("T2"));
  });

  it("binds from output upper bounds (list.get item → optional text sink)", () => {
    const doc = kitContext({
      nodes: [node("n_get", "list.get", { x: 0, y: 0 }), node("n_o", "kit.sinkOptional", { x: 200, y: 0 })],
      edges: [edge("e_1", "n_get.item", "n_o.value")],
    });
    const get = resolveFlowPorts(doc, KIT_FLOW_ID, testCatalog()).nodes.get("n_get")!;
    expect(get.typeBindings).toEqual({ T: ir.text() });
    expect(get.outputs[0]!.type).toEqual(ir.optional(ir.text()));
  });

  it("an edge from an unbound generic neighbour contributes nothing", () => {
    const doc = kitContext({
      nodes: [node("n_same", "kit.same", { x: 0, y: 0 }), node("n_conv", "convert.toText", { x: 200, y: 0 })],
      edges: [edge("e_1", "n_same.out", "n_conv.value")],
    });
    const ports = resolveFlowPorts(doc, KIT_FLOW_ID, testCatalog());
    expect(ports.nodes.get("n_conv")!.typeBindings).toEqual({});
    expect(ports.nodes.get("n_same")!.typeBindings).toEqual({});
  });

  it("generic conflicts become node diagnostics and leave the var unbound", () => {
    const fixture = brokenFixtures.find((f) => f.code === "node.generic_conflict")!;
    const same = resolveFlowPorts(fixture.doc(), KIT_FLOW_ID, testCatalog()).nodes.get("n_same")!;
    expect(codes(same.diagnostics)).toContain("node.generic_conflict");
    expect(same.typeBindings).not.toHaveProperty("T");
  });

  it("problems become diagnostics instead of throwing", () => {
    const doc = editFlow(portraitContext(), PORTRAIT_FLOW_ID, (f) => {
      f.nodes.find((n) => n.id === "n_brk")!.config = { typeId: "ty_ghost" };
      f.nodes.find((n) => n.id === "n_tpl")!.config = { template: "Bad {{1x}}" };
      f.nodes.push(node("n_x", "ghost.node", { x: 0, y: 300 }));
      f.inputs.push({ name: "g", type: ir.named("ty_ghost") });
    });
    const ports = resolveFlowPorts(doc, PORTRAIT_FLOW_ID, testCatalog());
    expect(codes(ports.nodes.get("n_brk")!.diagnostics)).toContain("config.unknown_ref");
    expect(codes(ports.nodes.get("n_tpl")!.diagnostics)).toContain("node.ports_unresolved");
    expect(ports.nodes.get("n_tpl")!.inputs).toEqual([]);
    const ghost = ports.nodes.get("n_x")!;
    expect(ghost.definition).toBeUndefined();
    expect(codes(ghost.diagnostics)).toContain("node.unknown_type");
  });

  it("variable nodes take the variable's type", () => {
    const ports = resolveFlowPorts(variablesContext("B"), VARIABLES_FLOW_ID, testCatalog());
    expect(ports.nodes.get("n_get")!.outputs.map((p) => p.type)).toEqual([ir.int()]);
    expect(ports.nodes.get("n_set")!.inputs.map((p) => p.type)).toEqual([ir.int()]);
  });
});

describe("validateNodeConfig", () => {
  const def = (type: string) => testCatalog().get(type)!;
  const portrait = () => portraitContext();

  it("applies defaults and returns the config", () => {
    const doc = kitContext({});
    expect(validateNodeConfig(def("kit.configured"), {}, doc, KIT_FLOW_ID, testCatalog())).toEqual({
      ok: true,
      config: { count: 1, mode: "a", flag: false },
    });
    expect(validateNodeConfig(def("kit.configured"), undefined, doc, KIT_FLOW_ID, testCatalog())).toMatchObject({ ok: true });
    expect(validateNodeConfig(def("kit.configured"), { count: 3, label: "x" }, doc, KIT_FLOW_ID, testCatalog())).toEqual({
      ok: true,
      config: { count: 3, mode: "a", label: "x", flag: false },
    });
  });

  it.each([
    ["missing required", "text.template", {}],
    ["wrong kind", "text.template", { template: 5 }],
    ["unknown key", "text.template", { template: "x", other: 1 }],
    ["int out of range", "kit.configured", { count: 4 }],
    ["int not whole", "kit.configured", { count: 1.5 }],
    ["choice not in choices", "kit.configured", { mode: "c" }],
    ["boolean of wrong kind", "kit.configured", { flag: "yes" }],
  ])("%s → config.invalid", (_label, type, config) => {
    const result = validateNodeConfig(def(type), config, portrait(), PORTRAIT_FLOW_ID, testCatalog());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.diagnostics)).toContain("config.invalid");
  });

  it("typeId of a missing type or the wrong kind → config.unknown_ref", () => {
    for (const typeId of ["ty_ghost", ART_STYLE_ID]) {
      const result = validateNodeConfig(def("briar.struct.make"), { typeId }, portrait(), PORTRAIT_FLOW_ID, testCatalog());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(codes(result.diagnostics)).toContain("config.unknown_ref");
    }
    expect(validateNodeConfig(def("briar.struct.make"), { typeId: CHARACTER_ID }, portrait(), PORTRAIT_FLOW_ID, testCatalog())).toEqual({
      ok: true,
      config: { typeId: CHARACTER_ID },
    });
  });

  it("missing variable / global → config.unknown_ref", () => {
    const a = validateNodeConfig(def("briar.variable.get"), { variableId: "var_ghost" }, portrait(), PORTRAIT_FLOW_ID, testCatalog());
    const b = validateNodeConfig(def("briar.global.get"), { globalId: "gv_ghost" }, portrait(), PORTRAIT_FLOW_ID, testCatalog());
    for (const r of [a, b]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(codes(r.diagnostics)).toContain("config.unknown_ref");
    }
  });

  it("cfg.type accepts IR and rejects garbage", () => {
    const ok = validateNodeConfig(def("briar.constant"), { type: ir.list(ir.text()) }, portrait(), PORTRAIT_FLOW_ID, testCatalog());
    expect(ok).toEqual({ ok: true, config: { type: ir.list(ir.text()) } });
    const bad = validateNodeConfig(def("briar.constant"), { type: "list<" }, portrait(), PORTRAIT_FLOW_ID, testCatalog());
    expect(bad.ok).toBe(false);
  });

  it("writable global on a readonly global → variable.write_to_readonly", () => {
    const doc = kitContext({ globals: [{ id: "gv_ro", name: "brand", type: ir.text(), access: "readonly", value: "A" }] });
    const result = validateNodeConfig(def("briar.global.set"), { globalId: "gv_ro" }, doc, KIT_FLOW_ID, testCatalog());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.diagnostics)).toContain("variable.write_to_readonly");
    expect(validateNodeConfig(def("briar.global.get"), { globalId: "gv_ro" }, doc, KIT_FLOW_ID, testCatalog()).ok).toBe(true);
  });
});

describe("computeVariableOrder (variables.md §4)", () => {
  it("example A: implicit set ⇢ get; get reads the set", () => {
    const order = computeVariableOrder(variablesContext("A"), VARIABLES_FLOW_ID, testCatalog());
    const variable = { kind: "flow", variableId: "var_summary" };
    expect(order.implicitEdges).toEqual([{ from: "n_set", to: "n_get", variable }]);
    expect(order.plans).toEqual([{ variable, writers: ["n_set"], reads: { n_get: "n_set" } }]);
    expect(order.diagnostics).toEqual([]);
  });

  it("example B: the get is upstream of the set and reads the starting value", () => {
    const order = computeVariableOrder(variablesContext("B"), VARIABLES_FLOW_ID, testCatalog());
    expect(order.implicitEdges).toEqual([]);
    expect(order.plans).toEqual([{ variable: { kind: "flow", variableId: "var_count" }, writers: ["n_set"], reads: { n_get: null } }]);
    expect(order.diagnostics).toEqual([]);
  });

  it("example C: unordered writers", () => {
    const order = computeVariableOrder(variablesContext("C"), VARIABLES_FLOW_ID, testCatalog());
    expect(codes(order.diagnostics)).toContain("variable.unordered_writes");
    const [d] = withCode(order.diagnostics, "variable.unordered_writes");
    expect(d!.message).toContain('"x"');
  });

  it("example D: cycle through implicit edges", () => {
    const order = computeVariableOrder(variablesContext("D"), VARIABLES_FLOW_ID, testCatalog());
    expect(order.implicitEdges).toEqual(
      expect.arrayContaining([
        { from: "n_sety", to: "n_gety", variable: { kind: "flow", variableId: "var_y" } },
        { from: "n_setx", to: "n_getx", variable: { kind: "flow", variableId: "var_x" } },
      ]),
    );
    expect(order.implicitEdges).toHaveLength(2);
    expect(codes(order.diagnostics)).toContain("flow.cycle");
  });

  it("writers are totally ordered by data paths; each get reads the last writer before it", () => {
    // in.a → set1 → (value) → set2 ; get1 upstream of set2 (feeds it via same) ; get2 free
    const doc = kitContext({
      inputs: [{ name: "a", type: ir.text() }],
      variables: [{ id: "var_x", name: "x", type: ir.text(), access: "public", default: "" }],
      nodes: [
        node("n_set1", "briar.variable.set", { x: 100, y: 0 }, { config: { variableId: "var_x" } }),
        node("n_pass", "kit.passText", { x: 200, y: 0 }),
        node("n_set2", "briar.variable.set", { x: 300, y: 0 }, { config: { variableId: "var_x" } }),
        node("n_get_free", "briar.variable.get", { x: 400, y: 100 }, { config: { variableId: "var_x" } }),
      ],
      edges: [
        edge("e_1", "n_in.a", "n_set1.value"),
        edge("e_2", "n_set1.value", "n_pass.value"),
        edge("e_3", "n_pass.value", "n_set2.value"),
      ],
    });
    const order = computeVariableOrder(doc, KIT_FLOW_ID, testCatalog());
    expect(order.diagnostics).toEqual([]);
    expect(order.plans).toEqual([
      { variable: { kind: "flow", variableId: "var_x" }, writers: ["n_set1", "n_set2"], reads: { n_get_free: "n_set2" } },
    ]);
  });

  it("globals get their own plans", () => {
    const doc = kitContext({
      globals: [{ id: "gv_c", name: "count", type: ir.int(), access: "readwrite", value: 0 }],
      nodes: [
        node("n_set", "briar.global.set", { x: 0, y: 0 }, { config: { globalId: "gv_c" }, values: { value: 2 } }),
        node("n_get", "briar.global.get", { x: 200, y: 0 }, { config: { globalId: "gv_c" } }),
      ],
    });
    const order = computeVariableOrder(doc, KIT_FLOW_ID, testCatalog());
    const variable = { kind: "global", globalId: "gv_c" };
    expect(order.implicitEdges).toEqual([{ from: "n_set", to: "n_get", variable }]);
    expect(order.plans).toEqual([{ variable, writers: ["n_set"], reads: { n_get: "n_set" } }]);
  });

  it("result does not depend on node or edge order", () => {
    const doc = variablesContext("A");
    const shuffled = editFlow(doc, VARIABLES_FLOW_ID, (f) => {
      f.nodes.reverse();
      f.edges.reverse();
    });
    const a = computeVariableOrder(doc, VARIABLES_FLOW_ID, testCatalog());
    const b = computeVariableOrder(shuffled, VARIABLES_FLOW_ID, testCatalog());
    expect(b.implicitEdges).toEqual(a.implicitEdges);
    expect(b.plans).toEqual(a.plans);
  });

  it("unknown variable and readonly writes are reported", () => {
    const unknown = brokenFixtures.find((f) => f.code === "variable.unknown")!;
    expect(codes(computeVariableOrder(unknown.doc(), KIT_FLOW_ID, testCatalog()).diagnostics)).toContain("variable.unknown");
    const readonly = brokenFixtures.find((f) => f.code === "variable.write_to_readonly")!;
    expect(codes(computeVariableOrder(readonly.doc(), KIT_FLOW_ID, testCatalog()).diagnostics)).toContain("variable.write_to_readonly");
  });
});
