import type { Command } from "@briarflow/authoring";
import { CommandError } from "@briarflow/authoring";
import { createCatalog, createSequentialIdGenerator } from "@briarflow/core";
import { describe, expect, it, vi } from "vitest";
import { createEditorStore } from "../../src/index.js";
import type { EditorStoreOptions } from "../../src/index.js";
import { CLOCK, FakeBackend, baseDoc, fakeApplier, tick } from "./fakes.js";

const catalog = createCatalog([]);

async function setup(extra: Partial<EditorStoreOptions> = {}) {
  const backend = new FakeBackend(baseDoc(), fakeApplier, catalog);
  const store = createEditorStore({
    backend,
    contextId: "ctx_1",
    catalog,
    applier: fakeApplier,
    idGenerator: createSequentialIdGenerator(),
    clock: CLOCK,
    viewportPersistMs: null,
    ...extra,
  });
  await store.ready;
  return { backend, store };
}

const add = (id?: string, x = 100): Command => ({
  op: "node.add",
  flowId: "flow_a",
  type: "mock.x",
  position: { x, y: 0 },
  ...(id ? { id } : {}),
});
const move = (nodeId: string, x: number): Command => ({ op: "node.move", flowId: "flow_a", nodeId, position: { x, y: 0 } });
const nodeIds = (store: { getState(): { doc?: { flows: readonly { nodes: readonly { id: string }[] }[] } | undefined } }) =>
  store.getState().doc!.flows[0]!.nodes.map((n) => n.id);
const rejection = (code = "edge.type_mismatch", commandIndex = 0) =>
  new CommandError(code, "Cannot connect A to B.", { commandIndex, op: "node.add" });

describe("loading", () => {
  it("loads the document, selects the first flow and reports ready", async () => {
    const { store, backend } = await setup();
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.doc).toBe(backend.doc);
    expect(s.serverRevision).toBe(0);
    expect(s.activeFlowId).toBe("flow_a");
    expect(s.nodeTypes?.nodes).toEqual([]);
  });

  it("reports load failures as status error plus a notice", async () => {
    const backend = new FakeBackend(baseDoc(), fakeApplier, catalog);
    backend.load = () => Promise.reject(new Error("offline"));
    const store = createEditorStore({ backend, contextId: "ctx_1", catalog, applier: fakeApplier });
    await store.ready;
    expect(store.getState().status).toBe("error");
    expect(store.getState().notices.map((n) => n.kind)).toEqual(["load_failed"]);
    const r = store.dispatch(add());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("editor.not_ready");
  });

  it("builds the catalog from backend node types when none is given", async () => {
    const backend = new FakeBackend(baseDoc(), fakeApplier, catalog);
    backend.nodeTypesInfo = {
      packs: [{ name: "mock", version: "1.0.0" }],
      nodes: [
        {
          type: "mock.x",
          pack: { name: "mock", version: "1.0.0" },
          title: "X",
          description: "",
          category: "Mock",
          icon: null,
          color: null,
          inputs: [],
          outputs: [],
          config: [],
          dynamicPorts: true,
          secrets: [],
          cache: true,
          timeoutMs: 0,
          retry: { maxAttempts: 1 },
          concurrency: null,
          deprecated: null,
        },
      ],
      types: [],
    };
    const store = createEditorStore({ backend, contextId: "ctx_1", applier: fakeApplier });
    await store.ready;
    expect(store.getState().catalog?.has("mock.x")).toBe(true);
    expect(store.getState().approximateNodeTypes).toEqual(["mock.x"]);
  });
});

