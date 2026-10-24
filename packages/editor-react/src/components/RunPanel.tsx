/**
 * `<RunPanel>`: run the active flow. Inputs form generated from the flow signature (kept in
 * the store across runs), run / cancel, status and outputs. What the run reports goes to the
 * console (`<ConsolePanel>`).
 */
import { useEffect, useMemo } from "react";
import { createCatalog, scopeForFlow } from "@briarflow/core";
import type { Diagnostic, FieldDecl, MediaRef, SerializedError, TypeScope } from "@briarflow/core";
import { isRunFinished } from "@briarflow/editor";
import type { EditorStore, RunState } from "@briarflow/editor";
import { useEditorState, useEditorStore, useFlowId, useLocalToasts, useMedia, useMediaEntry } from "../context.js";
import { isMediaRef, mediaHref, previewValue } from "../values.js";
import { Badge, Button, EmptyState, SectionHead, StatusDot } from "./ui.js";
import type { DotState, Tone } from "./ui.js";
import { ValueEditor } from "./ValueEditor.js";
import { DiagnosticsList } from "./DiagnosticsList.js";

const NO_PACKS = createCatalog([]);
const NO_INPUTS: Readonly<Record<string, unknown>> = {};

/**
 * Starts a run of a flow with the inputs typed in the editor (`state.runInputs`). A rejected
 * run shows in the console; any other failure goes to `onError` (e.g. a toast).
 *
 * @example
 * ```ts
 * startEditorRun(store, "flow_p", (message) => toast(message));
 * ```
 */
export function startEditorRun(store: EditorStore, flowId: string, onError: (message: string) => void): void {
  store.startRun({ flowId }).catch((err: unknown) => {
    if (store.getState().run?.status !== "rejected") onError(err instanceof Error ? err.message : String(err));
  });
}

/** Props of {@link RunPanel}. */
export interface RunPanelProps {
  flowId?: string;
  /** Shows an "Open PROBLEMS" link on a rejected run (e.g. switch the dock tab). */
  onOpenProblems?: () => void;
  /** Called when the panel starts a run (e.g. show the console). */
  onRunStarted?: () => void;
  /** Ctrl/Cmd+Enter runs while the panel is mounted. Default true; turn off when the app has its own shortcut. */
  shortcut?: boolean;
}

/** Number of error diagnostics of a flow (the run will be rejected while > 0). */
export function useFlowErrorCount(flowId: string | undefined): number {
  return useEditorState((s) => (flowId ? s.diagnostics.reduce((n, d) => (d.severity === "error" && d.path.flowId === flowId ? n + 1 : n), 0) : 0));
}

/** Tooltip of a run button when the flow has errors. */
export function runBlockedHint(errors: number): string | undefined {
  return errors > 0 ? `Flow has ${errors} error${errors === 1 ? "" : "s"} — the server will reject this run` : undefined;
}

function isDiagnostic(v: unknown): v is Diagnostic {
  const d = v as Partial<Diagnostic> | null;
  return typeof d === "object" && d !== null && typeof d.code === "string" && typeof d.message === "string" && (d.severity === "error" || d.severity === "warning") && typeof d.path === "object";
}

/** `details.diagnostics` of a rejected run (`run.invalid_flow` / `run.invalid_inputs`). */
export function rejectionDiagnostics(error: SerializedError | undefined): Diagnostic[] {
  const list = (error?.details as { diagnostics?: unknown } | undefined)?.diagnostics;
  return Array.isArray(list) ? list.filter(isDiagnostic) : [];
}

function statusLook(status: RunState["status"] | undefined): { dot: DotState; tone: Tone } {
  switch (status) {
    case "starting":
    case "queued":
      return { dot: "queued", tone: "stone" };
    case "running":
      return { dot: "running", tone: "sky" };
    case "succeeded":
      return { dot: "done", tone: "mint" };
    case "failed":
    case "rejected":
      return { dot: "error", tone: "danger" };
    case "cancelled":
    default:
      return { dot: "skipped", tone: "stone" };
  }
}

