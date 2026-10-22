/**
 * The studio's API client and context list loading. `VITE_BRIAR_API` overrides the base URL
 * (default `/api/v1`, proxied to http://localhost:3000 by the Vite dev server).
 */
import { useCallback, useEffect, useState } from "react";
import { NetworkError, createBriarClient } from "@briarflow/client";
import type { BriarClient } from "@briarflow/client";
import type { ContextSummary } from "@briarflow/core";

export const API_BASE: string = (import.meta.env.VITE_BRIAR_API as string | undefined) ?? "/api/v1";

export const client: BriarClient = createBriarClient({ baseUrl: API_BASE });

/** What the server wants the studio to open first (`BRIAR_STUDIO_CONTEXT` / `BRIAR_STUDIO_FLOW`). */
export interface StudioStart {
  contextId?: string;
  flowId?: string;
}

/** Reads `GET /api/studio` next to the API base; `{}` when the server has no start target. */
export async function fetchStudioStart(signal?: AbortSignal): Promise<StudioStart> {
  try {
    const res = await fetch(`${API_BASE.replace(/\/v1\/?$/, "")}/studio`, signal ? { signal } : {});
    if (!res.ok) return {};
    const body = (await res.json()) as StudioStart;
    return {
      ...(typeof body.contextId === "string" ? { contextId: body.contextId } : {}),
      ...(typeof body.flowId === "string" ? { flowId: body.flowId } : {}),
    };
  } catch {
    return {};
  }
}

/** Connection state of the context list. */
export type ContextsState =
  | { status: "loading" }
  | { status: "offline"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; contexts: ContextSummary[] };

/** True when the error means "no server answered" (network failure or a dead dev proxy). */
export function isOffline(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  const status = (err as { status?: unknown } | null)?.status;
  // Vite's proxy answers 500/502/504 without a Briarflow error body when the target is down.
  const code = (err as { code?: unknown } | null)?.code;
  return (status === 502 || status === 503 || status === 504 || status === 500) && code === "internal";
}

/** Loads all context summaries; `reload()` retries. */
export function useContexts(): { state: ContextsState; reload: () => void } {
  const [state, setState] = useState<ContextsState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ status: "loading" });
    (async () => {
      const contexts: ContextSummary[] = [];
      for await (const c of client.contexts.iterate({ limit: 100 }, { signal: abort.signal })) contexts.push(c);
      return contexts;
    })().then(
      (contexts) => !abort.signal.aborted && setState({ status: "ready", contexts }),
      (err: unknown) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setState(isOffline(err) ? { status: "offline", message } : { status: "error", message });
      },
    );
    return () => abort.abort();
  }, [nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { state, reload };
}