describe("optimistic apply and sync", () => {
  it("applies locally at once with client-generated ids, then syncs with baseRevision", async () => {
    const { store, backend } = await setup();
    const r = store.dispatch(add());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created.nodeId).toBe("n_1");
    // Local state updated synchronously, before the server answered.
    expect(nodeIds(store)).toEqual(["n_in", "n_out", "n_1"]);
    expect(store.getState().sync).toMatchObject({ status: "syncing", pending: 1 });
    await store.flush();
    expect(backend.applyCalls).toEqual([{ baseRevision: 0, commands: [{ ...add(), id: "n_1" }] }]);
    expect(store.getState().serverRevision).toBe(1);
    expect(store.getState().sync).toEqual({ status: "idle", pending: 0 });
    expect(backend.doc.flows[0]!.nodes.map((n) => n.id)).toEqual(nodeIds(store));
  });

  it("returns local rejections without queueing anything", async () => {
    const { store, backend } = await setup();
    const before = store.getState();
    const r = store.dispatch(move("n_nope", 5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("command.unknown_ref");
    expect(store.getState()).toBe(before);
    await tick();
    expect(backend.applyCalls).toEqual([]);
  });

  it("does not sync or record unchanged batches", async () => {
    const { store, backend } = await setup();
    const r = store.dispatch(move("n_in", 0));
    expect(r.ok && r.changed).toBe(false);
    await tick();
    expect(backend.applyCalls).toEqual([]);
    expect(store.getState().history.canUndo).toBe(false);
  });

  it("serializes batches: one request in flight, each based on the previous server revision", async () => {
    const { store, backend } = await setup();
    backend.holdAll = true;
    store.dispatch(add("n_a"));
    store.dispatch(move("n_a", 50));
    store.dispatch([move("n_a", 60), move("n_in", 10)]);
    await tick();
    expect(backend.applyCalls).toHaveLength(1);
    expect(store.getState().sync.pending).toBe(3);
    backend.releaseNext();
    await tick();
    expect(backend.applyCalls).toHaveLength(2);
    backend.releaseNext();
    await tick();
    backend.releaseNext();
    await store.flush();
    expect(backend.applyCalls.map((c) => c.baseRevision)).toEqual([0, 1, 2]);
    expect(backend.applyCalls.map((c) => c.commands.map((x) => x.op))).toEqual([["node.add"], ["node.move"], ["node.move", "node.move"]]);
    expect(store.getState().serverRevision).toBe(3);
    expect(store.getState().doc!.revision).toBe(3);
  });

  it("adopts the server revision when it differs and rebases pending batches", async () => {
    const { store, backend } = await setup();
    // A backend that numbers revisions 10 higher than the local applier (same content).
    const apply = backend.apply.bind(backend);
    backend.apply = async (id, input) => {
      const base = input.baseRevision >= 10 ? input.baseRevision - 10 : input.baseRevision;
      const r = await apply(id, { ...input, baseRevision: base });
      return { ...r, revision: r.revision + 10 };
    };
    store.dispatch(add("n_a"));
    store.dispatch(move("n_a", 5));
    await store.flush();
    expect(store.getState().serverRevision).toBe(12);
    expect(store.getState().doc!.revision).toBe(12);
    expect(store.getState().doc!.flows[0]!.nodes.find((n) => n.id === "n_a")!.position.x).toBe(5);
    expect(backend.applyCalls.map((c) => c.baseRevision)).toEqual([0, 1]);
  });
});

describe("409 conflict", () => {
  it("reloads, drops unsynced batches and history, and emits a conflict notice", async () => {
    const { store, backend } = await setup();
    // Someone else changed the document.
    backend.doc = { ...backend.doc, name: "Changed elsewhere", revision: 5 };
    const flushed = store.dispatch(add("n_a"));
    expect(flushed.ok).toBe(true);
    store.dispatch(move("n_a", 30));
    const f = store.flush();
    await expect(f).rejects.toMatchObject({ code: "editor.reloaded" });
    await tick();
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.doc!.name).toBe("Changed elsewhere");
    expect(s.serverRevision).toBe(5);
    expect(nodeIds(store)).toEqual(["n_in", "n_out"]);
    expect(s.history).toMatchObject({ canUndo: false, canRedo: false });
    expect(s.sync).toEqual({ status: "idle", pending: 0 });
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toMatchObject({ kind: "conflict", dropped: 2 });
    expect(backend.loads).toBe(2);
    // Editing continues on the new base.
    store.dispatch(add("n_b"));
    await store.flush();
    expect(backend.applyCalls.at(-1)!.baseRevision).toBe(5);
  });
});

