/**
 * Public types of the editor store.
 */
import type { ApplyResult, BatchResult, Command, applyCommands } from "@briarflow/authoring";
import type { NodeTypesInfo } from "@briarflow/client";
import type { Clock, ContextDocument, Diagnostic, IdGenerator, NodeCatalog, NodePack, Run, Viewport } from "@briarflow/core";
import type { EditorBackend } from "./backend.js";
import type { RunState } from "./run-state.js";

/** Lifecycle of the store's document. */
export type EditorStatus = "loading" | "ready" | "reloading" | "error";

/** Server sync of locally applied batches. */
export interface SyncState {
  /** `error`: a transient failure paused syncing; call `retrySync()` (or `load()` to discard). */
  readonly status: "idle" | "syncing" | "error";
  /** Batches applied locally and not yet confirmed (including the one in flight). */
  readonly pending: number;
  readonly error?: unknown;
}

/** Undo/redo availability. */
export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

/** Selected nodes and edges of the active flow. */
export interface Selection {
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
}

/** How {@link EditorStore.select} combines with the current selection. */
export type SelectMode = "replace" | "add" | "toggle" | "remove";

/** Kinds of {@link EditorNotice}. */
export type EditorNoticeKind = "conflict" | "rejected" | "sync_failed" | "load_failed";

/**
 * Something the UI should tell the user.
 * - `conflict`: the document changed on the server (409); the store reloaded it and dropped
 *   `dropped` unsynced batches and the undo history.
 * - `rejected`: the server refused a batch (422); it was rolled back locally (`commands`,
 *   `error`). `dropped` counts later local batches that no longer applied and were discarded.
 * - `sync_failed`: a network / server failure paused syncing (`error`).
 * - `load_failed`: loading the document or node types failed (`error`).
 */
export interface EditorNotice {
  readonly id: number;
  readonly kind: EditorNoticeKind;
  readonly message: string;
  readonly error?: unknown;
  readonly commands?: readonly Command[];
  readonly dropped?: number;
}

/**
 * Immutable state snapshot. A new object is created on every change; nested objects keep
 * their identity while unchanged, so selectors can compare by reference.
 */
export interface EditorState {
  readonly contextId: string;
  readonly status: EditorStatus;
  /** Load error when `status` is `error`. */
  readonly error?: unknown;
  /** Current local document (server state plus pending local batches). */
  readonly doc: ContextDocument | undefined;
  /** `validateContext` output for `doc`. */
  readonly diagnostics: readonly Diagnostic[];
  /** Palette data: packs, node descriptors, pack types. */
  readonly nodeTypes: NodeTypesInfo | undefined;
  readonly catalog: NodeCatalog | undefined;
  /** Dynamic-port node types known only from descriptors (local port checks are approximate). */
  readonly approximateNodeTypes: readonly string[];
  /** Last revision confirmed by the backend. */
  readonly serverRevision: number | undefined;
  readonly sync: SyncState;
  readonly history: HistoryState;
  readonly activeFlowId: string | undefined;
  readonly selection: Selection;
  /** Live canvas viewports by flow id (persisted to the document debounced). */
  readonly viewports: Readonly<Record<string, Viewport>>;
  readonly run: RunState | undefined;
  readonly notices: readonly EditorNotice[];
}

/** The batch applier (defaults to `applyCommands` from `@briarflow/authoring`). */
export type CommandApplier = typeof applyCommands;

/** Options of {@link createEditorStore}. */
export interface EditorStoreOptions {
  /** Where the document lives. Use `clientBackend(client)` for a server. */
  backend: EditorBackend;
  contextId: string;
  /** Ids for created entities. Default: random (`createIdGenerator()`), so ids never collide with the server's. */
  idGenerator?: IdGenerator;
  clock?: Clock;
  /** Catalog to use instead of building one from `backend.nodeTypes()`. */
  catalog?: NodeCatalog;
  /** Packs whose code is available here (e.g. `stdPack`), preferred over descriptors. */
  localPacks?: readonly NodePack[];
  /** Initially active flow. Default: the first flow. */
  flowId?: string;
  /** Undo depth. Default 200. */
  historyLimit?: number;
  /** Delay before a viewport change is saved as `flow.setViewport`. Default 400 ms; `null` = only `persistViewport()`. */
  viewportPersistMs?: number | null;
  /** Default true: start loading immediately. */
  autoLoad?: boolean;
  /** Replaces `applyCommands` (tests, instrumentation). */
  applier?: CommandApplier;
}

/** Options of {@link EditorStore.startRun}. */
export interface StartRunOptions {
  /** Default: the active flow. */
  flowId?: string;
  inputs?: Record<string, unknown>;
  useCache?: boolean;
}

/** Listener of {@link EditorStore.subscribe}. Called synchronously after every state change. */
export type EditorListener = () => void;

/**
 * Headless editor store. Works with React's `useSyncExternalStore(store.subscribe, store.getState)`
 * and with any other framework.
 */
export interface EditorStore {
  getState(): EditorState;
  subscribe(listener: EditorListener): () => void;
  /** Settles after the first load attempt (never rejects; see `status` / `error`). */
  readonly ready: Promise<void>;
  /** (Re)loads the document and node types. Discards unsynced batches and the history. */
  load(): Promise<void>;
  /**
   * Applies commands locally (instant), records an undo step and queues them for the server.
   * Returns the local result; a rejected command changes nothing.
   */
  dispatch(command: Command): ApplyResult;
  dispatch(commands: readonly Command[]): BatchResult;
  /** Undoes the last step locally and syncs the inverse. `undefined` when nothing to undo. */
  undo(): BatchResult | undefined;
  /** Redoes the last undone step. `undefined` when nothing to redo. */
  redo(): BatchResult | undefined;
  /** Resolves once every pending batch is confirmed; rejects when syncing is paused by an error or the batches were dropped. */
  flush(): Promise<void>;
  /** Resumes syncing after a `sync_failed`. */
  retrySync(): void;
  /** Sets the active flow (clears the selection). */
  setActiveFlow(flowId: string | undefined): void;
  select(selection: Partial<Selection>, mode?: SelectMode): void;
  clearSelection(): void;
  /** Updates the live viewport now and saves it (no undo step) after `viewportPersistMs`. */
  setViewport(flowId: string, viewport: Viewport): void;
  /** Saves pending viewport changes now (all flows, or one). */
  persistViewport(flowId?: string): void;
  /** Waits for pending batches, then starts a run and tracks its events in `state.run`. */
  startRun(options?: StartRunOptions): Promise<Run>;
  /** Cancels the current run (no-op when none or finished). */
  cancelRun(reason?: string): void;
  clearRun(): void;
  dismissNotice(id: number): void;
  /** Stops syncing, timers and run tracking. */
  dispose(): void;
}
