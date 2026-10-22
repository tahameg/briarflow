import { useCallback, useEffect, useRef, useState } from "react";
import { clientBackend, createEditorStore } from "@briarflow/editor";
import type { EditorStore } from "@briarflow/editor";
import type { ContextSummary } from "@briarflow/core";
import { Button, EditorProvider } from "@briarflow/editor-react";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { API_BASE, client, fetchStudioStart, useContexts } from "./client";
import type { StudioStart } from "./client";
import { Workspace } from "./Workspace";

const LAST_CONTEXT_KEY = "briarflow.studio.context";
const backend = clientBackend(client);
const mediaUrl = (id: string) => client.media.url(id);
const uploadMedia = (file: File) => client.media.upload(file, { mime: file.type || "application/octet-stream", filename: file.name });

function readLast(): string | undefined {
  try {
    return localStorage.getItem(LAST_CONTEXT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLast(id: string): void {
  try {
    localStorage.setItem(LAST_CONTEXT_KEY, id);
  } catch {
    // storage unavailable (private mode): only a convenience
  }
}

/**
 * Studio root: connects to the server, picks a context (the server's start target, else the
 * last used, else the first), binds the editor store.
 */
export function App() {
  const { state, reload } = useContexts();
  const [start, setStart] = useState<StudioStart | undefined>(undefined);
  const [contextId, setContextId] = useState<string | undefined>(undefined);
  const [store, setStore] = useState<EditorStore | undefined>(undefined);
  // The start flow applies once, to the first store of the start context.
  const startFlow = useRef<{ contextId: string; flowId: string } | undefined>(undefined);

  const contexts: ContextSummary[] = state.status === "ready" ? state.contexts : [];

  useEffect(() => {
    const abort = new AbortController();
    void fetchStudioStart(abort.signal).then((s) => !abort.signal.aborted && setStart(s));
    return () => abort.abort();
  }, []);

  useEffect(() => {
    if (state.status !== "ready" || start === undefined || contextId !== undefined) return;
    const last = readLast();
    const pick = state.contexts.find((c) => c.id === start.contextId) ?? state.contexts.find((c) => c.id === last) ?? state.contexts[0];
    if (!pick) return;
    if (pick.id === start.contextId && start.flowId) startFlow.current = { contextId: pick.id, flowId: start.flowId };
    setContextId(pick.id);
  }, [state, start, contextId]);

  useEffect(() => {
    if (!contextId) return;
    const flowId = startFlow.current?.contextId === contextId ? startFlow.current.flowId : undefined;
    startFlow.current = undefined;
    const s = createEditorStore({ backend, contextId, localPacks: [stdPack, mockPack], ...(flowId ? { flowId } : {}) });
    setStore(s);
    writeLast(contextId);
    return () => {
      s.persistViewport();
      s.dispose();
      setStore(undefined);
    };
  }, [contextId]);

  const createContext = useCallback(
    async (name: string) => {
      const doc = await client.contexts.create({ name });
      reload();
      setContextId(doc.id);
    },
    [reload],
  );

  const renameContext = useCallback(
    async (id: string, name: string) => {
      if (store && id === contextId) {
        // The open context goes through the editor store so its revision stays in sync.
        const r = store.dispatch({ op: "context.rename", name });
        if (!r.ok) throw new Error(r.error.message);
        await store.flush();
      } else {
        const doc = await client.contexts.get(id);
        await client.contexts.apply(id, { baseRevision: doc.revision, commands: [{ op: "context.rename", name }] });
      }
      reload();
    },
    [store, contextId, reload],
  );

  const deleteContext = useCallback(
    async (id: string) => {
      await client.contexts.delete(id);
      if (id === contextId) setContextId(contexts.find((c) => c.id !== id)?.id);
      reload();
    },
    [contextId, contexts, reload],
  );

  if (state.status === "loading") return <Splash title="Connecting…" text={`Loading contexts from ${API_BASE}`} />;
  if (state.status === "offline" || state.status === "error") {
    return (
      <Splash
        title={state.status === "offline" ? "Server offline" : "Server error"}
        text={
          state.status === "offline"
            ? `No Briarflow server answered at ${API_BASE}. Start one on http://localhost:3000 (the dev server proxies /api there), or set VITE_BRIAR_API to its URL.`
            : `The server answered, but listing contexts failed.`
        }
        detail={state.message}
        onRetry={reload}
      />
    );
  }

  const workspace = (
    <Workspace
      contexts={contexts}
      contextId={contextId}
      hasStore={store !== undefined}
      onSelectContext={setContextId}
      onCreateContext={createContext}
      onContextsChanged={reload}
      onRenameContext={renameContext}
      onDeleteContext={deleteContext}
    />
  );
  return store ? (
    <EditorProvider store={store} mediaUrl={mediaUrl} uploadMedia={uploadMedia}>
      {workspace}
    </EditorProvider>
  ) : (
    workspace
  );
}

function Splash({ title, text, detail, onRetry }: { title: string; text: string; detail?: string; onRetry?: () => void }) {
  return (
    <main className="bf-splash">
      <div className="bf-splash__card" role={onRetry ? "alert" : "status"}>
        <span className="bf-brand">BRIARFLOW</span>
        <h1 className="bf-splash__title">{title}</h1>
        <p className="bf-splash__text">{text}</p>
        {detail ? <pre className="bf-splash__detail">{detail}</pre> : null}
        {onRetry ? (
          <Button variant="primary" onClick={onRetry} autoFocus>
            Retry
          </Button>
        ) : null}
      </div>
    </main>
  );
}