describe("422 rejection", () => {
  it("rolls back the rejected batch, keeps later independent batches and surfaces the error", async () => {
    const { store, backend } = await setup();
    backend.script.push("ok", { error: rejection() });
    store.dispatch(move("n_in", 10)); // accepted
    store.dispatch(add("n_a")); // rejected by the server
    store.dispatch(move("n_a", 99)); // depends on the rejected one → dropped
    store.dispatch(move("n_out", 700)); // independent → kept
    await store.flush();
    const s = store.getState();
    expect(nodeIds(store)).toEqual(["n_in", "n_out"]);
    const flow = s.doc!.flows[0]!;
    expect(flow.nodes.find((n) => n.id === "n_in")!.position.x).toBe(10);
    expect(flow.nodes.find((n) => n.id === "n_out")!.position.x).toBe(700);
    expect(s.notices).toHaveLength(1);
    const n = s.notices[0]!;
    expect(n.kind).toBe("rejected");
    expect(n.dropped).toBe(1);
    expect((n.error as CommandError).code).toBe("edge.type_mismatch");
    expect(n.commands).toEqual([add("n_a")]);
    // The server and the local document agree again.
    expect(backend.doc.flows[0]).toEqual(flow);
    expect(s.serverRevision).toBe(s.doc!.revision);
    // History: rejected and dropped steps are gone; the two accepted moves remain.
    expect(s.history.undoDepth).toBe(2);
    store.undo();
    expect(store.getState().doc!.flows[0]!.nodes.find((x) => x.id === "n_out")!.position.x).toBe(640);
    await store.flush();
    expect(backend.doc.flows[0]!.nodes.find((x) => x.id === "n_out")!.position.x).toBe(640);
  });

  it("dismisses notices", async () => {
    const { store, backend } = await setup();
    backend.script.push({ error: rejection() });
    store.dispatch(add("n_a"));
    await store.flush();
    const id = store.getState().notices[0]!.id;
    store.dismissNotice(id);
    expect(store.getState().notices).toEqual([]);
  });
});

describe("transient sync failures", () => {
  it("pauses syncing, rejects flush, and resumes on retrySync", async () => {
    const { store, backend } = await setup();
    backend.script.push({ error: new Error("ECONNRESET") });
    store.dispatch(add("n_a"));
    await expect(store.flush()).rejects.toThrow("ECONNRESET");
    expect(store.getState().sync).toMatchObject({ status: "error", pending: 1 });
    expect(store.getState().notices.map((n) => n.kind)).toEqual(["sync_failed"]);
    expect(nodeIds(store)).toContain("n_a"); // local change kept
    store.retrySync();
    await store.flush();
    expect(store.getState().sync).toEqual({ status: "idle", pending: 0 });
    expect(backend.doc.flows[0]!.nodes.map((n) => n.id)).toContain("n_a");
  });
});

describe("undo / redo", () => {
  it("undoes and redoes locally and syncs inverse / restore commands to the server", async () => {
    const { store, backend } = await setup();
    store.dispatch(add("n_a"));
    store.dispatch(move("n_a", 300));
    expect(store.getState().history).toEqual({ canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0 });
    store.undo();
    expect(store.getState().doc!.flows[0]!.nodes.find((n) => n.id === "n_a")!.position.x).toBe(100);
    store.undo();
    expect(nodeIds(store)).toEqual(["n_in", "n_out"]);
    expect(store.getState().history).toEqual({ canUndo: false, canRedo: true, undoDepth: 0, redoDepth: 2 });
    expect(store.undo()).toBeUndefined();
    store.redo();
    expect(nodeIds(store)).toEqual(["n_in", "n_out", "n_a"]);
    await store.flush();
    const sent = backend.applyCalls.map((c) => c.commands);
    expect(sent[2]).toEqual([{ op: "node.move", flowId: "flow_a", nodeId: "n_a", position: { x: 100, y: 0 }, restore: true }]);
    expect(sent[3]).toEqual([{ op: "node.remove", flowId: "flow_a", nodeId: "n_a", restore: true }]);
    expect(sent[4]).toEqual([{ ...add("n_a"), restore: true }]);
    expect(backend.applyCalls.map((c) => c.baseRevision)).toEqual([0, 1, 2, 3, 4]);
    expect(backend.doc.flows[0]).toEqual(store.getState().doc!.flows[0]);
  });

  it("a new batch clears the redo stack; viewport changes record no undo step and keep it", async () => {
    const { store } = await setup();
    store.dispatch(add("n_a"));
    store.undo();
    store.dispatch({ op: "flow.setViewport", flowId: "flow_a", viewport: { x: 1, y: 2, zoom: 1 } });
    expect(store.getState().history).toMatchObject({ canUndo: false, canRedo: true });
    store.dispatch(add("n_b"));
    expect(store.getState().history).toMatchObject({ canUndo: true, canRedo: false, undoDepth: 1 });
  });

  it("respects historyLimit", async () => {
    const { store } = await setup({ historyLimit: 2 });
    store.dispatch(add("n_a"));
    store.dispatch(add("n_b"));
    store.dispatch(add("n_c"));
    expect(store.getState().history.undoDepth).toBe(2);
  });
});

