/**
 * `createEditorStore`: optimistic local application through `@briarflow/authoring`,
 * serialized server sync, command-based undo/redo, UI state and run tracking.
 */
import { CommandError, applyCommands } from "@briarflow/authoring";
import type { ApplyResult, BatchResult, Command } from "@briarflow/authoring";
import type { NodeTypesInfo } from "@briarflow/client";
import { BriarError, createCatalogFromDescriptors, createIdGenerator, nodeDefinition, serializeError, validateContext } from "@briarflow/core";
import type { ContextDocument, Diagnostic, NodeCatalog, Run, RunEvent, RunResult, SerializedError, Viewport } from "@briarflow/core";
import { isCommandRejection, isRevisionConflict } from "./backend.js";
import { completeRun, reduceRunEvent } from "./run-state.js";
import { CONSOLE_LIMIT, DEFAULT_FRONTEND_NODES } from "./frontend.js";
import type { ConsoleLine } from "./frontend.js";
import { readRunInputs, writeRunInputs } from "./run-inputs.js";
import type { RunState } from "./run-state.js";
import type {
  EditorListener,
  EditorNotice,
  EditorState,
  EditorStore,
  EditorStoreOptions,
  HistoryState,
  SelectMode,
  Selection,
  StartRunOptions,
  SyncState,
} from "./types.js";

/** One undo step (mutable internally: redo / rebase refresh `inverse`). */
interface Entry {
  commands: readonly Command[];
  inverse: readonly Command[];
}

/** A batch applied locally and not yet confirmed by the backend. */
interface Pending {
  kind: "apply" | "undo" | "redo";
  commands: readonly Command[];
  entry: Entry | undefined;
  after: ContextDocument;
}

type Success = Extract<BatchResult, { ok: true }>;

const EMPTY_SELECTION: Selection = { nodes: [], edges: [] };
const EMPTY_HISTORY: HistoryState = { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };
const IDLE_SYNC: SyncState = { status: "idle", pending: 0 };
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected"]);

/**
 * Creates a headless editor store for one context.
 *
 * @example
 * ```ts
 * const store = createEditorStore({ backend: clientBackend(client), contextId: "ctx_1" });
 * await store.ready;
 * store.dispatch({ op: "node.move", flowId: "flow_p", nodeId: "n_1", position: { x: 10, y: 20 } });
 * store.undo();
 * // React: const state = useSyncExternalStore(store.subscribe, store.getState);
 * ```
 */
