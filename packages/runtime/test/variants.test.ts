/**
 * node-api.md §1.2: the engine runs the picked variant, and the variant is part of the cache key.
 */
import { describe, expect, it } from "vitest";
import { defineNode, definePack, t, variant } from "@briarflow/core";
import { computeCacheKey, createMemoryCache } from "@briarflow/runtime";
import { ir } from "@briarflow/testing";
import { doc, e, FLOW_ID, makeEngine, n } from "./support.js";

let calls = 0;
const calc = defineNode({
  type: "vary.calc",
  pure: true,
  variants: {
    title: "Operation",
    options: {
      double: variant({ inputs: { value: t.int() }, outputs: { value: t.int() }, run: ({ inputs }) => (calls++, { value: inputs.value * 2 }) }),
      square: variant({ inputs: { value: t.int() }, outputs: { value: t.int() }, run: ({ inputs }) => (calls++, { value: inputs.value * inputs.value }) }),
    },
  },
});
const pack = definePack({ name: "vary", version: "1.0.0", nodes: [calc] });

const flowWith = (variantName: string | undefined) =>
  doc({
    outputs: [{ name: "out", type: ir.int() }],
    nodes: [n("n_c", "vary.calc", { ...(variantName === undefined ? {} : { variant: variantName }), values: { value: 5 } })],
    edges: [e("n_c.value", "n_out.out")],
  });

describe("variants in the engine", () => {
  it("runs the node's variant (the default when unset)", async () => {
    const { engine } = makeEngine({ packs: [pack] });
    expect((await engine.run({ context: flowWith("square"), flowId: FLOW_ID }).result).outputs).toEqual({ out: 25 });
    expect((await engine.run({ context: flowWith(undefined), flowId: FLOW_ID }).result).outputs).toEqual({ out: 10 });
  });

  it("caches each variant apart", async () => {
    const { engine } = makeEngine({ packs: [pack], cache: createMemoryCache() });
    calls = 0;
    await engine.run({ context: flowWith("double"), flowId: FLOW_ID }).result;
    const square = await engine.run({ context: flowWith("square"), flowId: FLOW_ID }).result;
    expect(square.outputs).toEqual({ out: 25 });
    expect(calls).toBe(2);
    await engine.run({ context: flowWith("square"), flowId: FLOW_ID }).result;
    expect(calls).toBe(2);
  });

  it("keys without a variant stay as before", async () => {
    const input = { nodeType: "vary.calc", pack: "vary@1.0.0", cacheVersion: "1", config: {}, typeBindings: {}, inputs: { value: 5 } };
    expect(await computeCacheKey({ ...input, variant: "square" })).not.toBe(await computeCacheKey(input));
    expect(await computeCacheKey({ ...input, variant: undefined } as never)).toBe(await computeCacheKey(input));
  });
});
