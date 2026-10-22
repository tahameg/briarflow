/**
 * Studio main screen (design-system.md §11): top bar (Types and Globals open modals), canvas,
 * and dockable panels (contexts, variables, inspector, run, problems) in the left, right and
 * bottom zones (`dock.tsx`). Nodes are added from the canvas's right-click menu.
 */
import { Suspense, lazy, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ContextSummary } from "@briarflow/core";
import { BottomZone, SideZone, useDock } from "./dock.js";
import type { DockApi, PanelDef, PanelId } from "./dock.js";
import {
  Button,
  ConfirmDialog,
  DiagnosticsList,
  EditorToasts,
  EmptyState,
  GlobalsPanel,
  Inspector,
  Modal,
  RunPanel,
  SyncStatus,
  TypesPanel,
  VariablesPanel,
  useDispatch,
  useEditorState,
  runBlockedHint,
  useContextMenu,
  useEditorStore,
  useFlowErrorCount,
} from "@briarflow/editor-react";
import type { ContextMenuItem } from "@briarflow/editor-react";

declare module "@briarflow/editor-react" {
  interface ContextMenuTargets {
    /** A context row in the contexts tree. */
    context: { contextId: string };
    /** A flow row in the contexts tree. */
    flow: { flowId: string };
  }
}

// React Flow is the bulk of the bundle: load the canvas in its own chunk.
const FlowCanvas = lazy(() => import("@briarflow/editor-react/canvas").then((m) => ({ default: m.FlowCanvas })));

/** Props of {@link Workspace}. */
export interface WorkspaceProps {
  contexts: readonly ContextSummary[];
  contextId: string | undefined;
  /** An editor store (and `<EditorProvider>`) exists for `contextId`. */
  hasStore: boolean;
  onSelectContext: (id: string) => void;
  onCreateContext: (name: string) => Promise<void>;
  onContextsChanged: () => void;
  onRenameContext: (id: string, name: string) => Promise<void>;
  onDeleteContext: (id: string) => Promise<void>;
}

type ModalKind = "types" | "globals";

export function Workspace(props: WorkspaceProps) {
  const { hasStore } = props;
  const dock = useDock();
  const [modal, setModal] = useState<ModalKind | undefined>(undefined);
  const panels = usePanels(props, dock);
  const left = dock.layout.zones.left.length > 0 || dock.dragging !== undefined;
  const right = dock.layout.zones.right.length > 0 || dock.dragging !== undefined;
  const bottom = hasStore && (dock.layout.zones.bottom.length > 0 || dock.dragging !== undefined);
  const columns = [left ? "var(--bf-rail-w)" : null, "minmax(0, 1fr)", right ? "var(--bf-inspector-w)" : null].filter(Boolean).join(" ");
  return (
    <div className="bf-app">
      <header className="bf-topbar">
        <div className="bf-topbar__left">
          <span className="bf-brand">BRIARFLOW</span>
          {hasStore ? <Crumbs contexts={props.contexts} /> : <span className="bf-muted">no context open</span>}
          {hasStore ? (
            <span className="bf-topbar__group">
              <Button size="sm" variant="secondary" onClick={() => setModal("types")} title="Structs and enums">
                Types
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setModal("globals")} title="Values shared by every flow in this context">
                Globals
              </Button>
            </span>
          ) : null}
        </div>
        {hasStore ? <TopActions onRun={() => dock.reveal("run")} onProblems={() => dock.reveal("problems")} /> : null}
      </header>
      <div className="bf-main" style={{ gridTemplateColumns: columns }}>
        {left ? <SideZone dock={dock} zone="left" panels={panels} /> : null}
        <main className={bottom ? "bf-center" : "bf-center bf-center--full"}>
          {hasStore ? (
            <>
              <Suspense fallback={<div className="bf-canvas bf-canvas--empty" role="status" aria-label="Loading canvas" />}>
                <FlowCanvas />
              </Suspense>
              <BottomZone dock={dock} panels={panels} />
            </>
          ) : (
            <div className="bf-canvas bf-canvas--empty">
              <EmptyState title={props.contexts.length === 0 ? "No contexts yet" : "Pick a context"}>
                {props.contexts.length === 0 ? "Create a context in the Contexts panel to start." : "Choose a context in the Contexts panel."}
              </EmptyState>
            </div>
          )}
        </main>
        {right ? <SideZone dock={dock} zone="right" panels={panels} /> : null}
      </div>
      {hasStore ? (
        <>
          <Modal open={modal === "types"} title="Types" onClose={() => setModal(undefined)} className="bf-modal--wide">
            <TypesPanel />
          </Modal>
          <Modal open={modal === "globals"} title="Globals" onClose={() => setModal(undefined)}>
            <GlobalsPanel />
          </Modal>
          <EditorToasts />
        </>
      ) : null}
    </div>
  );
}

