/**
 * Plain fixture documents for the authoring suites. Built with the `@briarflow/testing`
 * builders (no authoring involved), so a failing command never breaks the setup of another
 * test.
 */
import type { Command } from "@briarflow/authoring";
import type { ContextDocument } from "@briarflow/core";
import { context, edge, enumType, field, flow, ir, node, portraitContext, struct } from "@briarflow/testing";

export const PORTRAIT = "flow_p";
export const KIT = "flow_k";

/** An empty context at revision 0. */
export function emptyDoc(): ContextDocument {
  return context({ id: "ctx_t", name: "Test", revision: 0 });
}

/** `portraitContext()` from `@briarflow/testing` (commands.md §10 end state). */
export function portraitDoc(): ContextDocument {
  return portraitContext();
}

/** The value of global `hero` (a `Character`). */
export const HERO = { name: "Aria", age: 30, style: "anime", nickname: null };

/**
 * A context with something of everything:
 *
 * - global types: `ArtStyle` (`ty_style`, enum anime/realistic/pixel), `Character` (`ty_char`:
 *   name text, age int{min 0} = 30, style ArtStyle, nickname text?), `Team` (`ty_team`: lead
 *   Character with a struct default), `Unused` (`ty_unused`, enum a/b, referenced nowhere)
 * - globals: `brand` (`gv_brand`, readonly text "Acme"), `count` (`gv_count`, readwrite int 0),
 *   `hero` (`gv_hero`, readwrite Character), `spare` (`gv_spare`, readwrite text, no value, unused)
 * - flow `flow_p` "Portrait" (as in `portraitContext`)
 * - flow `flow_k` "Kit": local types `Mood` (`ty_mood`, calm/angry) and `Pair` (`ty_pair`: left
 *   text, mood Mood); input `topic` text = "cats"; output `summary` text; variables `n`
 *   (`var_n`, private int = 1, used by `n_vget` / `n_vset`), `title` (`var_title`, public text,
 *   unused), `mood` (`var_mood`, private Mood = "calm"), `hero` (`var_hero`, private Character);
 *   nodes `n_make` (struct.make Character with constants), `n_bgget` (global.get brand),
 *   `n_pass` (kit.passText), `n_cset` (global.set count, constant 3), `n_vget` / `n_vset`
 *   (variable get/set n, set constant 2), `n_src` (kit.textSource), `n_sink` (kit.sinkText),
 *   `n_c` (kit.sinkConstrained = 5), `n_const` (constant list<text> ["anime"]), `n_chars`
 *   (constant list<Character>), `n_moodc` (constant Mood "calm"), `n_same` (kit.same, T = Mood);
 *   edges `e_1` n_in.topic→n_out.summary, `e_2` n_src.text→n_sink.value,
 *   `e_3` n_bgget.value→n_pass.value, `e_4` n_moodc.value→n_same.a.
 */
