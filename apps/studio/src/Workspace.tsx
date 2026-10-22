/**
 * Studio main screen (design-system.md §11): top bar with the context and flow switchers
 * (Types and Globals open modals), canvas, and dockable panels (variables, inspector, run,
 * problems) in the left, right and bottom zones (`dock.tsx`). Nodes are added from the
 * canvas's right-click menu.
 */
import { Suspense, lazy, useState } from "react";
import type { ContextSummary } from "@briarflow/core";
import { BottomZone, SideZone, useDock } from "./dock.js";
import type { DockApi, PanelDef, PanelId } from "./dock.js";
import { Switcher } from "./Switcher.js";
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
  useEditorStore,
  useFlowErrorCount,
} from "@briarflow/editor-react";
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
          <ContextBar {...props} />
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
                {props.contexts.length === 0 ? "Press + Add context in the top bar to start." : "Choose a context in the top bar."}
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

/** Context switcher, then (once the context is open) the flow switcher. */
function ContextBar({ contexts, contextId, hasStore, onSelectContext, onCreateContext, onRenameContext, onDeleteContext, onContextsChanged }: WorkspaceProps) {
  const [deleting, setDeleting] = useState<ContextSummary | undefined>(undefined);
  return (
    <nav className="bf-crumbs" aria-label="Context and flow">
      <Switcher
        kind="context"
        items={contexts}
        value={contextId}
        onSelect={onSelectContext}
        onCreate={onCreateContext}
        onRename={onRenameContext}
        onDelete={(id) => setDeleting(contexts.find((c) => c.id === id))}
        extraItems={() => [{ id: "reload", label: "Reload context list", order: 300, run: onContextsChanged }]}
      />
      {hasStore ? (
        <>
          <span className="bf-crumbs__sep" aria-hidden="true">
            /
          </span>
          <FlowSwitcher />
        </>
      ) : null}
      <ConfirmDialog
        open={deleting !== undefined}
        title={`Delete context ${deleting?.name ?? ""}?`}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => {
          const c = deleting;
          setDeleting(undefined);
          if (c) void onDeleteContext(c.id);
        }}
      >
        {deleting ? `Its ${deleting.flows.length === 1 ? "1 flow goes" : `${deleting.flows.length} flows go`} with it, together with its types and globals. This cannot be undone.` : null}
      </ConfirmDialog>
    </nav>
  );
}

function FlowSwitcher() {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const status = useEditorState((s) => s.status);
  const flows = useEditorState((s) => s.doc?.flows);
  const activeFlowId = useEditorState((s) => s.activeFlowId);
  const [deleting, setDeleting] = useState<{ id: string; name: string; nodes: number } | undefined>(undefined);
  if (status === "loading" || !flows) return <span className="bf-muted">loading…</span>;
  if (status === "error") {
    return (
      <span className="bf-field__error">
        Could not load this context.{" "}
        <button type="button" className="bf-link" onClick={() => void store.load()}>
          Retry
        </button>
      </span>
    );
  }
  const fail = (r: { ok: false; error: { message: string } }) => {
    throw new Error(r.error.message);
  };
  return (
    <>
      <Switcher
        kind="flow"
        items={flows}
        value={activeFlowId}
        onSelect={(id) => store.setActiveFlow(id)}
        onCreate={(name) => {
          const r = dispatch({ op: "flow.create", name });
          if (!r.ok) return fail(r);
          if (r.created.flowId) store.setActiveFlow(r.created.flowId);
          return true;
        }}
        onRename={(flowId, name) => {
          const r = dispatch({ op: "flow.rename", flowId, name });
          return r.ok || fail(r);
        }}
        onDelete={(id) => {
          const f = flows.find((x) => x.id === id);
          if (f) setDeleting({ id: f.id, name: f.name, nodes: f.nodes.length });
        }}
        extraItems={(flowId) => [
          {
            id: "duplicate",
            label: "Duplicate",
            order: 200,
            run: () => {
              const r = dispatch({ op: "flow.duplicate", flowId });
              if (r.ok && r.created.flowId) store.setActiveFlow(r.created.flowId);
            },
          },
        ]}
      />
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
