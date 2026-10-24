/**
 * Sample context documents (docs/tasks/phase-1.md §6.1). Every function returns a fresh,
 * plain `ContextDocument` (no authoring involved), so tests may clone and edit them freely.
 *
 * Node types used here come from {@link briarTestPack} and {@link kitPack}
 * (see `testCatalog()`).
 */
import type { ContextDocument, DiagnosticPath, FlowVariable, GlobalVariable, MediaRef } from "@briarflow/core";
import { context, edge, editContext, editFlow, enumType, field, flow, ir, node, struct } from "./build.js";

// ---------------------------------------------------------------------------------------------
// Portrait (commands.md §10)
// ---------------------------------------------------------------------------------------------

/** Global enum `ArtStyle` (`ty_style`): anime, realistic, pixel. */
export const ART_STYLE_ID = "ty_style";
/** Global struct `Character` (`ty_char`). */
export const CHARACTER_ID = "ty_char";
/** The portrait flow id. */
export const PORTRAIT_FLOW_ID = "flow_p";

/**
 * Valid context: global enum `ArtStyle`, struct `Character { name: text, age: int{min 0} = 30,
 * style: ArtStyle, nickname: text? }`, flow `flow_p` "Portrait" with input `character`, output
 * `prompt`, nodes `n_in`, `n_out`, `n_brk` (`briar.struct.break`), `n_tpl` (`text.template`
 * "Draw {name} in {style} style") and edges `e_1…e_4`.
 */