/**
 * @example
 * ```tsx
 * <RunPanel />
 * ```
 */
export function RunPanel({ flowId: flowIdProp, onOpenProblems, onRunStarted, shortcut = true }: RunPanelProps) {
  const store = useEditorStore();
  const flowId = useFlowId(flowIdProp);
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const run = useEditorState((s) => s.run);
  const flow = doc?.flows.find((f) => f.id === flowId);
  const scope = useMemo(() => (doc && flow ? scopeForFlow(doc, flow.id, catalog ?? NO_PACKS) : undefined), [doc, flow, catalog]);
  const { push } = useLocalToasts();
  const inputs = useEditorState((s) => (flowId ? s.runInputs[flowId] : undefined)) ?? NO_INPUTS;
  const force = useEditorState((s) => s.force);
  const errorCount = useFlowErrorCount(flowId);

  const running = run !== undefined && !isRunFinished(run);
  const start = () => {
    if (!flow || running) return;
    onRunStarted?.();
    startEditorRun(store, flow.id, push);
  };

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!flow) return <EmptyState title="No flow">Open a flow to run it.</EmptyState>;
  const shown = run && run.flowId === flow.id ? run : undefined;
  const look = statusLook(shown?.status);
  const done = shown ? Object.values(shown.nodes).filter((n) => n.status !== "running").length : 0;

  return (
    <div className="bf-run">
      <form
        className="bf-run__inputs"
        aria-label="Run inputs"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <SectionHead title="Inputs" />
        {flow.inputs.length === 0 ? <p className="bf-muted">This flow has no inputs.</p> : null}
        {flow.inputs.map((f) => (
          <InputRow key={f.name} field={f} scope={scope} value={inputs[f.name]} onChange={(v) => store.setRunInput(flow.id, f.name, v)} />
        ))}
        <label className="bf-check" title="Nodes that make media normally reuse the last run's result when their inputs did not change. Force run makes everything again.">
          <input type="checkbox" className="bf-check__box" checked={force} onChange={(e) => store.setForce(e.target.checked)} />
          <span>Force run (make everything again)</span>
        </label>
        <div className="bf-run__actions">
          <Button type="submit" variant="primary" disabled={running} title={runBlockedHint(errorCount) ?? "Run (Ctrl/Cmd+Enter)"}>
            ▶ Run{errorCount > 0 ? <span className="bf-button__warn" aria-label={`${errorCount} errors`}>⚠ {errorCount}</span> : null}
          </Button>
          {running ? (
            <Button variant="danger" onClick={() => store.cancelRun("Cancelled in the editor")}>
              Cancel
            </Button>
          ) : shown ? (
            <Button variant="secondary" onClick={() => store.clearRun()}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>
      <div className="bf-run__main">
        <div className="bf-run__status" role="status" aria-live="polite">
          <StatusDot state={look.dot} label={`run ${shown?.status ?? "idle"}`} />
          <span className="bf-run__title">{shown ? (shown.runId ? `RUN ${shown.runId}` : "RUN") : "No run yet"}</span>
          {shown ? <Badge tone={look.tone}>{shown.status}</Badge> : null}
          {shown ? (
            <span className="bf-muted bf-code">
              {done}/{flow.nodes.length} nodes
            </span>
          ) : null}
        </div>
        {shown?.error && shown.status === "rejected" ? (
          <Rejection error={shown.error} flowId={flow.id} onOpenProblems={onOpenProblems} />
        ) : shown?.error ? (
          <p className="bf-run__error" role="alert">
            {shown.error.message}
          </p>
        ) : null}
        {shown?.result ? <Outputs result={shown.result} outputs={flow.outputs} /> : null}
      </div>
    </div>
  );
}

function Rejection({ error, flowId, onOpenProblems }: { error: SerializedError; flowId: string; onOpenProblems: (() => void) | undefined }) {
  const diagnostics = rejectionDiagnostics(error);
  return (
    <div className="bf-run__rejection" role="alert">
      <p className="bf-run__rejection-head">
        <Badge tone="danger">{error.code}</Badge>
        <span>{error.message}</span>
      </p>
      <p className="bf-muted bf-code bf-run__rejection-detail">POST …/flows/{flowId}/runs — the server refused to start the run.</p>
      {diagnostics.length > 0 ? <DiagnosticsList items={diagnostics} /> : null}
      {onOpenProblems ? (
        <button type="button" className="bf-link" onClick={onOpenProblems}>
          Open PROBLEMS →
        </button>
      ) : null}
    </div>
  );
}

function InputRow({ field, scope, value, onChange }: { field: FieldDecl; scope: TypeScope | undefined; value: unknown; onChange: (v: unknown) => void }) {
  const { mediaUrl, uploadMedia } = useMedia();
  return (
    <div className="bf-field">
      <span className="bf-field__label">
        <span className="bf-code">{field.name}</span>
        {field.description ? <span className="bf-muted"> — {field.description}</span> : null}
      </span>
      <ValueEditor
        type={field.type}
        scope={scope}
        label={`Input ${field.name}`}
        value={value}
        placeholder={field.default !== undefined ? previewValue(field.default, 30) : undefined}
        mediaUrl={mediaUrl}
        uploadMedia={uploadMedia}
        onCommit={onChange}
        onClear={value === undefined ? undefined : () => onChange(undefined)}
      />
    </div>
  );
}

function Outputs({ result, outputs }: { result: NonNullable<RunState["result"]>; outputs: readonly FieldDecl[] }) {
  const { mediaUrl } = useMedia();
  const values = result.outputs ?? {};
  const names = [...new Set([...outputs.map((o) => o.name), ...Object.keys(values)])];
  return (
    <section className="bf-run__outputs" aria-label="Run outputs">
      <SectionHead title="Outputs" />
      {names.length === 0 ? <p className="bf-muted">No outputs.</p> : null}
      <dl className="bf-kv bf-kv--stack">
        {names.map((name) => (
          <div key={name} className="bf-kv__row">
            <dt>{name}</dt>
            <dd>
              <OutputValue value={values[name]} mediaUrl={mediaUrl} />
            </dd>
          </div>
        ))}
      </dl>
      {result.variables && Object.keys(result.variables).length > 0 ? (
        <>
          <SectionHead title="Public variables" />
          <pre className="bf-pre">{JSON.stringify(result.variables, null, 2)}</pre>
        </>
      ) : null}
      {result.globalWrites && Object.keys(result.globalWrites).length > 0 ? (
        <>
          <SectionHead title="Global writes" />
          <pre className="bf-pre">{JSON.stringify(result.globalWrites, null, 2)}</pre>
        </>
      ) : null}
    </section>
  );
}

function OutputMedia({ value, mediaUrl }: { value: MediaRef; mediaUrl: ((id: string) => string) | undefined }) {
  const entry = useMediaEntry(value);
  const href = mediaHref(value, mediaUrl);
  if (href && (!entry || entry.mime.startsWith("image/"))) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="bf-run__image">
        <img src={href} alt={entry?.meta?.filename ?? "output image"} />
      </a>
    );
  }
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="bf-code">
      {entry?.meta?.filename ?? entry?.mime ?? value.mediaId}
    </a>
  ) : (
    <span className="bf-code">{value.mediaId}</span>
  );
}

function OutputValue({ value, mediaUrl }: { value: unknown; mediaUrl: ((id: string) => string) | undefined }) {
  if (value === undefined) return <span className="bf-muted">—</span>;
  if (typeof value === "string") return <pre className="bf-pre">{value}</pre>;
  if (isMediaRef(value)) return <OutputMedia value={value} mediaUrl={mediaUrl} />;
  if (Array.isArray(value) && value.some(isMediaRef)) {
    return (
      <div className="bf-run__gallery">
        {value.map((v, i) => (
          <OutputValue key={i} value={v} mediaUrl={mediaUrl} />
        ))}
      </div>
    );
  }
  return <pre className="bf-pre">{JSON.stringify(value, null, 2)}</pre>;
}