export function createEditorStore(options: EditorStoreOptions): EditorStore {
  const { backend, contextId } = options;
  const apply = options.applier ?? applyCommands;
  const idGenerator = options.idGenerator ?? createIdGenerator();
  const clock = options.clock ?? (() => new Date());
  const historyLimit = options.historyLimit ?? 200;
  const viewportDelay = options.viewportPersistMs === undefined ? 400 : options.viewportPersistMs;

  let state: EditorState = {
    contextId,
    status: "loading",
    doc: undefined,
    diagnostics: [],
    nodeTypes: undefined,
    catalog: undefined,
    approximateNodeTypes: [],
    serverRevision: undefined,
    sync: IDLE_SYNC,
    history: EMPTY_HISTORY,
    activeFlowId: undefined,
    selection: EMPTY_SELECTION,
    viewports: {},
    run: undefined,
    runInputs: options.runInputsStorage ? readRunInputs(options.runInputsStorage, contextId) : {},
    useCache: true,
    console: [],
    notices: [],
  };
  const frontendNodes = options.frontendNodes ?? DEFAULT_FRONTEND_NODES;
  let consoleId = 0;
  const listeners = new Set<EditorListener>();

  let confirmed: ContextDocument | undefined;
  let queue: Pending[] = [];
  let undoStack: Entry[] = [];
  let redoStack: Entry[] = [];
  let pumping = false;
  let syncError: { error: unknown } | undefined;
  /** Bumped whenever the document is replaced wholesale; stale async work checks it. */
  let generation = 0;
  let noticeId = 0;
  let disposed = false;
  const abort = new AbortController();
  let flushWaiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  let viewportTimer: ReturnType<typeof setTimeout> | undefined;
  let currentRun: Run | undefined;
  let runToken = 0;

  // ---- state plumbing ---------------------------------------------------------------------

  function set(patch: Partial<EditorState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof EditorState)[]) {
      if (state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failing listener must not break the store or other listeners.
      }
    }
  }

  function historyState(): HistoryState {
    const prev = state.history;
    const next = { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoDepth: undoStack.length, redoDepth: redoStack.length };
    return prev.undoDepth === next.undoDepth && prev.redoDepth === next.redoDepth ? prev : next;
  }

  function syncState(): SyncState {
    const prev = state.sync;
    const status: SyncState["status"] = syncError ? "error" : queue.length > 0 ? "syncing" : "idle";
    if (prev.status === status && prev.pending === queue.length && prev.error === syncError?.error) return prev;
    return syncError ? { status, pending: queue.length, error: syncError.error } : { status, pending: queue.length };
  }

  function notice(n: Omit<EditorNotice, "id">): Partial<EditorState> {
    return { notices: [...state.notices, { id: ++noticeId, ...n }] };
  }

  /** Patch for a new local document: diagnostics, pruned selection, valid active flow. */
  function docPatch(doc: ContextDocument, diagnostics: readonly Diagnostic[]): Partial<EditorState> {
    let activeFlowId = state.activeFlowId;
    if (activeFlowId === undefined || !doc.flows.some((f) => f.id === activeFlowId)) activeFlowId = doc.flows[0]?.id;
    const flow = doc.flows.find((f) => f.id === activeFlowId);
    let selection = activeFlowId === state.activeFlowId ? state.selection : EMPTY_SELECTION;
    if (selection !== EMPTY_SELECTION) {
      const nodeIds = new Set(flow?.nodes.map((n) => n.id));
      const edgeIds = new Set(flow?.edges.map((e) => e.id));
      const nodes = selection.nodes.filter((id) => nodeIds.has(id));
      const edges = selection.edges.filter((id) => edgeIds.has(id));
      if (nodes.length !== selection.nodes.length || edges.length !== selection.edges.length) selection = { nodes, edges };
    }
    return { doc, diagnostics, activeFlowId, selection };
  }

  function catalogOrThrow(): NodeCatalog {
    if (!state.catalog) throw new BriarError("editor.not_ready", "The editor has no node catalog yet. Wait for store.ready.");
    return state.catalog;
  }

  function run(doc: ContextDocument, commands: readonly Command[]): BatchResult {
    return apply(doc, commands, { catalog: catalogOrThrow(), idGenerator, clock });
  }

  // ---- loading ----------------------------------------------------------------------------

  async function loadCatalog(): Promise<Pick<EditorState, "catalog" | "nodeTypes" | "approximateNodeTypes">> {
    if (options.catalog) {
      const c = options.catalog;
      const nodeTypes: NodeTypesInfo = {
        packs: c.packs.map((p) => ({ name: p.name, version: p.version, title: p.title })),
        nodes: c.descriptors(),
        types: [...c.types],
      };
      return { catalog: c, nodeTypes, approximateNodeTypes: [] };
    }
    const nodeTypes = await backend.nodeTypes(abort.signal);
    const catalog = createCatalogFromDescriptors(nodeTypes, options.localPacks ? { localPacks: options.localPacks } : {});
    return { catalog, nodeTypes, approximateNodeTypes: [...catalog.approximateTypes] };
  }

  async function load(conflict?: { dropped: number; error: unknown }): Promise<void> {
    const gen = ++generation;
    const dropped = queue.length;
    queue = [];
    undoStack = [];
    redoStack = [];
    syncError = undefined;
    clearViewportTimer();
    set({ status: state.doc ? "reloading" : "loading", sync: syncState(), history: historyState() });
    rejectFlushWaiters(new BriarError("editor.reloaded", "Unsynced changes were discarded because the document was reloaded."));
    try {
      const [doc, cat] = await Promise.all([backend.load(contextId, abort.signal), state.catalog && !options.catalog && conflict ? Promise.resolve(undefined) : loadCatalog()]);
      if (disposed || gen !== generation) return;
      const catalogPatch = cat ?? {};
      const catalog = cat?.catalog ?? catalogOrThrow();
      confirmed = doc;
      if (state.activeFlowId === undefined && options.flowId !== undefined) state = { ...state, activeFlowId: options.flowId };
      const n = conflict
        ? notice({
            kind: "conflict",
            message:
              dropped > 0
                ? `The document was changed elsewhere. It was reloaded and ${dropped} unsaved change${dropped === 1 ? " was" : "s were"} discarded.`
                : "The document was changed elsewhere and has been reloaded.",
            error: conflict.error,
            dropped,
          })
        : {};
      set({
        ...catalogPatch,
        ...docPatch(doc, validateContext(doc, catalog)),
        ...n,
        status: "ready",
        error: undefined,
        serverRevision: doc.revision,
        viewports: {},
        sync: syncState(),
        history: historyState(),
      });
      // Flows made before execution lines get wired once (saved like any edit).
      const unwired = doc.flows.filter((f) => f.execEdges === undefined).map((f) => ({ op: "flow.exec.enable" as const, flowId: f.id }));
      if (unwired.length > 0) dispatchBatch(unwired);
    } catch (error) {
      if (disposed || gen !== generation) return;
      set({
        status: "error",
        error,
        ...notice({ kind: "load_failed", message: `Could not load the document: ${messageOf(error)}`, error }),
      });
    }
  }

  // ---- local application ------------------------------------------------------------------

  function notReady(): CommandError {
    return new CommandError(
      "editor.not_ready",
      state.status === "reloading"
        ? "The document is being reloaded. Try again in a moment."
        : "The document is not loaded yet. Wait for store.ready (or check state.error).",
    );
  }

  function enqueue(kind: Pending["kind"], r: Success, entry: Entry | undefined, patch: Partial<EditorState> = {}): void {
    queue.push({ kind, commands: r.resolved, entry, after: r.doc });
    set({ ...docPatch(r.doc, r.diagnostics), ...patch, history: historyState(), sync: syncState() });
    void pump();
  }

  function dispatchBatch(commands: readonly Command[]): BatchResult {
    if (state.status !== "ready" || !state.doc) return { ok: false, error: notReady() };
    const r = run(state.doc, commands);
    if (!r.ok || !r.changed) return r;
    let entry: Entry | undefined;
    // Viewport saves and auto-wiring of execution lines on load are not user edits: no undo step.
    if (!commands.every((c) => c.op === "flow.setViewport" || c.op === "flow.exec.enable")) {
      entry = { commands: r.resolved, inverse: r.inverse };
      undoStack.push(entry);
      if (undoStack.length > historyLimit) undoStack.splice(0, undoStack.length - historyLimit);
      redoStack = [];
    }
    enqueue("apply", r, entry);
    return r;
  }

  function dispatch(command: Command): ApplyResult;
  function dispatch(commands: readonly Command[]): BatchResult;
  function dispatch(input: Command | readonly Command[]): ApplyResult | BatchResult {
    if (Array.isArray(input)) return dispatchBatch(input as readonly Command[]);
    const r = dispatchBatch([input as Command]);
    if (!r.ok) return r;
    return { ...r, created: r.created[0] ?? {} };
  }

  function undo(): BatchResult | undefined {
    const entry = undoStack.at(-1);
    if (!entry || state.status !== "ready" || !state.doc) return undefined;
    const r = run(state.doc, entry.inverse);
    if (!r.ok) return r;
    undoStack.pop();
    redoStack.push(entry);
    if (r.changed) enqueue("undo", r, entry);
    else set({ history: historyState() });
    return r;
  }

  function redo(): BatchResult | undefined {
    const entry = redoStack.at(-1);
    if (!entry || state.status !== "ready" || !state.doc) return undefined;
    const r = run(
      state.doc,
      entry.commands.map((c) => ({ ...c, restore: true }) as Command),
    );
    if (!r.ok) return r;
    entry.inverse = r.inverse;
    redoStack.pop();
    undoStack.push(entry);
    if (r.changed) enqueue("redo", r, entry);
    else set({ history: historyState() });
    return r;
  }

  function removeEntry(entry: Entry | undefined): void {
    if (!entry) return;
    undoStack = undoStack.filter((e) => e !== entry);
    redoStack = redoStack.filter((e) => e !== entry);
  }

  /** Re-applies `items` on `base`; items that no longer apply are dropped with their undo step. */
  function replay(base: ContextDocument, items: readonly Pending[]): { doc: ContextDocument; diagnostics?: Diagnostic[]; kept: Pending[]; dropped: number } {
    let doc = base;
    let diagnostics: Diagnostic[] | undefined;
    const kept: Pending[] = [];
    let dropped = 0;
    for (const item of items) {
      const r = run(doc, item.commands);
      if (!r.ok) {
        removeEntry(item.entry);
        dropped++;
        continue;
      }
      if (item.entry && item.kind !== "undo") item.entry.inverse = r.inverse;
      item.after = r.doc;
      doc = r.doc;
      diagnostics = r.diagnostics;
      kept.push(item);
    }
    return diagnostics ? { doc, diagnostics, kept, dropped } : { doc, kept, dropped };
  }

  // ---- server sync ------------------------------------------------------------------------

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      while (!disposed && !syncError && state.status === "ready" && queue.length > 0) {
        const gen = generation;
        const item = queue[0]!;
        const baseRevision = state.serverRevision ?? 0;
        let res;
        try {
          res = await backend.apply(contextId, { baseRevision, commands: item.commands }, abort.signal);
        } catch (error) {
          if (disposed || gen !== generation) return;
          if (isRevisionConflict(error)) {
            pumping = false;
            await load({ dropped: queue.length, error });
            return;
          }
          if (isCommandRejection(error)) {
            rollback(item, error);
            continue;
          }
          syncError = { error };
          set({
            sync: syncState(),
            ...notice({ kind: "sync_failed", message: `Could not save changes: ${messageOf(error)}. Retry or reload.`, error }),
          });
          rejectFlushWaiters(error);
          return;
        }
        if (disposed || gen !== generation) return;
        queue.shift();
        if (res.revision === item.after.revision) {
          confirmed = item.after;
          set({ serverRevision: res.revision, sync: syncState() });
        } else {
          // The backend counted differently (should not happen): adopt its revision and rebase.
          confirmed = { ...item.after, revision: res.revision };
          const rebased = replay(confirmed, queue);
          queue = rebased.kept;
          const diagnostics = rebased.diagnostics ?? validateContext(rebased.doc, catalogOrThrow());
          set({ ...docPatch(rebased.doc, diagnostics), serverRevision: res.revision, sync: syncState(), history: historyState() });
        }
      }
    } finally {
      pumping = false;
      if (queue.length === 0 && !syncError) resolveFlushWaiters();
    }
  }

  /** 422: drop the rejected batch, rebuild the local document from the confirmed one. */
  function rollback(item: Pending, error: unknown): void {
    queue.shift();
    removeEntry(item.entry);
    const base = confirmed!;
    const rebuilt = replay(base, queue);
    queue = rebuilt.kept;
    const diagnostics = rebuilt.diagnostics ?? validateContext(rebuilt.doc, catalogOrThrow());
    set({
      ...docPatch(rebuilt.doc, diagnostics),
      history: historyState(),
      sync: syncState(),
      ...notice({
        kind: "rejected",
        message: `The server rejected a change and it was undone: ${messageOf(error)}`,
        error,
        commands: item.commands,
        dropped: rebuilt.dropped,
      }),
    });
  }

  function flush(): Promise<void> {
    if (syncError) return Promise.reject(syncError.error);
    if (queue.length === 0 && !pumping) return Promise.resolve();
    return new Promise((resolve, reject) => flushWaiters.push({ resolve, reject }));
  }

  function resolveFlushWaiters(): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const w of waiters) w.resolve();
  }

  function rejectFlushWaiters(error: unknown): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const w of waiters) w.reject(error);
  }

  function retrySync(): void {
    if (!syncError) return;
    syncError = undefined;
    set({ sync: syncState() });
    void pump();
  }

  // ---- UI state ---------------------------------------------------------------------------

  function setActiveFlow(flowId: string | undefined): void {
    if (flowId === state.activeFlowId) return;
    set({ activeFlowId: flowId, selection: EMPTY_SELECTION });
  }

  function select(sel: Partial<Selection>, mode: SelectMode = "replace"): void {
    const combine = (current: readonly string[], ids: readonly string[] | undefined): readonly string[] => {
      if (mode === "replace") return ids ? [...new Set(ids)] : [];
      if (!ids || ids.length === 0) return current;
      if (mode === "add") return [...current, ...ids.filter((id) => !current.includes(id))];
      if (mode === "remove") return current.filter((id) => !ids.includes(id));
      const toggled = current.filter((id) => !ids.includes(id));
      return [...toggled, ...ids.filter((id) => !current.includes(id))];
    };
    const nodes = combine(state.selection.nodes, sel.nodes);
    const edges = combine(state.selection.edges, sel.edges);
    if (sameList(nodes, state.selection.nodes) && sameList(edges, state.selection.edges)) return;
    set({ selection: nodes.length === 0 && edges.length === 0 ? EMPTY_SELECTION : { nodes, edges } });
  }

  function setViewport(flowId: string, viewport: Viewport): void {
    const prev = state.viewports[flowId];
    if (prev && sameViewport(prev, viewport)) return;
    set({ viewports: { ...state.viewports, [flowId]: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } } });
    if (viewportDelay === null) return;
    clearViewportTimer();
    viewportTimer = setTimeout(() => {
      viewportTimer = undefined;
      persistViewport();
    }, viewportDelay);
  }

  function persistViewport(flowId?: string): void {
    if (flowId === undefined) clearViewportTimer();
    const doc = state.doc;
    if (!doc || state.status !== "ready") return;
    const commands: Command[] = [];
    for (const [id, viewport] of Object.entries(state.viewports)) {
      if (flowId !== undefined && id !== flowId) continue;
      const flow = doc.flows.find((f) => f.id === id);
      if (!flow) continue;
      const saved = flow.ui?.viewport;
      if (saved && sameViewport(saved, viewport)) continue;
      commands.push({ op: "flow.setViewport", flowId: id, viewport });
    }
    if (commands.length > 0) dispatchBatch(commands);
  }

  function clearViewportTimer(): void {
    if (viewportTimer !== undefined) clearTimeout(viewportTimer);
    viewportTimer = undefined;
  }

  // ---- runs -------------------------------------------------------------------------------

  async function startRun(opts: StartRunOptions = {}): Promise<Run> {
    const flowId = opts.flowId ?? state.activeFlowId;
    if (flowId === undefined) throw new BriarError("editor.no_flow", "startRun needs a flow: pass { flowId } or set an active flow.");
    persistViewport();
    await flush();
    const token = ++runToken;
    currentRun = undefined;
    const inputs = opts.inputs ?? storedInputs(flowId);
    const useCache = opts.useCache ?? state.useCache;
    set({ run: { runId: undefined, flowId, status: "starting", nodes: {}, lastSeq: -1, events: [] } });
    let started: Run;
    try {
      started = await backend.run(flowId, inputs, { ...(useCache ? {} : { useCache: false }), signal: abort.signal });
    } catch (error) {
      if (token === runToken && !disposed) {
        const err = serializeError(error);
        set({ run: { runId: undefined, flowId, status: "rejected", nodes: {}, lastSeq: -1, events: [], error: err } });
        logRejection(flowId, err);
      }
      throw error;
    }
    if (token !== runToken || disposed) return started;
    currentRun = started;
    set({ run: { runId: started.id, flowId, status: started.status, nodes: {}, lastSeq: -1, events: [] } });
    void track(started, token);
    return started;
  }

  async function track(r: Run, token: number): Promise<void> {
    const live = () => token === runToken && !disposed;
    try {
      for await (const event of r.events()) {
        if (!live()) return;
        const current = state.run;
        if (!current) continue;
        const next = reduceRunEvent(current, event);
        if (next === current) continue;
        set({ run: next });
        logEvent(r.id, current.flowId, event);
        if (event.type === "node.completed") runFrontendNode(r.id, event.nodeId);
      }
    } catch {
      // Stream lost: the result below still settles.
    }
    const result = await r.result;
    if (!live()) return;
    const current = state.run;
    if (current && !TERMINAL.has(current.status)) {
      set({ run: completeRun(current, result) });
      logResult(current.flowId, result);
    }
  }

  function storedInputs(flowId: string): Record<string, unknown> {
    const flow = state.doc?.flows.find((f) => f.id === flowId);
    const typed = state.runInputs[flowId] ?? {};
    const values: Record<string, unknown> = {};
    for (const f of flow?.inputs ?? []) if (typed[f.name] !== undefined) values[f.name] = typed[f.name];
    return values;
  }

  function setRunInput(flowId: string, name: string, value: unknown): void {
    const current = { ...(state.runInputs[flowId] ?? {}) };
    if (value === undefined) delete current[name];
    else current[name] = value;
    const runInputs = { ...state.runInputs, [flowId]: current };
    set({ runInputs });
    if (options.runInputsStorage) writeRunInputs(options.runInputsStorage, contextId, runInputs);
  }

  // ---- console ----------------------------------------------------------------------------

  function writeLine(line: Omit<ConsoleLine, "id" | "at">): void {
    const lines = [...state.console, { id: ++consoleId, at: clock().toISOString(), ...line }];
    set({ console: lines.length > CONSOLE_LIMIT ? lines.slice(lines.length - CONSOLE_LIMIT) : lines });
  }

  function nodeInfo(flowId: string, nodeId: string): { title: string; nodeType?: string } {
    const node = state.doc?.flows.find((f) => f.id === flowId)?.nodes.find((n) => n.id === nodeId);
    if (!node) return { title: nodeId };
    const def = state.catalog?.get(node.type);
    const title = node.title?.trim() || (node.type === "briar.input" ? "Input" : node.type === "briar.output" ? "Output" : def?.title) || node.type;
    return { title, nodeType: node.type };
  }

  function flowName(flowId: string): string {
    return state.doc?.flows.find((f) => f.id === flowId)?.name ?? flowId;
  }

  function errorLine(runId: string | undefined, flowId: string, error: SerializedError, nodeId = error.nodeId): void {
    const where = nodeId ? { nodeId, ...nodeInfo(flowId, nodeId) } : { title: flowName(flowId) };
    writeLine({ kind: "error", runId, ...where, code: error.code, text: error.message });
  }

  function logEvent(runId: string, flowId: string, event: RunEvent): void {
    switch (event.type) {
      case "run.started":
        writeLine({ kind: "info", runId, title: flowName(flowId), text: `Run ${runId} started` });
        return;
      case "node.retrying":
        writeLine({
          kind: "warning",
          runId,
          nodeId: event.nodeId,
          ...nodeInfo(flowId, event.nodeId),
          code: event.error.code,
          text: `${event.error.message} (retry ${event.nextAttempt} in ${Math.round(event.delayMs)} ms)`,
        });
        return;
      case "node.failed":
        errorLine(runId, flowId, event.error, event.nodeId);
        return;
      case "run.completed":
        logResult(flowId, event.result);
        return;
      default:
        return;
    }
  }

  function logResult(flowId: string, result: RunResult): void {
    const nodeFailed = state.console.some((l) => l.runId === result.runId && l.kind === "error" && l.nodeId !== undefined);
    if (result.error && !(result.error.code === "run.node_failed" && nodeFailed)) errorLine(result.runId, flowId, result.error);
    for (const [name, value] of Object.entries(result.outputs ?? {})) {
      writeLine({ kind: "output", runId: result.runId, title: name, text: previewText(value), value });
    }
    const took = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
    const ms = Number.isFinite(took) ? ` in ${took} ms` : "";
    writeLine({ kind: result.status === "succeeded" ? "info" : "error", runId: result.runId, title: flowName(flowId), text: `Run ${result.status}${ms}` });
  }

  function logRejection(flowId: string, error: SerializedError): void {
    errorLine(undefined, flowId, error);
    const list = (error.details as { diagnostics?: unknown } | undefined)?.diagnostics;
    if (!Array.isArray(list)) return;
    for (const d of list as Partial<Diagnostic>[]) {
      if (typeof d?.code !== "string" || typeof d.message !== "string") continue;
      const nodeId = d.path?.nodeId;
      const where = nodeId ? { nodeId, ...nodeInfo(d.path?.flowId ?? flowId, nodeId) } : { title: flowName(flowId) };
      writeLine({ kind: d.severity === "warning" ? "warning" : "error", runId: undefined, ...where, code: d.code, text: d.message });
    }
  }

  function cancelRun(reason?: string): void {
    currentRun?.cancel(reason);
  }

  function runFrontendNode(runId: string | undefined, nodeId: string): void {
    const flow = state.doc?.flows.find((f) => f.nodes.some((n) => n.id === nodeId));
    const node = flow?.nodes.find((n) => n.id === nodeId);
    const def = node ? (state.catalog ? nodeDefinition(state.catalog, node) : undefined) : undefined;
    const handler = node && def?.frontend ? frontendNodes[node.type] : undefined;
    if (!flow || !node || !def || !handler) return;
    const inputs: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(def.inputs)) {
      const edge = flow.edges.find((e) => e.to.node === nodeId && e.to.port === name);
      if (edge) {
        const source = state.run?.nodes[edge.from.node]?.outputs;
        if (source && Object.prototype.hasOwnProperty.call(source, edge.from.port)) inputs[name] = source[edge.from.port];
      } else if (node.values && Object.prototype.hasOwnProperty.call(node.values, name)) {
        inputs[name] = node.values[name];
      } else if (typeof spec === "object" && spec !== null && "default" in spec) {
        inputs[name] = (spec as { default?: unknown }).default;
      }
    }
    const title = node.title?.trim() || def?.title || node.type;
    const print = (text: string) => writeLine({ kind: "print", runId, nodeId, nodeType: node.type, title, text: String(text) });
    try {
      handler({ runId, nodeId, title, inputs, print });
    } catch (err) {
      print(`(frontend node failed: ${messageOf(err)})`);
    }
  }

  function clearConsole(): void {
    set({ console: [] });
  }

  function clearRun(): void {
    runToken++;
    currentRun = undefined;
    set({ run: undefined });
  }

  // ---- misc -------------------------------------------------------------------------------

  function dismissNotice(id: number): void {
    const notices = state.notices.filter((n) => n.id !== id);
    if (notices.length !== state.notices.length) set({ notices });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearViewportTimer();
    abort.abort();
    runToken++;
    rejectFlushWaiters(new BriarError("editor.disposed", "The editor store was disposed."));
    listeners.clear();
  }

  const ready = options.autoLoad === false ? Promise.resolve() : load();

  const store: EditorStore = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ready,
    load: () => load(),
    dispatch,
    undo,
    redo,
    flush,
    retrySync,
    setActiveFlow,
    select,
    clearSelection: () => select({}, "replace"),
    setViewport,
    persistViewport,
    startRun,
    cancelRun,
    clearRun,
    setRunInput,
    setUseCache: (useCache) => set({ useCache }),
    clearConsole,
    dismissNotice,
    dispose,
  };
  return store;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function previewText(value: unknown): string {
  if (value === null || value === undefined) return "[none]";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Type guard re-export for tests and UIs: is the run state finished? */
export function isRunFinished(run: RunState | undefined): boolean {
  return run !== undefined && TERMINAL.has(run.status);
}
