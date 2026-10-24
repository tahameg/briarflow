/**
 * Phase 3 exit test: Character input → struct.break → text.template → mock.llm → mock.image → output.
 */
import { describe, expect, it } from "vitest";
import type { MediaRef, RunEvent } from "@briarflow/core";
import { collect, context, edge, field, flow, ir, node, testEngine, trace } from "./helpers.js";

function portraitDoc() {
  return context(
    [
      flow({
        id: "flow_p",
        name: "Portrait",
        inputs: [field("character", ir.named("ty_char"))],
        outputs: [field("description", ir.text()), field("portrait", ir.image())],
        nodes: [
          node("n_brk", "briar.struct.break", { config: { typeId: "ty_char" } }),
          node("n_tpl", "text.template", { config: { template: "Portrait of {{name}}, age {{age}}, in {{style}} style." } }),
          node("n_llm", "mock.llm", { values: { seed: 7 } }),
          node("n_img", "mock.image", { values: { width: 256, height: 128 } }),
        ],
        edges: [
          edge("n_in.character", "n_brk.value"),
          edge("n_brk.name", "n_tpl.name"),
          edge("n_brk.age", "n_tpl.age"),
          edge("n_brk.style", "n_tpl.style"),
          edge("n_tpl.text", "n_llm.prompt"),
          edge("n_llm.text", "n_img.prompt"),
          edge("n_llm.text", "n_out.description"),
          edge("n_img.image", "n_out.portrait"),
        ],
      }),
    ],
    {
      types: [
        { kind: "enum", id: "ty_style", name: "ArtStyle", members: [{ value: "anime" }, { value: "realistic" }, { value: "pixel" }] },
        {
          kind: "struct",
          id: "ty_char",
          name: "Character",
          fields: [
            field("name", ir.text()),
            field("age", ir.int({ min: 0 }), { default: 30 }),
            field("style", ir.named("ty_style")),
            field("nickname", ir.optional(ir.text())),
          ],
        },
      ],
    },
  );
}

describe("phase 3 exit: Character → template → mock LLM → mock image → output", () => {
  it("runs end to end with an in-memory MediaStore", async () => {
    const { engine, media } = testEngine();
    const run = engine.run({ context: portraitDoc(), flowId: "flow_p", inputs: { character: { name: "Aria", style: "anime" } } });
    expect(run.status).toBe("queued");
    const [result, events] = await Promise.all([run.result, collect(run.events())]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(result).toMatchObject({ runId: "run_1", flowId: "flow_p", contextId: "ctx_t", contextRevision: 3 });
    const description = result.outputs?.["description"] as string;
    expect(description).toMatch(/^Mock reply [0-9a-f]{8}: Portrait of Aria, age 30, in anime style\.$/);

    const portrait = result.outputs?.["portrait"] as MediaRef;
    expect(portrait).toMatchObject({ mime: "image/svg+xml", meta: { width: 256, height: 128 } });
    expect(portrait.uri).toMatch(/^briar-media:\/\/m_\d+$/);
    const svg = media.text(portrait);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128"');
    expect(svg).toContain(description.slice(0, 60).replace(/,/g, ","));
    expect(result.variables).toEqual({});
    expect(result.globalWrites).toEqual({});

    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    const started = trace(events).filter((s) => s.startsWith("node.started"));
    expect(started).toEqual([
      "node.started:n_in",
      "node.started:n_brk",
      "node.started:n_tpl",
      "node.started:n_llm",
      "node.started:n_img",
      "node.started:n_out",
    ]);
    const completed = events.find((e): e is Extract<RunEvent, { type: "node.completed" }> => e.type === "node.completed" && e.nodeId === "n_brk");
    expect(completed?.outputs).toEqual({ name: "Aria", age: 30, style: "anime", nickname: null });
  });

  it("is deterministic and hits the cache on the second run", async () => {
    const { engine, media } = testEngine();
    const inputs = { character: { name: "Aria", style: "anime" } };
    const first = await engine.run({ context: portraitDoc(), flowId: "flow_p", inputs }).result;
    const run2 = engine.run({ context: portraitDoc(), flowId: "flow_p", inputs });
    const [second, events] = await Promise.all([run2.result, collect(run2.events())]);
    expect(second.outputs).toEqual(first.outputs);
    const cached = events.filter((e) => e.type === "node.completed" && e.cached).map((e) => (e as { nodeId: string }).nodeId);
    expect(cached).toEqual(["n_brk", "n_llm", "n_img"]);
    expect(media.items.size).toBe(1);
  });
});
