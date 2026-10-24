/**
 * `<ConsolePanel>`: the one console. Everything a run reports lands here as a table row:
 * Print lines, failed nodes (code, node, type, message), retries, rejected runs with their
 * problems, outputs and run start / end. Click a row with a node to select it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MediaRef } from "@briarflow/core";
import type { ConsoleKind, ConsoleLine } from "@briarflow/editor";
import { useEditorState, useEditorStore, useMedia, useMediaEntry } from "../context.js";
import { formatBytes, isMediaRef, mediaHref } from "../values.js";

/** Props of {@link ConsolePanel}. */
export interface ConsolePanelProps {
  /** Shown while the console is empty. */
  emptyText?: string;
}

const KINDS: readonly ConsoleKind[] = ["error", "warning", "print", "output", "info"];

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
export function ConsolePanel({ emptyText = "Nothing yet. Run the flow; prints, errors and outputs show up here." }: ConsolePanelProps) {
  const store = useEditorStore();
  const lines = useEditorState((s) => s.console);
  const [hidden, setHidden] = useState<ReadonlySet<ConsoleKind>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = useMemo(() => (hidden.size === 0 ? lines : lines.filter((l) => !hidden.has(l.kind))), [lines, hidden]);
  const counts = useMemo(() => {
    const c: Partial<Record<ConsoleKind, number>> = {};
    for (const l of lines) c[l.kind] = (c[l.kind] ?? 0) + 1;
    return c;
  }, [lines]);

  // Follow new rows while scrolled to the bottom.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const toggle = (kind: ConsoleKind) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  return (
    <div className="bf-console">
      <div className="bf-console__bar">
        {KINDS.map((k) => (
          <label key={k} className={`bf-console__filter bf-console__filter--${k}`}>
            <input type="checkbox" checked={!hidden.has(k)} onChange={() => toggle(k)} />
            {k} {counts[k] ?? 0}
          </label>
        ))}
        <button type="button" className="bf-console__clear" disabled={lines.length === 0} onClick={() => store.clearConsole()}>
          clear
        </button>
      </div>
      <div
        ref={box}
        className="bf-console__body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <table className="bf-console__table" aria-label="Console">
          <thead>
            <tr>
              <th>time</th>
              <th>kind</th>
              <th>node</th>
              <th>code</th>
              <th>message</th>
            </tr>
          </thead>
          <tbody aria-live="polite">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="bf-console__empty">
                  {lines.length === 0 ? emptyText : "Every row is filtered out."}
                </td>
              </tr>
            ) : null}
            {shown.map((l) => (
              <Row key={l.id} line={l} onSelect={l.nodeId ? () => store.select({ nodes: [l.nodeId!], edges: [] }, "replace") : undefined} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ line, onSelect }: { line: ConsoleLine; onSelect: (() => void) | undefined }) {
  return (
    <tr className={`bf-console__row bf-console__row--${line.kind}`}>
      <td className="bf-console__time">{timeOf(line.at)}</td>
      <td className="bf-console__kind">{line.kind}</td>
      <td className="bf-console__node">
        {onSelect ? (
          <button type="button" title={line.nodeType ? `${line.nodeType} · ${line.nodeId}` : line.nodeId} onClick={onSelect}>
            {line.title}
          </button>
        ) : (
          line.title
        )}
        {line.nodeType ? <span className="bf-console__type">{line.nodeType}</span> : null}
      </td>
      <td className="bf-console__code">{line.code ?? ""}</td>
      <td className="bf-console__text">{line.kind === "output" || line.value !== undefined ? <OutputCell line={line} /> : line.text}</td>
    </tr>
  );
}

function OutputCell({ line }: { line: ConsoleLine }) {
  const refs = isMediaRef(line.value) ? [line.value] : Array.isArray(line.value) ? line.value.filter(isMediaRef) : [];
  if (refs.length === 0) return <>{line.text}</>;
  return (
    <span className="bf-console__media">
      {line.kind === "print" ? <span className="bf-console__label">{line.text}</span> : null}
      {refs.map((ref, i) => (
        <ConsoleMedia key={i} mediaRef={ref} title={line.title} />
      ))}
    </span>
  );
}

function ConsoleMedia({ mediaRef, title }: { mediaRef: MediaRef; title: string }) {
  const { mediaUrl } = useMedia();
  const entry = useMediaEntry(mediaRef);
  const href = mediaHref(mediaRef, mediaUrl);
  if (!href) return <span>{mediaRef.mediaId}</span>;
  const name = entry?.meta?.filename ?? entry?.mime ?? mediaRef.mediaId;
  const { width, height } = entry?.meta ?? {};
  const info = entry
    ? [entry.mime, typeof width === "number" && typeof height === "number" ? `${width}×${height}` : undefined, entry.bytes === undefined ? undefined : formatBytes(entry.bytes)]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  return (
    <a href={href} target="_blank" rel="noreferrer" title={info}>
      {!entry || entry.mime.startsWith("image/") ? <img src={href} alt={typeof name === "string" ? name : title} /> : name}
      {info ? <span className="bf-console__media-info">{info}</span> : null}
    </a>
  );
}
