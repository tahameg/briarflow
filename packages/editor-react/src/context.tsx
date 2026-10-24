/**
 * React binding of the headless editor store: provider, selector hook, dispatch with error
 * reporting, and small shared UI state (local error toasts, canvas center for "add node").
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { ApplyResult, BatchResult, Command } from "@briarflow/authoring";
import type { FlowDocument, MediaEntry, MediaRef, Position } from "@briarflow/core";
import type { EditorState, EditorStore } from "@briarflow/editor";
import { ContextMenuProvider, useHasContextMenu } from "./components/ContextMenu.js";
import { buildFlowView } from "./graph.js";
import type { FlowView } from "./graph.js";

/** A message shown by `<EditorToasts>` for a locally rejected command. */
export interface LocalToast {
  id: number;
  message: string;
  code?: string;
}

/** What the canvas exposes to other panels (palette "add at center"). */
export interface CanvasHandle {
  /** Flow coordinates of the visible canvas center. */
  center(): Position;
}

interface EditorContextValue {
  store: EditorStore;
  mediaUrl: ((mediaId: string) => string) | undefined;
  uploadMedia: ((file: File) => Promise<MediaRef>) | undefined;
  mediaEntry: ((mediaId: string) => Promise<MediaEntry>) | undefined;
  toasts: readonly LocalToast[];
  pushToast(message: string, code?: string): void;
  dismissToast(id: number): void;
  canvas: { current: CanvasHandle | null };
}

const EditorContext = createContext<EditorContextValue | null>(null);

/** Props of {@link EditorProvider}. */
export interface EditorProviderProps {
  store: EditorStore;
  /** URL of a stored media file (`client.media.url`), for image previews. */
  mediaUrl?: (mediaId: string) => string;
  /** Upload for media inputs in the run form (`client.media.upload`). */
  uploadMedia?: (file: File) => Promise<MediaRef>;
  /** The registry entry of a media id (`client.media.entry`): mime, size, file name. */
  mediaEntry?: (mediaId: string) => Promise<MediaEntry>;
  children?: ReactNode;
}

/**
 * Makes an editor store available to the editor components.
 *
 * @example
 * ```tsx
 * <EditorProvider store={store} mediaUrl={(id) => client.media.url(id)}>
 *   <FlowCanvas />
 * </EditorProvider>
 * ```
 */
export function EditorProvider({ store, mediaUrl, uploadMedia, mediaEntry, children }: EditorProviderProps) {
  const [toasts, setToasts] = useState<LocalToast[]>([]);
  const nextId = useRef(0);
  const canvas = useRef<CanvasHandle | null>(null);
  const pushToast = useCallback((message: string, code?: string) => {
    const id = ++nextId.current;
    setToasts((t) => [...t.slice(-4), code === undefined ? { id, message } : { id, message, code }]);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const value = useMemo<EditorContextValue>(
    () => ({ store, mediaUrl, uploadMedia, mediaEntry, toasts, pushToast, dismissToast, canvas }),
    [store, mediaUrl, uploadMedia, mediaEntry, toasts, pushToast, dismissToast],
  );
  const hasMenu = useHasContextMenu();
  const body = <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
  // Editor menus work without an app-level provider; the app's provider decides about the browser menu.
  return hasMenu ? body : <ContextMenuProvider suppressBrowserMenu={false}>{body}</ContextMenuProvider>;
}

function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("Briarflow editor components must be rendered inside <EditorProvider store={…}>.");
  return ctx;
}

/** The store of the nearest `<EditorProvider>`. */
export function useEditorStore(): EditorStore {
  return useEditorContext().store;
}

/** Media helpers passed to the provider. */
export function useMedia(): { mediaUrl: ((mediaId: string) => string) | undefined; uploadMedia: ((file: File) => Promise<MediaRef>) | undefined } {
  const { mediaUrl, uploadMedia } = useEditorContext();
  return { mediaUrl, uploadMedia };
}

/**
 * The registry entry of a media value, once loaded (`undefined` while loading, without a
 * `mediaEntry` provider prop, or when it is gone). Entries never change.
 */
export function useMediaEntry(ref: MediaRef | undefined): MediaEntry | undefined {
  const { mediaEntry } = useEditorContext();
  const id = ref?.mediaId;
  const [entry, setEntry] = useState<MediaEntry | undefined>(undefined);
  useEffect(() => {
    setEntry(undefined);
    if (id === undefined || !mediaEntry) return;
    let live = true;
    mediaEntry(id).then(
      (e) => live && setEntry(e),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, mediaEntry]);
  return entry?.id === id ? entry : undefined;
}

/** Local toasts (rejected commands) and their controls. */
export function useLocalToasts(): { toasts: readonly LocalToast[]; push: (message: string, code?: string) => void; dismiss: (id: number) => void } {
  const { toasts, pushToast, dismissToast } = useEditorContext();
  return { toasts, push: pushToast, dismiss: dismissToast };
}

/** Internal: the canvas handle slot. */
export function useCanvasHandle(): { current: CanvasHandle | null } {
  return useEditorContext().canvas;
}

/**
 * Subscribes to a slice of the editor state. Re-renders only when the selected value changes
 * (`Object.is`, or `isEqual`).
 *
 * @example
 * ```tsx
 * const selection = useEditorState((s) => s.selection);
 * ```
 */
export function useEditorState<T>(selector: (state: EditorState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useEditorStore();
  const cache = useRef<{ state: EditorState; selector: (state: EditorState) => T; value: T } | null>(null);
  const getSnapshot = () => {
    const state = store.getState();
    const prev = cache.current;
    if (prev && prev.state === state && prev.selector === selector) return prev.value;
    const value = selector(state);
    if (prev && isEqual(prev.value, value)) {
      cache.current = { state, selector, value: prev.value };
      return prev.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Dispatch function returned by {@link useDispatch}. */
export interface DispatchFn {
  (command: Command): ApplyResult;
  (commands: readonly Command[]): BatchResult;
}

/**
 * `store.dispatch` that reports rejected commands as toasts.
 *
 * @example
 * ```tsx
 * const dispatch = useDispatch();
 * dispatch({ op: "node.setTitle", flowId, nodeId, title: "Prompt" });
 * ```
 */
export function useDispatch(): DispatchFn {
  const { store, pushToast } = useEditorContext();
  return useMemo(() => {
    const fn = (cmd: Command | readonly Command[]) => {
      const r = Array.isArray(cmd) ? store.dispatch(cmd as readonly Command[]) : store.dispatch(cmd as Command);
      if (!r.ok) pushToast(r.error.message, r.error.code);
      return r;
    };
    return fn as DispatchFn;
  }, [store, pushToast]);
}

/** The flow shown by default: `flowId` if given, else the store's active flow. */
export function useFlowId(flowId?: string): string | undefined {
  const active = useEditorState((s) => s.activeFlowId);
  return flowId ?? active;
}

/** The document of a flow (active flow by default). */
export function useFlow(flowId?: string): FlowDocument | undefined {
  const id = useFlowId(flowId);
  return useEditorState((s) => s.doc?.flows.find((f) => f.id === id));
}

/** Canvas view model of a flow (memoized on document, catalog, diagnostics and run). */
export function useFlowView(flowId?: string): FlowView | undefined {
  const id = useFlowId(flowId);
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const diagnostics = useEditorState((s) => s.diagnostics);
  const run = useEditorState((s) => s.run);
  return useMemo(() => (doc && id ? buildFlowView(doc, id, catalog, diagnostics, run) : undefined), [doc, id, catalog, diagnostics, run]);
}