function usePanels(props: WorkspaceProps, dock: DockApi): Record<PanelId, PanelDef> {
  const { hasStore } = props;
  const none = (text: string) => <p className="bf-muted bf-pad">{text}</p>;
  return {
    contexts: {
      title: "Contexts",
      name: "Contexts",
      flush: true,
      body: <ContextsPanel {...props} />,
      actions: <Button size="sm" variant="ghost" icon={<RefreshIcon />} onClick={props.onContextsChanged} aria-label="Reload contexts" title="Reload contexts" />,
    },
    variables: { title: hasStore ? <VariablesTitle /> : "Variables", name: "Variables", body: hasStore ? <VariablesPanel /> : none("Open a context to edit its variables.") },
    inspector: { title: "Inspector", name: "Inspector", body: hasStore ? <Inspector /> : none("Nothing selected.") },
    run: { title: "Run", name: "Run", body: hasStore ? <RunPanel onOpenProblems={() => dock.reveal("problems")} /> : none("Open a context to run its flows.") },
    problems: { title: hasStore ? <ProblemsTitle /> : "Problems", name: "Problems", body: hasStore ? <DiagnosticsList emptyText="No problems." /> : none("No context open.") },
  };
}

function VariablesTitle() {
  const name = useEditorState((s) => s.doc?.flows.find((f) => f.id === s.activeFlowId)?.name);
  return name ? (
    <>
      Variables <span className="bf-panel__sub">· {name}</span>
    </>
  ) : (
    <>Variables</>
  );
}

function ProblemsTitle() {
  const counts = useEditorState(
    (s) => ({ all: s.diagnostics.length, errors: s.diagnostics.filter((d) => d.severity === "error").length }),
    (a, b) => a.all === b.all && a.errors === b.errors,
  );
  return <span className={counts.errors > 0 ? "bf-tab-danger" : undefined}>Problems {counts.all}</span>;
}

function Crumbs({ contexts }: { contexts: readonly ContextSummary[] }) {
  const store = useEditorStore();
  const doc = useEditorState((s) => s.doc);
  const activeFlowId = useEditorState((s) => s.activeFlowId);
  const contextId = useEditorState((s) => s.contextId);
  const name = doc?.name ?? contexts.find((c) => c.id === contextId)?.name ?? contextId;
  return (
    <nav className="bf-crumbs" aria-label="Context and flow">
      <span className="bf-crumbs__ctx">{name}</span>
      <span className="bf-crumbs__sep" aria-hidden="true">
        /
      </span>
      <label className="bf-visually-hidden" htmlFor="bf-flow-switch">
        Flow
      </label>
      <select id="bf-flow-switch" className="bf-input bf-input--select bf-crumbs__flow" value={activeFlowId ?? ""} onChange={(e) => store.setActiveFlow(e.target.value || undefined)} disabled={!doc}>
        {!activeFlowId ? <option value="">— no flow —</option> : null}
        {doc?.flows.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </nav>
  );
}

function TopActions({ onRun, onProblems }: { onRun: () => void; onProblems: () => void }) {
  const store = useEditorStore();
  const history = useEditorState((s) => s.history);
  const activeFlowId = useEditorState((s) => s.activeFlowId);
  const flowErrors = useFlowErrorCount(activeFlowId);
  const counts = useEditorState(
    (s) => {
      let errors = 0;
      let warnings = 0;
      for (const d of s.diagnostics) {
        if (d.severity === "error") errors++;
        else warnings++;
      }
      return { errors, warnings };
    },
    (a, b) => a.errors === b.errors && a.warnings === b.warnings,
  );
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const summary = `${plural(counts.errors, "error")}, ${plural(counts.warnings, "warning")}`;
  const tone = counts.errors > 0 ? "error" : counts.warnings > 0 ? "warning" : "clean";
  return (
    <div className="bf-topbar__right">
      <SyncStatus />
      <Button size="sm" variant="secondary" disabled={!history.canUndo} onClick={() => store.undo()} aria-keyshortcuts="Control+Z" title="Undo (Ctrl/Cmd+Z)">
        Undo
      </Button>
      <Button size="sm" variant="secondary" disabled={!history.canRedo} onClick={() => store.redo()} aria-keyshortcuts="Control+Shift+Z" title="Redo (Ctrl/Cmd+Shift+Z)">
        Redo
      </Button>
      <button type="button" className={`bf-problems-btn bf-problems-btn--${tone}`} onClick={onProblems} title={`${summary} — open PROBLEMS`} aria-label={`${summary}. Open problems`}>
        ⚠ {counts.errors + counts.warnings}
      </button>
      <Button
        variant="primary"
        disabled={!activeFlowId}
        aria-keyshortcuts="Control+Enter"
        title={runBlockedHint(flowErrors) ?? "Run (Ctrl/Cmd+Enter)"}
        onClick={() => {
          onRun();
          requestAnimationFrame(() => document.querySelector<HTMLFormElement>('form[aria-label="Run inputs"]')?.requestSubmit());
        }}
      >
        ▶ Run
        {flowErrors > 0 ? (
          <span className="bf-button__warn" aria-label={plural(flowErrors, "error")}>
            ⚠ {flowErrors}
          </span>
        ) : null}
      </Button>
    </div>
  );
}

/** Name field + add button (Enter submits, Esc clears); the button stays disabled while empty. */
function CreateRow({ label, placeholder, button, onCreate }: { label: string; placeholder: string; button: string; onCreate: (name: string) => unknown }) {
  const [name, setName] = useState("");
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    if ((await onCreate(n)) !== false) setName("");
  };
  return (
    <div className="bf-create bf-tree__create">
      <input
        className="bf-input"
        aria-label={label}
        placeholder={placeholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") setName("");
        }}
      />
      <Button size="sm" onClick={() => void submit()} disabled={!name.trim()}>
        {button}
      </Button>
    </div>
  );
}

