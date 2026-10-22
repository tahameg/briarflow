/**
 * `<EditorToasts>`: store notices (conflict, rejected, sync failed, load failed) and locally
 * rejected commands, bottom-right. `<SyncStatus>`: revision and save state for a top bar.
 */
import { useEffect } from "react";
import { useEditorState, useEditorStore, useLocalToasts } from "../context.js";
import { Button } from "./ui.js";

const AUTO_DISMISS_MS = 6000;

/**
 * @example
 * ```tsx
 * <EditorToasts />
 * ```
 */
export function EditorToasts() {
  const store = useEditorStore();
  const notices = useEditorState((s) => s.notices);
  const sync = useEditorState((s) => s.sync);
  const { toasts, dismiss } = useLocalToasts();
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => dismiss(toasts[0]!.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toasts, dismiss]);
  if (notices.length === 0 && toasts.length === 0) return null;
  return (
    <div className="bf-toasts" role="region" aria-label="Notifications">
      {notices.map((n) => (
        <div key={`n${n.id}`} className={`bf-toast bf-toast--${n.kind === "conflict" ? "warning" : "error"}`} role="alert">
          <p className="bf-toast__title">{n.kind.replace("_", " ")}</p>
          <p className="bf-toast__msg">{n.message}</p>
          <div className="bf-toast__actions">
            {n.kind === "sync_failed" && sync.status === "error" ? (
              <Button size="sm" onClick={() => store.retrySync()}>
                Retry
              </Button>
            ) : null}
            {n.kind === "load_failed" ? (
              <Button size="sm" onClick={() => void store.load()}>
                Reload
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => store.dismissNotice(n.id)} aria-label="Dismiss">
              ×
            </Button>
          </div>
        </div>
      ))}
      {toasts.map((t) => (
        <div key={`t${t.id}`} className="bf-toast bf-toast--error" role="alert">
          <p className="bf-toast__title">{t.code ?? "rejected"}</p>
          <p className="bf-toast__msg">{t.message}</p>
          <div className="bf-toast__actions">
            <Button size="sm" variant="ghost" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Revision + save state: `rev 13 · saved`, `saving…`, `sync paused`.
 *
 * @example
 * ```tsx
 * <SyncStatus />
 * ```
 */
export function SyncStatus() {
  const store = useEditorStore();
  const revision = useEditorState((s) => s.serverRevision);
  const sync = useEditorState((s) => s.sync);
  const status = useEditorState((s) => s.status);
  const label = status === "loading" || status === "reloading" ? "loading…" : sync.status === "error" ? "sync paused" : sync.pending > 0 ? "saving…" : "saved";
  return (
    <span className={`bf-sync bf-sync--${sync.status}`} role="status" aria-live="polite">
      <span className="bf-code">rev {revision ?? "—"}</span> · {label}
      {sync.status === "error" ? (
        <Button size="sm" variant="ghost" onClick={() => store.retrySync()}>
          retry
        </Button>
      ) : null}
    </span>
  );
}
