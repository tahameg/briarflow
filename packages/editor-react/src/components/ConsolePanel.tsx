/**
 * `<ConsolePanel>`: the editor console. Frontend nodes such as Print write here when a run
 * reaches them (`state.console`); click a line's node to select it.
 */
import { useEffect, useRef } from "react";
import { useEditorState, useEditorStore } from "../context.js";
import { Button } from "./ui.js";

/** Props of {@link ConsolePanel}. */
export interface ConsolePanelProps {
  /** Shown while the console is empty. */
  emptyText?: string;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * @example
 * ```tsx
 * <EditorProvider store={store}><ConsolePanel /></EditorProvider>
 * ```
 */
export function ConsolePanel({ emptyText = "Nothing printed yet. Add a Print node and run the flow." }: ConsolePanelProps) {
  const store = useEditorStore();
  const lines = useEditorState((s) => s.console);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  // Follow new lines while scrolled to the bottom.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="bf-console">
      <div className="bf-console__bar">
        <span className="bf-muted">{lines.length === 1 ? "1 line" : `${lines.length} lines`}</span>
        <Button size="sm" variant="secondary" disabled={lines.length === 0} onClick={() => store.clearConsole()}>
          Clear
        </Button>
      </div>
      <ol
        ref={list}
        className="bf-console__screen"
        aria-label="Console"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 ? <li className="bf-console__empty">{emptyText}</li> : null}
        {lines.map((l) => (
          <li key={l.id} className="bf-console__line">
            <span className="bf-console__time">{timeOf(l.at)}</span>
            <button type="button" className="bf-console__node" title="Select this node" onClick={() => store.select({ nodes: [l.nodeId], edges: [] }, "replace")}>
              {l.title}
            </button>
            <span className="bf-console__text">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