/** A tree row with hover/selection actions: ✎ inline rename (Enter saves, Esc cancels) and × delete. */
function TreeRow({
  kind,
  name,
  rowClass,
  active,
  onOpen,
  onRename,
  onDelete,
  onMenu,
  children,
  ...aria
}: {
  kind: "context" | "flow";
  name: string;
  rowClass: string;
  active: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  /** Right-click: receives the row's own entries (open, rename, delete) to pass on with a target. */
  onMenu: (e: ReactMouseEvent, items: ContextMenuItem[]) => void;
  children: ReactNode;
  "aria-expanded"?: boolean;
  "aria-current"?: "true";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  if (editing) {
    const finish = (save: boolean) => {
      if (done.current) return;
      done.current = true;
      setEditing(false);
      const n = draft.trim();
      if (save && n && n !== name) onRename(n);
    };
    return (
      <div className="bf-tree__item bf-tree__item--editing">
        <input
          className="bf-input bf-tree__rename"
          aria-label={`New name of ${kind} ${name}`}
          value={draft}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") finish(true);
            if (e.key === "Escape") finish(false);
          }}
        />
      </div>
    );
  }
  const startRename = () => {
    done.current = false;
    setDraft(name);
    setEditing(true);
  };
  const menuItems: ContextMenuItem[] = [
    { id: "open", label: "Open", order: 100, disabled: active, run: onOpen },
    { id: "rename", label: "Rename", order: 200, run: startRename },
    { id: "delete", label: `Delete ${kind}`, order: 900, danger: true, run: onDelete },
  ];
  return (
    <div className={active ? "bf-tree__item bf-tree__item--active" : "bf-tree__item"} onContextMenu={(e) => onMenu(e, menuItems)}>
      <button type="button" className={rowClass} onClick={onOpen} {...aria}>
        {children}
      </button>
      <span className="bf-tree__actions">
        <button
          type="button"
          className="bf-button bf-button--ghost bf-button--sm bf-row-x bf-row-edit"
          aria-label={`Rename ${kind} ${name}`}
          title={`Rename ${kind}`}
          onClick={startRename}
        >
          ✎
        </button>
        <button type="button" className="bf-button bf-button--ghost bf-button--sm bf-row-x" aria-label={`Delete ${kind} ${name}`} title={`Delete ${kind}`} onClick={onDelete}>
          ×
        </button>
      </span>
    </div>
  );
}

