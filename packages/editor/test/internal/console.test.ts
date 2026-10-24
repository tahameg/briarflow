import { applyCommands } from "@briarflow/authoring";
import { BriarError, createCatalog, createSequentialIdGenerator, defineNode, definePack, t } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { createEditorStore } from "../../src/index.js";
import type { KeyValueStorage } from "../../src/index.js";
import { CLOCK, FakeBackend, baseDoc, tick } from "./fakes.js";

const echo = defineNode({ type: "debug.echo", title: "Echo", inputs: { text: t.text() }, outputs: { text: t.text() }, run: ({ inputs }) => inputs });
const catalog = createCatalog([definePack({ name: "debug", version: "1.0.0", nodes: [echo] })]);

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

async function setup(storage?: KeyValueStorage) {
  const backend = new FakeBackend(baseDoc(), applyCommands, catalog);
  const store = createEditorStore({
    backend,
    contextId: "ctx_1",
    catalog,
    idGenerator: createSequentialIdGenerator(),
    clock: CLOCK,
    viewportPersistMs: null,
    ...(storage ? { runInputsStorage: storage } : {}),
  });
  await store.ready;
  store.dispatch([
    { op: "flow.input.add", flowId: "flow_a", name: "topic", type: "text" },
    { op: "node.add", flowId: "flow_a", type: "debug.echo", position: { x: 0, y: 0 }, id: "n_e" },
  ]);
  await store.flush();
  return { store, backend };
}

describe("run inputs", () => {
  it("are kept per flow across runs and sent when startRun gets no inputs", async () => {
    const { store, backend } = await setup();
    store.setRunInput("flow_a", "topic", "cats");
    store.setRunInput("flow_a", "gone", 1);
    await store.startRun();
    backend.runs[0]!.complete();
    await tick();
    await store.startRun();
    expect(backend.runCalls.map((c) => c.inputs)).toEqual([{ topic: "cats" }, { topic: "cats" }]);
    expect(store.getState().runInputs["flow_a"]).toEqual({ topic: "cats", gone: 1 });
    store.setRunInput("flow_a", "topic", undefined);
    expect(store.getState().runInputs["flow_a"]).toEqual({ gone: 1 });
  });

  it("survive a new store through runInputsStorage", async () => {
    const storage = memoryStorage();
    const first = await setup(storage);
    first.store.setRunInput("flow_a", "topic", "dogs");
    const second = await setup(storage);
    expect(second.store.getState().runInputs).toEqual({ flow_a: { topic: "dogs" } });
    storage.data.set("briarflow.runInputs.ctx_1", "{not json");
    const third = await setup(storage);
    expect(third.store.getState().runInputs).toEqual({});
  });

  it("useCache defaults to the store setting", async () => {
    const { store, backend } = await setup();
    store.setUseCache(false);
    await store.startRun();
    expect(backend.runCalls[0]!.useCache).toBe(false);
  });
});

describe("console", () => {
  it("logs run start, failed nodes with code and type, outputs and the end of the run", async () => {
    const { store, backend } = await setup();
    await store.startRun();
    const run = backend.runs[0]!;
    run.emit({ type: "run.started", flowId: "flow_a" });
    run.emit({ type: "node.retrying", nodeId: "n_e", attempt: 1, nextAttempt: 2, delayMs: 100, error: { code: "node.unavailable", message: "busy" } });
    run.emit({ type: "node.failed", nodeId: "n_e", error: { code: "node.failed", message: "it broke", nodeId: "n_e" } });
    run.complete("failed");
    await tick();
    const rows = store.getState().console.map((l) => [l.kind, l.title, l.nodeType ?? "", l.code ?? "", l.text]);
    expect(rows).toEqual([
      ["info", "Main", "", "", "Run run_1 started"],
      ["warning", "Echo", "debug.echo", "node.unavailable", "busy (retry 2 in 100 ms)"],
      ["error", "Echo", "debug.echo", "node.failed", "it broke"],
      ["error", "Main", "", "", "Run failed in 1000 ms"],
    ]);
  });

  it("logs outputs of a succeeded run", async () => {
    const { store, backend } = await setup();
    await store.startRun();
    const run = backend.runs[0]!;
    run.emit({
      type: "run.completed",
      result: { runId: run.id, flowId: "flow_a", contextId: "ctx_1", contextRevision: 0, status: "succeeded", outputs: { reply: "hi", n: 2, none: null }, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:00.250Z" },
    });
    await tick();
    expect(store.getState().console.map((l) => [l.kind, l.title, l.text])).toEqual([
      ["output", "reply", "hi"],
      ["output", "n", "2"],
      ["output", "none", "[none]"],
      ["info", "Main", "Run succeeded in 250 ms"],
    ]);
  });

  it("logs a rejected run and each of its problems", async () => {
    const { store, backend } = await setup();
    backend.runError = new BriarError("run.invalid_flow", "The flow has 1 error.", {
      details: { diagnostics: [{ severity: "error", code: "edge.type_mismatch", message: "int does not fit text", path: { flowId: "flow_a", nodeId: "n_e" } }] },
    });
    await expect(store.startRun()).rejects.toThrow();
    expect(store.getState().console.map((l) => [l.kind, l.title, l.code, l.text])).toEqual([
      ["error", "Main", "run.invalid_flow", "The flow has 1 error."],
      ["error", "Echo", "edge.type_mismatch", "int does not fit text"],
    ]);
  });
});
