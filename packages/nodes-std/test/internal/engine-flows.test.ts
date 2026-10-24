import { describe, expect, it } from "vitest";
import { createCatalog, type ContextDocument, type RunResult } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { createEngine } from "@briarflow/runtime";

const pos = { x: 0, y: 0 };
const text = { kind: "primitive", name: "text" } as const;
const int = { kind: "primitive", name: "int" } as const;

function doc(flowPart: Partial<ContextDocument["flows"][number]>, types: ContextDocument["types"] = []): ContextDocument {
  return {
    format: "briarflow.context",
    formatVersion: 1,
    id: "ctx_s",
    name: "Std",
    revision: 1,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    types,
    globals: [],
    flows: [
      {
        id: "flow_s",
        name: "Std flow",
        types: [],
        inputs: [],
        outputs: [],
        variables: [],
        edges: [],
        ...flowPart,
        nodes: [{ id: "n_in", type: "briar.input", position: pos }, { id: "n_out", type: "briar.output", position: pos }, ...(flowPart.nodes ?? [])],
      },
    ],
  };
}

const e = (id: string, from: string, to: string) => {
  const [fn, fp] = from.split(".") as [string, string];
  const [tn, tp] = to.split(".") as [string, string];
  return { id, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
};

async function run(d: ContextDocument, inputs: Record<string, unknown> = {}): Promise<RunResult> {
  const engine = createEngine({
    catalog: createCatalog([stdPack, mockPack]),
    secrets: { get: async () => undefined },
  });
  return engine.run({ context: d, flowId: "flow_s", inputs }).result;
}

describe("std nodes inside the engine", () => {
  it("struct.make (with field defaults) → constant → list.make → text.join", async () => {
    const d = doc(
      {
        outputs: [{ name: "joined", type: text }, { name: "made", type: { kind: "named", id: "ty_pt" } }],
        nodes: [
          { id: "n_make", type: "briar.struct.make", position: pos, config: { typeId: "ty_pt" }, values: { label: "P" } },
          { id: "n_c", type: "briar.constant", position: pos, config: { type: text }, values: { value: "const" } },
          { id: "n_tt", type: "convert.toText", position: pos },
          { id: "n_list", type: "list.make", position: pos, config: { count: 2 } },
          { id: "n_join", type: "text.join", position: pos, values: { separator: " + " } },
        ],
        edges: [
          e("e_1", "n_make.value", "n_tt.value"),
          e("e_2", "n_tt.text", "n_list.item1"),
          e("e_3", "n_c.value", "n_list.item2"),
          e("e_4", "n_list.list", "n_join.items"),
          e("e_5", "n_join.text", "n_out.joined"),
          e("e_6", "n_make.value", "n_out.made"),
        ],
      },
      [{ kind: "struct", id: "ty_pt", name: "Point", fields: [{ name: "label", type: text }, { name: "x", type: int, default: 3 }] }],
    );
    const result = await run(d);
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({ joined: '{"label":"P","x":3} + const', made: { label: "P", x: 3 } });
  });

  it("parse → floatToInt with the RoundingMode default", async () => {
    const d = doc({
      inputs: [{ name: "s", type: text }],
      outputs: [{ name: "n", type: int }],
      nodes: [
        { id: "n_pf", type: "convert.asFloat", position: pos },
        { id: "n_fi", type: "convert.floatToInt", position: pos },
      ],
      edges: [e("e_1", "n_in.s", "n_pf.value"), e("e_2", "n_pf.value", "n_fi.value"), e("e_3", "n_fi.value", "n_out.n")],
    });
    expect((await run(d, { s: " 2.5 " })).outputs).toEqual({ n: 3 });
    const bad = await run(d, { s: "x" });
    expect(bad.error?.cause?.code).toBe("convert.invalid_number");
  });
});