function ContextsPanel({ contexts, contextId, hasStore, onSelectContext, onCreateContext, onRenameContext, onDeleteContext }: WorkspaceProps) {
  const menu = useContextMenu();
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState<ContextSummary | undefined>(undefined);
  const attempt = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      setError(undefined);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  return (
    <>
      <ul className="bf-tree">
        {contexts.map((c) => {
          const current = c.id === contextId;
          return (
            <li key={c.id}>
              <TreeRow
                kind="context"
                name={c.name}
                active={current}
                rowClass={current ? "bf-tree__row bf-tree__row--ctx bf-tree__row--open" : "bf-tree__row bf-tree__row--ctx"}
                aria-expanded={current}
                onOpen={() => onSelectContext(c.id)}
                onRename={(n) => void attempt(() => onRenameContext(c.id, n))}
                onDelete={() => setDeleting(c)}
                onMenu={(e, items) => menu.open(e, { kind: "context", contextId: c.id }, items)}
              >
                <span aria-hidden="true">{current ? "▾" : "▸"}</span> {c.name}
              </TreeRow>
              {current && hasStore ? <LiveFlows /> : null}
            </li>
          );
        })}
      </ul>
      {contexts.length === 0 ? <p className="bf-muted bf-pad">No contexts yet. Name one below and press Enter.</p> : null}
      <div className="bf-pad">
        <CreateRow label="New context name" placeholder="New context" button="+ Context" onCreate={(n) => attempt(() => onCreateContext(n))} />
      </div>
      {error ? <p className="bf-field__error bf-pad">{error}</p> : null}
      <ConfirmDialog
        open={deleting !== undefined}
        title={`Delete context ${deleting?.name ?? ""}?`}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => {
          const c = deleting;
          setDeleting(undefined);
          if (c) void attempt(() => onDeleteContext(c.id));
        }}
      >
        {deleting ? `Its ${deleting.flows.length === 1 ? "1 flow goes" : `${deleting.flows.length} flows go`} with it, together with its types and globals. This cannot be undone.` : null}
      </ConfirmDialog>
    </>
  );
}

function RefreshIcon() {
  // lucide `refresh-cw`, 16 px, stroke 2.
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function LiveFlows() {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const menu = useContextMenu();
  const status = useEditorState((s) => s.status);
  const flows = useEditorState((s) => s.doc?.flows);
  const activeFlowId = useEditorState((s) => s.activeFlowId);
  const [deleting, setDeleting] = useState<{ id: string; name: string; nodes: number } | undefined>(undefined);
  const create = (n: string) => {
    const r = dispatch({ op: "flow.create", name: n });
    if (r.ok && r.created.flowId) store.setActiveFlow(r.created.flowId);
    return r.ok;
  };
  if (status === "loading") return <p className="bf-tree__note">loading…</p>;
  if (status === "error") {
    return (
      <p className="bf-tree__note bf-field__error">
        Could not load this context.{" "}
        <button type="button" className="bf-link" onClick={() => void store.load()}>
          Retry
        </button>
      </p>
    );
  }
  return (
    <>
      <ul className="bf-tree__flows">
        {(flows ?? []).map((f) => (
          <li key={f.id}>
            <TreeRow
              kind="flow"
              name={f.name}
              active={f.id === activeFlowId}
              rowClass={f.id === activeFlowId ? "bf-tree__row bf-tree__row--flow bf-tree__row--current" : "bf-tree__row bf-tree__row--flow"}
              {...(f.id === activeFlowId ? { "aria-current": "true" as const } : {})}
              onOpen={() => store.setActiveFlow(f.id)}
              onRename={(name) => dispatch({ op: "flow.rename", flowId: f.id, name })}
              onDelete={() => setDeleting({ id: f.id, name: f.name, nodes: f.nodes.length })}
              onMenu={(e, items) =>
                menu.open(e, { kind: "flow", flowId: f.id }, [
                  ...items,
                  {
                    id: "duplicate",
                    label: "Duplicate",
                    order: 200,
                    run: () => {
                      const r = dispatch({ op: "flow.duplicate", flowId: f.id });
                      if (r.ok && r.created.flowId) store.setActiveFlow(r.created.flowId);
                    },
                  },
                ])
              }
            >
              {f.name}
            </TreeRow>
          </li>
        ))}
        <li className="bf-tree__new">
          <CreateRow label="New flow name" placeholder="New flow" button="+ Flow" onCreate={create} />
        </li>
      </ul>
      <ConfirmDialog
        open={deleting !== undefined}
        title={`Delete flow ${deleting?.name ?? ""}?`}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => {
          const d = deleting;
          setDeleting(undefined);
          if (!d) return;
          const r = dispatch({ op: "flow.delete", flowId: d.id });
          if (r.ok && store.getState().activeFlowId === d.id) store.setActiveFlow(store.getState().doc?.flows[0]?.id);
        }}
      >
        {deleting ? `Its ${deleting.nodes} nodes and local types are removed. Undo (Ctrl/Cmd+Z) brings it back.` : null}
      </ConfirmDialog>
    </>
  );
}