export function richDoc(): ContextDocument {
  const portrait = portraitContext();
  const portraitFlow = portrait.flows[0]!;
  return context({
    id: "ctx_rich",
    name: "Rich",
    types: [
      ...portrait.types,
      struct("ty_team", "Team", [field("lead", ir.named("ty_char"), { default: { name: "Lead", age: 40, style: "realistic", nickname: null } })]),
      enumType("ty_unused", "Unused", ["a", "b"]),
    ],
    globals: [
      { id: "gv_brand", name: "brand", type: ir.text(), access: "readonly", value: "Acme" },
      { id: "gv_count", name: "count", type: ir.int(), access: "readwrite", value: 0 },
      { id: "gv_hero", name: "hero", type: ir.named("ty_char"), access: "readwrite", value: { ...HERO } },
      { id: "gv_spare", name: "spare", type: ir.text(), access: "readwrite" },
    ],
    flows: [
      portraitFlow,
      flow({
        id: KIT,
        name: "Kit",
        types: [enumType("ty_mood", "Mood", ["calm", "angry"]), struct("ty_pair", "Pair", [field("left", ir.text()), field("mood", ir.named("ty_mood"))])],
        inputs: [field("topic", ir.text(), { default: "cats" })],
        outputs: [field("summary", ir.text())],
        variables: [
          { id: "var_n", name: "n", type: ir.int(), access: "private", default: 1 },
          { id: "var_title", name: "title", type: ir.text(), access: "public", default: "T" },
          { id: "var_mood", name: "mood", type: ir.named("ty_mood"), access: "private", default: "calm" },
          { id: "var_hero", name: "hero", type: ir.named("ty_char"), access: "private", default: { name: "Bo", age: 1, style: "pixel", nickname: null } },
        ],
        nodes: [
          node("n_make", "briar.struct.make", { x: 100, y: 200 }, { config: { typeId: "ty_char" }, values: { name: "Aria", age: 5, style: "anime" } }),
          node("n_bgget", "briar.global.get", { x: 100, y: 300 }, { config: { globalId: "gv_brand" } }),
          node("n_pass", "kit.passText", { x: 300, y: 300 }),
          node("n_cset", "briar.global.set", { x: 100, y: 400 }, { config: { globalId: "gv_count" }, values: { value: 3 } }),
          node("n_vget", "briar.variable.get", { x: 100, y: 500 }, { config: { variableId: "var_n" } }),
          node("n_vset", "briar.variable.set", { x: 300, y: 500 }, { config: { variableId: "var_n" }, values: { value: 2 } }),
          node("n_src", "kit.textSource", { x: 100, y: 600 }),
          node("n_sink", "kit.sinkText", { x: 300, y: 600 }),
          node("n_c", "kit.sinkConstrained", { x: 100, y: 700 }, { values: { value: 5 } }),
          node("n_const", "briar.constant", { x: 100, y: 800 }, { config: { type: ir.list(ir.text()) }, values: { value: ["anime"] } }),
          node(
            "n_chars",
            "briar.constant",
            { x: 100, y: 900 },
            { config: { type: ir.list(ir.named("ty_char")) }, values: { value: [{ name: "Cy", age: 2, style: "anime", nickname: null }] } },
          ),
          node("n_moodc", "briar.constant", { x: 100, y: 1000 }, { config: { type: ir.named("ty_mood") }, values: { value: "calm" } }),
          node("n_same", "kit.same", { x: 300, y: 1000 }, { typeBindings: { T: ir.named("ty_mood") } }),
        ],
        edges: [
          edge("e_1", "n_in.topic", "n_out.summary"),
          edge("e_2", "n_src.text", "n_sink.value"),
          edge("e_3", "n_bgget.value", "n_pass.value"),
          edge("e_4", "n_moodc.value", "n_same.a"),
        ],
      }),
    ],
  });
}

/** The commands.md §10 build batch (starts from an empty context). */
export const SECTION_10_BATCH: readonly Command[] = [
  { op: "type.defineEnum", scope: { kind: "global" }, id: "ty_style", name: "ArtStyle", members: ["anime", "pixel"] },
  {
    op: "type.defineStruct",
    scope: { kind: "global" },
    id: "ty_char",
    name: "Character",
    fields: [
      { name: "name", type: "text" },
      { name: "style", type: "ArtStyle" },
    ],
  },
  { op: "flow.create", id: "flow_p", name: "Portrait", inputNodeId: "n_in", outputNodeId: "n_out" },
  { op: "flow.input.add", flowId: "flow_p", name: "character", type: "Character" },
  { op: "flow.output.add", flowId: "flow_p", name: "prompt", type: "text" },
  { op: "node.add", flowId: "flow_p", id: "n_brk", type: "briar.struct.break", position: { x: 200, y: 0 }, config: { typeId: "ty_char" } },
  {
    op: "node.add",
    flowId: "flow_p",
    id: "n_tpl",
    type: "text.template",
    position: { x: 420, y: 0 },
    config: { template: "Draw {{name}} in {{style}} style" },
  },
  { op: "edge.connect", flowId: "flow_p", id: "e_1", from: { node: "n_in", port: "character" }, to: { node: "n_brk", port: "value" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_2", from: { node: "n_brk", port: "name" }, to: { node: "n_tpl", port: "name" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_3", from: { node: "n_brk", port: "style" }, to: { node: "n_tpl", port: "style" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_4", from: { node: "n_tpl", port: "text" }, to: { node: "n_out", port: "prompt" } },
];
