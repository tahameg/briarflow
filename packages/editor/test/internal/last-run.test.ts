import { createCatalog, createSequentialIdGenerator, defineNode, definePack, t, type LastRun } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { applyCommands } from "@briarflow/authoring";
import { createEditorStore, runStateFromLastRun, viewImageNode } from "../../src/index.js";
import { CLOCK, FakeBackend, baseDoc, tick } from "./fakes.js";

const view = defineNode({ type: "debug.image", frontend: true, inputs: { image: t.image(), label: t.optional(t.text()) }, run: () => ({}) });
const make = defineNode({ type: "img.make", outputs: { image: t.image() }, run: () => ({ image: { mediaId: "med_x" } }) });
const catalog = createCatalog([definePack({ name: "img", version: "1.0.0", namespaces: ["img", "debug"], nodes: [view, make] })]);

const last = (over: Partial<LastRun> = {}): LastRun => ({
  runId: "run_old",
  contextId: "ctx_1",
  flowId: "flow_a",
  revision: 1,
  status: "succeeded",
  requestedAt: "2026-10-25T00:00:00.000Z",
  finishedAt: "2026-10-25T00:00:01.000Z",
  inputs: {},
  nodes: {
    n_m: { state: "completed", outputs: { image: { mediaId: "med_1" } }, cached: true, durationMs: 4, key: "k" },
    n_f: { state: "failed", error: { code: "node.failed", message: "no" } },
  },
  ...over,
});

async function setup(record?: LastRun) {
  const backend = new FakeBackend(baseDoc(), applyCommands, catalog);
  if (record) backend.lastRuns.set(record.flowId, record);
  const store = createEditorStore({ backend, contextId: "ctx_1", catalog, idGenerator: createSequentialIdGenerator(), clock: CLOCK, viewportPersistMs: null });
  await store.ready;
  await tick();
  return { store, backend };
}

describe("last run", () => {
  it("shows the flow's last run after loading, so previews survive a reload", async () => {
    const { store } = await setup(last());
    const run = store.getState().run;
    expect(run).toMatchObject({ runId: "run_old", flowId: "flow_a", status: "succeeded", restored: true });
    expect(run?.nodes["n_m"]).toEqual({ status: "cached", outputs: { image: { mediaId: "med_1" } }, durationMs: 4 });
    expect(run?.nodes["n_f"]).toMatchObject({ status: "failed", error: { code: "node.failed" } });
  });

  it("maps interrupted runs to failed and skips runs still going", () => {
    expect(runStateFromLastRun(last({ status: "interrupted" }))).toMatchObject({ status: "failed", error: { code: "run.interrupted" } });
    expect(runStateFromLastRun(last({ status: "running", nodes: {} }))).toBeUndefined();
  });

  it("does not replace a run the editor is watching", async () => {
    const { store, backend } = await setup();
    await store.startRun();
    backend.lastRuns.set("flow_a", last());
    store.setActiveFlow(undefined);
    store.setActiveFlow("flow_a");
    await tick();
    expect(store.getState().run?.runId).toBe("run_1");
  });

  it("asks the backend to run everything again with force", async () => {
    const { store, backend } = await setup();
    store.setForce(true);
    await store.startRun();
    await store.startRun({ force: false });
    expect(backend.runCalls.map((c) => c.force)).toEqual([true, undefined]);
  });
});

describe("View image", () => {
  it("writes a console line carrying the image, or [none]", () => {
    const lines: [string, unknown][] = [];
    const call = (inputs: Record<string, unknown>) => viewImageNode({ runId: "run_1", nodeId: "n_v", title: "View image", inputs, print: (text, value) => lines.push([text, value]) });
    call({ image: { mediaId: "med_1" }, label: "after resize" });
    call({ image: { mediaId: "med_2" }, label: null });
    call({ image: null });
    expect(lines).toEqual([
      ["after resize", { mediaId: "med_1" }],
      ["image", { mediaId: "med_2" }],
      ["image: [none]", undefined],
    ]);
  });

  it("runs as a frontend node with the upstream image", async () => {
    const { store, backend } = await setup();
    store.dispatch([
      { op: "node.add", flowId: "flow_a", type: "img.make", position: { x: 0, y: 0 }, id: "n_m" },
      { op: "node.add", flowId: "flow_a", type: "debug.image", position: { x: 0, y: 0 }, id: "n_v" },
      { op: "edge.connect", flowId: "flow_a", from: { node: "n_m", port: "image" }, to: { node: "n_v", port: "image" } },
    ]);
    await store.flush();
    await store.startRun();
    const run = backend.runs[0]!;
    run.emit({ type: "node.completed", nodeId: "n_m", outputs: { image: { mediaId: "med_9" } }, cached: false, durationMs: 1 });
    run.emit({ type: "node.completed", nodeId: "n_v", outputs: {}, cached: false, durationMs: 1 });
    await tick();
    const line = store.getState().console.find((l) => l.kind === "print");
    expect(line).toMatchObject({ nodeId: "n_v", text: "image", value: { mediaId: "med_9" } });
  });
});
