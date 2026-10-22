/**
 * The store with the real `@briarflow/authoring` applier (no `applier` override), against an
 * in-process backend that also uses `applyCommands`.
 */
import { applyCommands } from "@briarflow/authoring";
import { createCatalog, createContextDocument, createSequentialIdGenerator, defineNode, definePack, t } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { createEditorStore } from "../../src/index.js";
import { CLOCK, FakeBackend } from "./fakes.js";

const shout = defineNode({
  type: "words.shout",
  inputs: { text: t.text() },
  outputs: { text: t.text() },
  run: ({ inputs }) => ({ text: inputs.text }),
});
const catalog = createCatalog([definePack({ name: "words", version: "0.1.0", nodes: [shout] })]);

describe("with @briarflow/authoring", () => {
  it("creates a flow and a node optimistically, syncs, undoes and redoes", async () => {
    const doc = createContextDocument({ name: "Test", id: "ctx_1", idGenerator: createSequentialIdGenerator(), clock: CLOCK });
    const backend = new FakeBackend(doc, applyCommands, catalog);
    const store = createEditorStore({
      backend,
      contextId: "ctx_1",
      catalog,
      idGenerator: createSequentialIdGenerator(),
      clock: CLOCK,
      viewportPersistMs: null,
    });
    await store.ready;
    const created = store.dispatch({ op: "flow.create", name: "Portrait" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const flowId = created.created.flowId!;
    expect(store.getState().activeFlowId).toBe(flowId);
    const added = store.dispatch({ op: "node.add", flowId, type: "words.shout", position: { x: 10, y: 20 } });
    expect(added.ok).toBe(true);
    await store.flush();
    expect(backend.doc.flows).toEqual(store.getState().doc!.flows);
    store.undo();
    expect(store.getState().doc!.flows[0]!.nodes).toHaveLength(2);
    store.redo();
    await store.flush();
    expect(backend.doc.flows).toEqual(store.getState().doc!.flows);
    expect(store.getState().doc!.flows[0]!.nodes).toHaveLength(3);
    expect(backend.applyCalls.at(-1)!.commands.every((c) => c.restore === true)).toBe(true);
  });
});