export function portraitContext(): ContextDocument {
  return context({
    id: "ctx_portrait",
    name: "Portraits",
    description: "Character portraits",
    types: [
      enumType(ART_STYLE_ID, "ArtStyle", [{ value: "anime", label: "Anime" }, "realistic", { value: "pixel", label: "Pixel art" }]),
      struct(CHARACTER_ID, "Character", [
        field("name", ir.text()),
        field("age", ir.int({ min: 0 }), { default: 30 }),
        field("style", ir.named(ART_STYLE_ID)),
        field("nickname", ir.optional(ir.text())),
      ]),
    ],
    flows: [
      flow({
        id: PORTRAIT_FLOW_ID,
        name: "Portrait",
        inputs: [field("character", ir.named(CHARACTER_ID))],
        outputs: [field("prompt", ir.text())],
        nodes: [
          node("n_brk", "briar.struct.break", { x: 200, y: 0 }, { config: { typeId: CHARACTER_ID } }),
          node(
            "n_tpl",
            "text.template",
            { x: 420, y: 0 },
            {
              config: { template: "Draw {{name}} in {{style}} style" },
              typeBindings: { T1: ir.text(), T2: ir.named(ART_STYLE_ID) },
            },
          ),
        ],
        edges: [
          edge("e_1", "n_in.character", "n_brk.value"),
          edge("e_2", "n_brk.name", "n_tpl.name"),
          edge("e_3", "n_brk.style", "n_tpl.style"),
          edge("e_4", "n_tpl.text", "n_out.prompt"),
        ],
      }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Every type
// ---------------------------------------------------------------------------------------------

/** About 1 MB of text with multi-byte characters. */
export function largeText(): string {
  return "Briar ✨ 茨 — ".repeat(1024 * 1024 / 16);
}

/** A valid image value (the entry is not looked up when documents are validated). */
export const SAMPLE_IMAGE_REF: MediaRef = { mediaId: "med_logo" };

/**
 * Valid context exercising every type kind: every primitive (with constraints), lists with
 * bounds, optionals, nested structs, an enum with labels, unicode names/descriptions, and a
 * ~1 MB text constant (on node `n_big`).
 */
export function everyTypeContext(): ContextDocument {
  const mood = enumType("ty_mood", "Mood", [{ value: "calm", label: "Ruhig 😌" }, { value: "gpt-4.1", label: "Model" }, "16x9"]);
  const inner = struct("ty_inner", "Inner", [field("flag", ir.boolean()), field("score", ir.float({ min: 0, max: 1 }))], "Innerer Typ — ünïcødé");
  const outer = struct("ty_outer", "Outer", [
    field("inner", ir.named("ty_inner")),
    field("tags", ir.list(ir.text({ maxLength: 20 }), { minItems: 1, maxItems: 3 })),
    field("maybe", ir.optional(ir.named("ty_inner"))),
    field("moods", ir.list(ir.named("ty_mood"))),
    field("count", ir.int({ min: -5, max: 5 }), { default: 0, description: "数" }),
  ]);
  const globals: GlobalVariable[] = [
    { id: "gv_logo", name: "logo", type: ir.image({ formats: ["png"], maxBytes: 1_000_000 }), access: "readwrite", value: SAMPLE_IMAGE_REF },
    { id: "gv_mood", name: "mood", type: ir.named("ty_mood"), access: "readonly", value: "calm", description: "Stimmung" },
  ];
  return context({
    id: "ctx_every",
    name: "Ünïcødé ✨ 文脈",
    description: "Every type kind — 每种类型",
    types: [mood, inner, outer],
    globals,
    flows: [
      flow({
        id: "flow_every",
        name: "Every type 🌱",
        description: "Signature with every primitive",
        inputs: [
          field("text", ir.text({ minLength: 1, maxLength: 100, pattern: "[\\p{L} ]+", multiline: true })),
          field("int", ir.int({ min: 0, max: 10 }), { default: 5 }),
          field("float", ir.float({ min: -1.5, max: 1.5 })),
          field("boolean", ir.boolean()),
          field("image", ir.image({ formats: ["png", "jpeg"], maxBytes: 5_000_000, minWidth: 1, maxWidth: 4096, minHeight: 1, maxHeight: 4096 })),
          field("video", ir.video({ formats: ["mp4"], maxDurationSec: 60 })),
          field("audio", ir.audio({ formats: ["mp3", "wav"] })),
          field("model", ir.model3d({ formats: ["glb"] })),
          field("file", ir.file({ formats: ["pdf", "application/zip"] })),
          field("images", ir.list(ir.image(), { maxItems: 4 })),
          field("maybeText", ir.optional(ir.text())),
          field("outer", ir.named("ty_outer")),
          field("mood", ir.named("ty_mood"), { default: "calm" }),
        ],
        outputs: [field("summary", ir.text())],
        nodes: [node("n_big", "briar.constant", { x: 200, y: 0 }, { config: { type: ir.text() }, values: { value: largeText() } })],
        edges: [edge("e_big", "n_big.value", "n_out.summary")],
      }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Variables (variables.md §4)
// ---------------------------------------------------------------------------------------------

/** Flow id of every `variablesContext` example. */
export const VARIABLES_FLOW_ID = "flow_v";

/**
 * Examples A–D of variables.md §4 (flow `flow_v`):
 * - A: `input.topic → set(summary)`, `get(summary) → output.summary` (implicit `n_set ⇢ n_get`).
 * - B: `get(count) → add1 → set(count)` (get upstream of set: reads the default).
 * - C: `input.a → set(x)`, `input.b → set(x)` (`variable.unordered_writes`).
 * - D: `get(x) → set(y)`, `get(y) → set(x)` (`flow.cycle` through implicit edges).
 */
export function variablesContext(example: "A" | "B" | "C" | "D"): ContextDocument {
  const variable = (id: string, name: string, access: "public" | "private", def?: unknown): FlowVariable =>
    def === undefined
      ? { id, name, type: ir.text(), access }
      : { id, name, type: ir.text(), access, default: def };
  switch (example) {
    case "A":
      return context({
        id: "ctx_var_a",
        flows: [
          flow({
            id: VARIABLES_FLOW_ID,
            name: "Example A",
            inputs: [field("topic", ir.text())],
            outputs: [field("summary", ir.text())],
            variables: [variable("var_summary", "summary", "private")],
            nodes: [
              node("n_set", "briar.variable.set", { x: 200, y: 0 }, { config: { variableId: "var_summary" } }),
              node("n_get", "briar.variable.get", { x: 400, y: 0 }, { config: { variableId: "var_summary" } }),
            ],
            edges: [edge("e_1", "n_in.topic", "n_set.value"), edge("e_2", "n_get.value", "n_out.summary")],
          }),
        ],
      });
    case "B":
      return context({
        id: "ctx_var_b",
        flows: [
          flow({
            id: VARIABLES_FLOW_ID,
            name: "Example B",
            variables: [{ id: "var_count", name: "count", type: ir.int(), access: "public", default: 0 }],
            nodes: [
              node("n_get", "briar.variable.get", { x: 200, y: 0 }, { config: { variableId: "var_count" } }),
              node("n_add", "kit.addOne", { x: 400, y: 0 }),
              node("n_set", "briar.variable.set", { x: 600, y: 0 }, { config: { variableId: "var_count" } }),
            ],
            edges: [edge("e_1", "n_get.value", "n_add.value"), edge("e_2", "n_add.value", "n_set.value")],
          }),
        ],
      });
    case "C":
      return context({
        id: "ctx_var_c",
        flows: [
          flow({
            id: VARIABLES_FLOW_ID,
            name: "Example C",
            inputs: [field("a", ir.text()), field("b", ir.text())],
            variables: [variable("var_x", "x", "public", "")],
            nodes: [
              node("n_set1", "briar.variable.set", { x: 200, y: 0 }, { config: { variableId: "var_x" } }),
              node("n_set2", "briar.variable.set", { x: 200, y: 200 }, { config: { variableId: "var_x" } }),
            ],
            edges: [edge("e_1", "n_in.a", "n_set1.value"), edge("e_2", "n_in.b", "n_set2.value")],
          }),
        ],
      });
    case "D":
      return context({
        id: "ctx_var_d",
        flows: [
          flow({
            id: VARIABLES_FLOW_ID,
            name: "Example D",
            variables: [variable("var_x", "x", "public", ""), variable("var_y", "y", "public", "")],
            nodes: [
              node("n_getx", "briar.variable.get", { x: 200, y: 0 }, { config: { variableId: "var_x" } }),
              node("n_sety", "briar.variable.set", { x: 400, y: 0 }, { config: { variableId: "var_y" } }),
              node("n_gety", "briar.variable.get", { x: 200, y: 200 }, { config: { variableId: "var_y" } }),
              node("n_setx", "briar.variable.set", { x: 400, y: 200 }, { config: { variableId: "var_x" } }),
            ],
            edges: [edge("e_1", "n_getx.value", "n_sety.value"), edge("e_2", "n_gety.value", "n_setx.value")],
          }),
        ],
      });
  }
}

// ---------------------------------------------------------------------------------------------
// Broken variants: one per diagnostic code (positive fixtures for validation)
// ---------------------------------------------------------------------------------------------

/** A document that must produce a diagnostic. */
export interface BrokenFixture {
  /** Short description, used as the test name. */
  label: string;
  code: string;
  severity: "error" | "warning";
  /** Keys the diagnostic path must contain (others may be present). */
  path: DiagnosticPath;
  doc: () => ContextDocument;
  /** Fragments the message must contain. */
  messageContains?: string[];
}

const P = PORTRAIT_FLOW_ID;

/** Portrait flow plus extra nodes/edges (convenience for broken variants). */
function portraitWith(edit: Parameters<typeof editFlow>[2]): ContextDocument {
  return editFlow(portraitContext(), P, edit);
}

/** A minimal flow `flow_k` with `kit` nodes (no signature). */
export function kitContext(spec: Omit<Parameters<typeof flow>[0], "id" | "name"> & { globals?: GlobalVariable[] }): ContextDocument {
  const { globals, ...rest } = spec;
  return context({ id: "ctx_kit", globals: globals ?? [], flows: [flow({ id: "flow_k", name: "Kit", ...rest })] });
}

/** Flow id of {@link kitContext}. */
export const KIT_FLOW_ID = "flow_k";

const K = KIT_FLOW_ID;

/** One fixture per diagnostic code of phase-1.md §5.10 (several for some codes). */
export const brokenFixtures: readonly BrokenFixture[] = [
  // --- structure ---------------------------------------------------------------------------
  {
    label: "flow without an output node",
    code: "flow.builtin_missing",
    severity: "error",
    path: { flowId: P },
    doc: () =>
      portraitWith((f) => {
        f.nodes = f.nodes.filter((n) => n.id !== "n_out");
        f.edges = f.edges.filter((e) => e.id !== "e_4");
      }),
  },
  {
    label: "flow with two input nodes",
    code: "flow.builtin_missing",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void f.nodes.push(node("n_in2", "briar.input", { x: 0, y: 300 }))),
  },
  {
    label: "duplicate node id",
    code: "flow.duplicate_id",
    severity: "error",
    path: { flowId: P, nodeId: "n_x" },
    doc: () =>
      portraitWith((f) => {
        f.nodes.push(node("n_x", "kit.textSource", { x: 0, y: 300 }));
        f.nodes.push(node("n_x", "kit.textSource", { x: 0, y: 400 }));
      }),
  },
  {
    label: "duplicate edge id",
    code: "flow.duplicate_id",
    severity: "error",
    path: { flowId: P, edgeId: "e_1" },
    doc: () =>
      portraitWith((f) => {
        f.nodes.push(node("n_conv", "convert.toText", { x: 400, y: 300 }));
        f.edges.push(edge("e_1", "n_brk.age", "n_conv.value"));
      }),
  },
  {
    label: "edge from an unknown port",
    code: "edge.unknown_port",
    severity: "error",
    path: { flowId: P, edgeId: "e_4" },
    doc: () => portraitWith((f) => void (f.edges[3]!.from.port = "txt")),
    messageContains: ["txt"],
  },
  {
    label: "edge to an unknown node",
    code: "edge.unknown_node",
    severity: "error",
    path: { flowId: P, edgeId: "e_4" },
    doc: () => portraitWith((f) => void (f.edges[3]!.to.node = "n_ghost")),
  },
  {
    label: "two edges into one input",
    code: "edge.duplicate_input",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void f.edges.push(edge("e_5", "n_brk.name", "n_out.prompt"))),
  },
  // --- types -------------------------------------------------------------------------------
  {
    label: "struct field with an unknown type id",
    code: "type.unknown_id",
    severity: "error",
    path: { typeId: "ty_bad" },
    doc: () => editContext(portraitContext(), (d) => void d.types.push(struct("ty_bad", "Bad", [field("x", ir.named("ty_ghost"))]))),
    messageContains: ["ty_ghost"],
  },
  {
    label: "flow input with an unknown type id",
    code: "type.unknown_id",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void f.inputs.push(field("ghost", ir.named("ty_ghost")))),
  },
  {
    label: "bare (unqualified) name stored as a type id",
    code: "type.unknown_id",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void f.inputs.push(field("bare", ir.named("Character")))),
  },
  {
    label: "struct containing itself directly",
    code: "type.recursive",
    severity: "error",
    path: { typeId: "ty_rec" },
    doc: () => editContext(portraitContext(), (d) => void d.types.push(struct("ty_rec", "Rec", [field("next", ir.named("ty_rec"))]))),
  },
  {
    label: "struct containing itself through an optional",
    code: "type.recursive",
    severity: "error",
    path: { typeId: "ty_rec" },
    doc: () =>
      editContext(portraitContext(), (d) => void d.types.push(struct("ty_rec", "Rec", [field("next", ir.optional(ir.named("ty_rec")))]))),
  },
  {
    label: "struct containing itself through a list",
    code: "type.recursive",
    severity: "error",
    path: { typeId: "ty_tree" },
    doc: () =>
      editContext(portraitContext(), (d) => void d.types.push(struct("ty_tree", "Tree", [field("children", ir.list(ir.named("ty_tree")))]))),
  },
  {
    label: "two structs containing each other",
    code: "type.recursive",
    severity: "error",
    path: {},
    doc: () =>
      editContext(portraitContext(), (d) => {
        d.types.push(struct("ty_a", "A", [field("b", ir.named("ty_b"))]));
        d.types.push(struct("ty_b", "B", [field("a", ir.optional(ir.named("ty_a")))]));
      }),
  },
  {
    label: "two global types whose names differ only in case",
    code: "type.duplicate_name",
    severity: "error",
    path: {},
    doc: () => editContext(portraitContext(), (d) => void d.types.push(enumType("ty_style2", "Artstyle", ["x"]))),
  },
  {
    label: "two local types with the same name",
    code: "type.duplicate_name",
    severity: "error",
    path: { flowId: P },
    doc: () =>
      portraitWith((f) => {
        f.types.push(enumType("ty_l1", "Mode", ["a"]));
        f.types.push(enumType("ty_l2", "MODE", ["b"]));
      }),
  },
  {
    label: "type name starting with a lowercase letter",
    code: "type.invalid_name",
    severity: "error",
    path: { typeId: "ty_bad" },
    doc: () => editContext(portraitContext(), (d) => void d.types.push(enumType("ty_bad", "artStyle2", ["x"]))),
  },
  {
    label: "reserved type name",
    code: "type.reserved_name",
    severity: "error",
    path: { typeId: "ty_bad" },
    doc: () => editContext(portraitContext(), (d) => void d.types.push(struct("ty_bad", "Text", []))),
  },
  {
    label: "local type shadowing a global type",
    code: "type.shadows_global",
    severity: "warning",
    path: { flowId: P, typeId: "ty_lstyle" },
    doc: () => portraitWith((f) => void f.types.push(enumType("ty_lstyle", "ArtStyle", ["sketch"]))),
    messageContains: ["ArtStyle", "Portrait"],
  },
  {
    label: "enum without members",
    code: "type.enum_empty",
    severity: "warning",
    path: { typeId: "ty_empty" },
    doc: () => editContext(portraitContext(), (d) => void d.types.push(enumType("ty_empty", "Empty", []))),
  },
  {
    label: "struct field default that violates its constraint",
    code: "type.invalid_default",
    severity: "error",
    path: { typeId: CHARACTER_ID, field: "age" },
    doc: () =>
      editContext(portraitContext(), (d) => {
        const character = d.types.find((x) => x.id === CHARACTER_ID);
        if (character?.kind === "struct") character.fields[1]!.default = -1;
      }),
  },
  {
    label: "flow input default of the wrong type",
    code: "type.invalid_default",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void f.inputs.push(field("count", ir.int({ min: 0 }), { default: "many" }))),
  },
  {
    label: "global struct using a local type",
    code: "visibility.local_type_in_global",
    severity: "error",
    path: { typeId: "ty_glob" },
    doc: () =>
      editFlow(portraitContext(), P, (f, d) => {
        f.types.push(enumType("ty_local", "Local", ["a"]));
        d.types.push(struct("ty_glob", "Glob", [field("l", ir.named("ty_local"))]));
      }),
  },
  {
    label: "flow input using a local type",
    code: "visibility.local_type_in_public_signature",
    severity: "error",
    path: { flowId: P },
    doc: () =>
      portraitWith((f) => {
        f.types.push(enumType("ty_local", "Local", ["a"]));
        f.inputs.push(field("extra", ir.optional(ir.named("ty_local"))));
      }),
    messageContains: ["extra", "Local"],
  },
  {
    label: "flow output using a local type",
    code: "visibility.local_type_in_public_signature",
    severity: "error",
    path: { flowId: P },
    doc: () =>
      portraitWith((f) => {
        f.types.push(enumType("ty_local", "Local", ["a"]));
        f.outputs.push(field("extra", ir.list(ir.named("ty_local"))));
      }),
  },
  {
    label: "public variable using a local type",
    code: "visibility.local_type_in_public_variable",
    severity: "error",
    path: { flowId: P, variableId: "var_l" },
    doc: () =>
      portraitWith((f) => {
        f.types.push(enumType("ty_local", "Local", ["a"]));
        f.variables.push({ id: "var_l", name: "loc", type: ir.named("ty_local"), access: "public", default: "a" });
      }),
  },
  // --- nodes -------------------------------------------------------------------------------
  {
    label: "node of an unknown type",
    code: "node.unknown_type",
    severity: "error",
    path: { flowId: P, nodeId: "n_x" },
    doc: () => portraitWith((f) => void f.nodes.push(node("n_x", "ghost.node", { x: 0, y: 300 }))),
    messageContains: ["ghost.node"],
  },
  {
    label: "required config field missing",
    code: "config.invalid",
    severity: "error",
    path: { flowId: P, nodeId: "n_tpl" },
    doc: () => portraitWith((f) => void (f.nodes.find((n) => n.id === "n_tpl")!.config = {})),
  },
  {
    label: "config field of the wrong kind",
    code: "config.invalid",
    severity: "error",
    path: { flowId: K, nodeId: "n_cfg" },
    doc: () => kitContext({ nodes: [node("n_cfg", "kit.configured", { x: 0, y: 0 }, { config: { count: "two" } })] }),
  },
  {
    label: "config int out of range",
    code: "config.invalid",
    severity: "error",
    path: { flowId: K, nodeId: "n_cfg" },
    doc: () => kitContext({ nodes: [node("n_cfg", "kit.configured", { x: 0, y: 0 }, { config: { count: 9 } })] }),
  },
  {
    label: "unknown config key",
    code: "config.invalid",
    severity: "error",
    path: { flowId: K, nodeId: "n_cfg" },
    doc: () => kitContext({ nodes: [node("n_cfg", "kit.configured", { x: 0, y: 0 }, { config: { colour: "red" } })] }),
  },
  {
    label: "config referencing a missing type",
    code: "config.unknown_ref",
    severity: "error",
    path: { flowId: P, nodeId: "n_brk" },
    doc: () => portraitWith((f) => void (f.nodes.find((n) => n.id === "n_brk")!.config = { typeId: "ty_ghost" })),
  },
  {
    label: "struct.break configured with an enum",
    code: "config.unknown_ref",
    severity: "error",
    path: { flowId: P, nodeId: "n_brk" },
    doc: () => portraitWith((f) => void (f.nodes.find((n) => n.id === "n_brk")!.config = { typeId: ART_STYLE_ID })),
  },
  {
    label: "template with an invalid placeholder",
    code: "node.ports_unresolved",
    severity: "error",
    path: { flowId: P, nodeId: "n_tpl" },
    doc: () => portraitWith((f) => void (f.nodes.find((n) => n.id === "n_tpl")!.config = { template: "Draw {{1bad}}" })),
  },
  {
    label: "constant of the wrong type",
    code: "node.invalid_value",
    severity: "error",
    path: { flowId: K, nodeId: "n_join", port: "separator" },
    doc: () =>
      kitContext({ nodes: [node("n_join", "text.join", { x: 0, y: 0 }, { values: { items: ["a"], separator: 5 } })] }),
  },
  {
    label: "constant violating a constraint",
    code: "node.invalid_value",
    severity: "error",
    path: { flowId: K, nodeId: "n_sink", port: "value" },
    doc: () => kitContext({ nodes: [node("n_sink", "kit.sinkConstrained", { x: 0, y: 0 }, { values: { value: 11 } })] }),
  },
  {
    label: "generic var with no join (int and text)",
    code: "node.generic_conflict",
    severity: "error",
    path: { flowId: K, nodeId: "n_same" },
    doc: () =>
      kitContext({
        nodes: [
          node("n_i", "kit.intSource", { x: 0, y: 0 }),
          node("n_t", "kit.textSource", { x: 0, y: 100 }),
          node("n_same", "kit.same", { x: 200, y: 0 }),
        ],
        edges: [edge("e_1", "n_i.value", "n_same.a"), edge("e_2", "n_t.text", "n_same.b")],
      }),
  },
  {
    label: "generic input never connected",
    code: "node.generic_unbound",
    severity: "error",
    path: { flowId: K, nodeId: "n_conv" },
    doc: () => kitContext({ nodes: [node("n_conv", "convert.toText", { x: 0, y: 0 })] }),
  },
  {
    label: "flow output not connected",
    code: "output.unconnected",
    severity: "error",
    path: { flowId: P },
    doc: () => portraitWith((f) => void (f.edges = f.edges.filter((e) => e.id !== "e_4"))),
    messageContains: ["prompt"],
  },
  // --- edges -------------------------------------------------------------------------------
  {
    label: "flow output retyped to image (commands.md §10)",
    code: "edge.type_mismatch",
    severity: "error",
    path: { flowId: P, edgeId: "e_4" },
    doc: () => portraitWith((f) => void (f.outputs[0]!.type = ir.image())),
  },
  {
    label: "int into text (hint: convert.toText)",
    code: "edge.type_mismatch",
    severity: "error",
    path: { flowId: K, edgeId: "e_1" },
    doc: () =>
      kitContext({
        nodes: [node("n_i", "kit.intSource", { x: 0, y: 0 }), node("n_s", "kit.sinkText", { x: 200, y: 0 })],
        edges: [edge("e_1", "n_i.value", "n_s.value")],
      }),
    messageContains: ["Use convert.toText to turn it into text."],
  },
  {
    label: "list of int into int (hint: list.get)",
    code: "edge.type_mismatch",
    severity: "error",
    path: { flowId: K, edgeId: "e_1" },
    doc: () =>
      kitContext({
        nodes: [node("n_l", "kit.intListSource", { x: 0, y: 0 }), node("n_s", "kit.sinkInt", { x: 200, y: 0 })],
        edges: [edge("e_1", "n_l.list", "n_s.value")],
      }),
    messageContains: ["Use list.get to pick one item."],
  },
  {
    label: "image into int (media never converts)",
    code: "edge.type_mismatch",
    severity: "error",
    path: { flowId: K, edgeId: "e_1" },
    doc: () =>
      kitContext({
        nodes: [node("n_img", "kit.imageSource", { x: 0, y: 0 }), node("n_s", "kit.sinkInt", { x: 200, y: 0 })],
        edges: [edge("e_1", "n_img.image", "n_s.value")],
      }),
  },
  {
    label: "data cycle between two nodes",
    code: "flow.cycle",
    severity: "error",
    path: { flowId: K },
    doc: () =>
      kitContext({
        nodes: [node("n_a", "kit.passText", { x: 0, y: 0 }), node("n_b", "kit.passText", { x: 200, y: 0 })],
        edges: [edge("e_1", "n_a.value", "n_b.value"), edge("e_2", "n_b.value", "n_a.value")],
      }),
  },
  // --- variables -----------------------------------------------------------------------------
  {
    label: "two unordered writers (example C)",
    code: "variable.unordered_writes",
    severity: "error",
    path: { flowId: VARIABLES_FLOW_ID },
    doc: () => variablesContext("C"),
    messageContains: ["x"],
  },
  {
    label: "flow cycle through implicit edges (example D)",
    code: "flow.cycle",
    severity: "error",
    path: { flowId: VARIABLES_FLOW_ID },
    doc: () => variablesContext("D"),
  },
  {
    label: "get before any write, no default",
    code: "variable.read_before_write",
    severity: "error",
    path: { flowId: K, nodeId: "n_get" },
    doc: () =>
      kitContext({
        variables: [{ id: "var_x", name: "x", type: ir.text(), access: "private" }],
        nodes: [
          node("n_get", "briar.variable.get", { x: 0, y: 0 }, { config: { variableId: "var_x" } }),
          node("n_sink", "kit.sinkText", { x: 200, y: 0 }),
        ],
        edges: [edge("e_1", "n_get.value", "n_sink.value")],
      }),
  },
  {
    label: "readwrite global without value read before any write",
    code: "variable.read_before_write",
    severity: "error",
    path: { flowId: K, nodeId: "n_get" },
    doc: () =>
      kitContext({
        globals: [{ id: "gv_x", name: "x", type: ir.text(), access: "readwrite" }],
        nodes: [
          node("n_get", "briar.global.get", { x: 0, y: 0 }, { config: { globalId: "gv_x" } }),
          node("n_sink", "kit.sinkText", { x: 200, y: 0 }),
        ],
        edges: [edge("e_1", "n_get.value", "n_sink.value")],
      }),
  },
  {
    label: "global.set on a readonly global",
    code: "variable.write_to_readonly",
    severity: "error",
    path: { flowId: K, nodeId: "n_set" },
    doc: () =>
      kitContext({
        globals: [{ id: "gv_ro", name: "brand", type: ir.text(), access: "readonly", value: "Acme" }],
        nodes: [node("n_set", "briar.global.set", { x: 0, y: 0 }, { config: { globalId: "gv_ro" }, values: { value: "New" } })],
      }),
  },
  {
    label: "get node of a deleted variable",
    code: "variable.unknown",
    severity: "error",
    path: { flowId: K, nodeId: "n_get" },
    doc: () => kitContext({ nodes: [node("n_get", "briar.variable.get", { x: 0, y: 0 }, { config: { variableId: "var_ghost" } })] }),
  },
  {
    label: "private variable never used",
    code: "variable.unused",
    severity: "warning",
    path: { flowId: K, variableId: "var_u" },
    doc: () => kitContext({ variables: [{ id: "var_u", name: "unused", type: ir.text(), access: "private", default: "" }] }),
    messageContains: ["unused"],
  },
  {
    label: "variable default of the wrong type",
    code: "variable.invalid_default",
    severity: "error",
    path: { flowId: K, variableId: "var_n" },
    doc: () => kitContext({ variables: [{ id: "var_n", name: "n", type: ir.int(), access: "public", default: "x" }] }),
    messageContains: ["n"],
  },
  {
    label: "global value of the wrong type",
    code: "global.invalid_value",
    severity: "error",
    path: { globalId: "gv_n" },
    doc: () => kitContext({ globals: [{ id: "gv_n", name: "limit", type: ir.int({ min: 0 }), access: "readonly", value: -3 }] }),
    messageContains: ["limit"],
  },
];
