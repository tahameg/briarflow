import { createCatalog, createSequentialIdGenerator } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { createEditorStore, isRunFinished, reduceRunEvent } from "../../src/index.js";
import type { RunState } from "../../src/index.js";
import { CLOCK, FakeBackend, baseDoc, fakeApplier, tick } from "./fakes.js";

const catalog = createCatalog([]);

async function setup() {
  const backend = new FakeBackend(baseDoc(), fakeApplier, catalog);
  const store = createEditorStore({
    backend,
    contextId: "ctx_1",
    catalog,
    applier: fakeApplier,
    idGenerator: createSequentialIdGenerator(),
    clock: CLOCK,
    viewportPersistMs: null,
  });
  await store.ready;
  return { backend, store };
}

describe("run tracking", () => {
  it("waits for pending batches, then tracks per-node status from events", async () => {
    const { store, backend } = await setup();
    backend.holdAll = true;
    store.dispatch({ op: "node.add", flowId: "flow_a", type: "mock.x", position: { x: 1, y: 1 }, id: "n_a" });
    const started = store.startRun({ inputs: { topic: "cats" } });
    await tick();
    expect(backend.runs).toHaveLength(0); // sync first
    backend.releaseNext();
    const run = await started;
    expect(backend.applyCalls).toHaveLength(1);
    const fake = backend.runs[0]!;
    expect(store.getState().run).toMatchObject({ runId: run.id, flowId: "flow_a", status: "running", nodes: {} });

    fake.emit({ type: "run.started", flowId: "flow_a", contextId: "ctx_1" });
    fake.emit({ type: "node.started", nodeId: "n_a", attempt: 1 });
    fake.emit({ type: "node.progress", nodeId: "n_a", fraction: 0.4, message: "thinking" });
    fake.emit({ type: "node.started", nodeId: "n_b", attempt: 1 });
    fake.emit({ type: "node.retrying", nodeId: "n_b", attempt: 1, nextAttempt: 2, delayMs: 10, error: { code: "x.y", message: "flaky" } });
    await tick();
    let nodes = store.getState().run!.nodes;
    expect(nodes.n_a).toEqual({ status: "running", attempt: 1, progress: 0.4, message: "thinking" });
    expect(nodes.n_b).toMatchObject({ status: "running", retrying: true, message: "flaky" });

    fake.emit({ type: "node.completed", nodeId: "n_a", outputs: { text: "hi" }, cached: false, durationMs: 5 });
    fake.emit({ type: "node.completed", nodeId: "n_in", outputs: {}, cached: true, durationMs: 0 });
    fake.emit({ type: "node.failed", nodeId: "n_b", error: { code: "x.y", message: "broken" } });
    fake.emit({ type: "node.skipped", nodeId: "n_out", reason: "upstream_failed", cause: "n_b" });
    const result = fake.complete("failed");
    await tick();
    const s = store.getState().run!;
    nodes = s.nodes;
    expect(nodes.n_a).toEqual({ status: "done", outputs: { text: "hi" }, durationMs: 5 });
    expect(nodes.n_in!.status).toBe("cached");
    expect(nodes.n_b).toEqual({ status: "failed", error: { code: "x.y", message: "broken" } });
    expect(nodes.n_out).toEqual({ status: "skipped", skipReason: "upstream_failed", cause: "n_b" });
    expect(s.status).toBe("failed");
    expect(s.result).toEqual(result);
    expect(s.error).toEqual(result.error);
    expect(isRunFinished(s)).toBe(true);
  });

  it("records a rejected run and rethrows", async () => {
    const { store, backend } = await setup();
    backend.runError = Object.assign(new Error("Inputs are invalid."), { code: "run.invalid_inputs" });
    await expect(store.startRun()).rejects.toThrow("Inputs are invalid.");
    expect(store.getState().run).toMatchObject({ status: "rejected", flowId: "flow_a", error: { code: "run.invalid_inputs" } });
  });

  it("cancels and clears; a newer run replaces the old one's tracking", async () => {
    const { store, backend } = await setup();
    await store.startRun();
    store.cancelRun("stop");
    expect(backend.runs[0]!.cancelled).toBe("stop");
    await store.startRun();
    backend.runs[0]!.emit({ type: "node.started", nodeId: "n_a", attempt: 1 });
    await tick();
    expect(store.getState().run!.runId).toBe("run_2");
    expect(store.getState().run!.nodes).toEqual({});
    store.clearRun();
    expect(store.getState().run).toBeUndefined();
  });

  it("needs a flow", async () => {
    const backend = new FakeBackend({ ...baseDoc(), flows: [] }, fakeApplier, catalog);
    const store = createEditorStore({ backend, contextId: "ctx_1", catalog, applier: fakeApplier });
    await store.ready;
    await expect(store.startRun()).rejects.toMatchObject({ code: "editor.no_flow" });
  });
});

describe("reduceRunEvent", () => {
  it("ignores already applied events (replays after reconnect)", () => {
    const s: RunState = { runId: "run_1", flowId: "flow_a", status: "running", nodes: {}, lastSeq: 3, events: [] };
    expect(reduceRunEvent(s, { type: "node.started", runId: "run_1", seq: 2, at: "", nodeId: "n_a", attempt: 1 })).toBe(s);
  });
});