describe("selection, active flow and viewport", () => {
  it("selects with replace / add / toggle / remove and prunes deleted items", async () => {
    const { store } = await setup();
    store.dispatch(add("n_a"));
    store.select({ nodes: ["n_a"] });
    store.select({ nodes: ["n_in"] }, "add");
    expect(store.getState().selection.nodes).toEqual(["n_a", "n_in"]);
    store.select({ nodes: ["n_in", "n_out"] }, "toggle");
    expect(store.getState().selection.nodes).toEqual(["n_a", "n_out"]);
    store.select({ nodes: ["n_out"] }, "remove");
    expect(store.getState().selection.nodes).toEqual(["n_a"]);
    const sel = store.getState().selection;
    store.select({ nodes: ["n_a"] }, "add");
    expect(store.getState().selection).toBe(sel); // unchanged → same reference
    store.undo(); // removes n_a
    expect(store.getState().selection.nodes).toEqual([]);
    store.select({ nodes: ["n_in"], edges: ["e_1"] });
    store.clearSelection();
    expect(store.getState().selection).toEqual({ nodes: [], edges: [] });
  });

  it("changing the active flow clears the selection", async () => {
    const { store } = await setup();
    store.select({ nodes: ["n_in"] });
    store.setActiveFlow("flow_b");
    expect(store.getState().activeFlowId).toBe("flow_b");
    expect(store.getState().selection.nodes).toEqual([]);
  });

  it("updates the live viewport at once and persists it debounced without an undo step", async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend(baseDoc(), fakeApplier, catalog);
      const store = createEditorStore({ backend, contextId: "ctx_1", catalog, applier: fakeApplier, viewportPersistMs: 200 });
      await vi.runAllTimersAsync();
      await store.ready;
      store.setViewport("flow_a", { x: 1, y: 1, zoom: 1 });
      store.setViewport("flow_a", { x: 5, y: 6, zoom: 2 });
      expect(store.getState().viewports.flow_a).toEqual({ x: 5, y: 6, zoom: 2 });
      expect(store.getState().doc!.flows[0]!.ui).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(store.getState().doc!.flows[0]!.ui).toEqual({ viewport: { x: 5, y: 6, zoom: 2 } });
      expect(store.getState().history.canUndo).toBe(false);
      await vi.runAllTimersAsync();
      expect(backend.applyCalls.map((c) => c.commands)).toEqual([
        [{ op: "flow.setViewport", flowId: "flow_a", viewport: { x: 5, y: 6, zoom: 2 } }],
      ]);
      store.persistViewport(); // nothing new
      await vi.runAllTimersAsync();
      expect(backend.applyCalls).toHaveLength(1);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscription semantics", () => {
  it("notifies synchronously, gives immutable snapshots and stable references, and unsubscribes", async () => {
    const { store } = await setup();
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState()));
    const s0 = store.getState();
    expect(store.getState()).toBe(s0); // stable while unchanged
    store.dispatch(add("n_a"));
    expect(seen.length).toBeGreaterThan(0);
    const s1 = store.getState();
    expect(s1).not.toBe(s0);
    expect(s0.doc!.flows[0]!.nodes).toHaveLength(2); // old snapshot untouched
    expect(s1.selection).toBe(s0.selection);
    expect(s1.notices).toBe(s0.notices);
    expect(s1.viewports).toBe(s0.viewports);
    expect(s1.catalog).toBe(s0.catalog);
    await store.flush();
    const count = seen.length;
    store.select({}); // no-op
    expect(seen.length).toBe(count);
    unsubscribe();
    store.dispatch(add("n_b"));
    expect(seen.length).toBe(count);
  });

  it("a throwing listener does not break other listeners", async () => {
    const { store } = await setup();
    const ok = vi.fn();
    store.subscribe(() => {
      throw new Error("bad listener");
    });
    store.subscribe(ok);
    expect(store.dispatch(add("n_a")).ok).toBe(true);
    expect(ok).toHaveBeenCalled();
  });

  it("works with a useSyncExternalStore-style consumer (getSnapshot is cached)", async () => {
    const { store } = await setup();
    // useSyncExternalStore requires getSnapshot() to return the same value until a change.
    const a = store.getState();
    const b = store.getState();
    expect(a).toBe(b);
  });
});
