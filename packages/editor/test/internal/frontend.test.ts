import { createCatalog, createSequentialIdGenerator, defineNode, definePack, t } from "@briarflow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorStore } from "../../src/index.js";
import type { FrontendNodeHandler } from "../../src/index.js";
import { applyCommands } from "@briarflow/authoring";
import { CLOCK, FakeBackend, baseDoc, tick } from "./fakes.js";

const print = defineNode({
  type: "debug.print",
  frontend: true,
  inputs: { text: t.text(), browserConsole: { type: t.boolean(), default: false } },
  run: () => ({}),
});
const plain = defineNode({ type: "debug.echo", inputs: { text: t.text() }, outputs: { text: t.text() }, run: ({ inputs }) => inputs });
const catalog = createCatalog([definePack({ name: "debug", version: "1.0.0", nodes: [print, plain] })]);

async function setup(frontendNodes?: Record<string, FrontendNodeHandler>) {
  const backend = new FakeBackend(baseDoc(), applyCommands, catalog);
  const store = createEditorStore({
    backend,
    contextId: "ctx_1",
    catalog,
    idGenerator: createSequentialIdGenerator(),
    clock: CLOCK,
    viewportPersistMs: null,
    ...(frontendNodes ? { frontendNodes } : {}),
  });
  await store.ready;
  store.dispatch([
    { op: "node.add", flowId: "flow_a", type: "debug.echo", position: { x: 0, y: 0 }, id: "n_e" },
    { op: "node.add", flowId: "flow_a", type: "debug.print", position: { x: 0, y: 0 }, id: "n_p", values: { browserConsole: true } },
    { op: "node.add", flowId: "flow_a", type: "debug.print", position: { x: 0, y: 0 }, id: "n_q", values: { text: "typed" } },
    { op: "edge.connect", flowId: "flow_a", from: { node: "n_e", port: "text" }, to: { node: "n_p", port: "text" } },
  ]);
  await store.flush();
  await store.startRun();
  return { store, run: backend.runs[0]! };
}

afterEach(() => vi.restoreAllMocks());

describe("frontend nodes", () => {
  it("prints completed Print nodes with inputs rebuilt from the run, typed values and defaults", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { store, run } = await setup();
    run.emit({ type: "node.completed", nodeId: "n_e", outputs: { text: "from upstream" }, cached: true, durationMs: 0 });
    run.emit({ type: "node.completed", nodeId: "n_p", outputs: {}, cached: false, durationMs: 1 });
    run.emit({ type: "node.completed", nodeId: "n_q", outputs: {}, cached: false, durationMs: 1 });
    await tick();
    expect(store.getState().console.map((l) => [l.nodeId, l.title, l.text])).toEqual([
      ["n_p", "Print", "from upstream"],
      ["n_q", "Print", "typed"],
    ]);
    expect(log.mock.calls).toEqual([["[Print] from upstream"]]);
    store.clearConsole();
    expect(store.getState().console).toEqual([]);
  });

  it("uses the handlers it is given and reports a failing one as a line", async () => {
    const { store, run } = await setup({
      "debug.print": ({ inputs, print: write }) => {
        if (inputs.text === "boom") throw new Error("no screen");
        write(`custom ${String(inputs.text)}`);
      },
    });
    run.emit({ type: "node.completed", nodeId: "n_e", outputs: { text: "a" }, cached: false, durationMs: 1 });
    run.emit({ type: "node.completed", nodeId: "n_p", outputs: {}, cached: false, durationMs: 1 });
    run.emit({ type: "node.completed", nodeId: "n_e", outputs: { text: "boom" }, cached: false, durationMs: 1 });
    run.emit({ type: "node.completed", nodeId: "n_p", outputs: {}, cached: false, durationMs: 1 });
    await tick();
    expect(store.getState().console.map((l) => l.text)).toEqual(["custom a", "(frontend node failed: no screen)"]);
    // n_e is not a frontend node: completing it prints nothing.
  });
});
