/**
 * `<RunPanel>`: run the active flow. Inputs form generated from the flow signature, run /
 * cancel, status, event log (click selects the node) and outputs (text, image previews, JSON).
 */
import { useEffect, useMemo, useState } from "react";
import { createCatalog, scopeForFlow } from "@briarflow/core";
import type { Diagnostic, FieldDecl, RunEvent, SerializedError, TypeScope } from "@briarflow/core";
import { isRunFinished } from "@briarflow/editor";
import type { RunState } from "@briarflow/editor";
import { useEditorState, useEditorStore, useFlowId, useLocalToasts, useMedia } from "../context.js";
import { formatDuration, isMediaRef, mediaHref, previewValue } from "../values.js";
import { Badge, Button, EmptyState, SectionHead, StatusDot } from "./ui.js";
import type { DotState, Tone } from "./ui.js";
import { ValueEditor } from "./ValueEditor.js";
import { DiagnosticsList } from "./DiagnosticsList.js";

const NO_PACKS = createCatalog([]);

/** Props of {@link RunPanel}. */
export interface RunPanelProps {
  flowId?: string;
  /** Shows an "Open PROBLEMS" link on a rejected run (e.g. switch the dock tab). */
  onOpenProblems?: () => void;
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

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function eventDetail(e: RunEvent): string {
  switch (e.type) {
    case "run.started":
      return e.flowId;
    case "node.started":
      return `attempt ${e.attempt}`;
    case "node.progress":
      return `${e.fraction.toFixed(2)}${e.message ? ` ${e.message}` : ""}`;
    case "node.retrying":
      return `retry ${e.nextAttempt} in ${formatDuration(e.delayMs)}: ${e.error.message}`;
    case "node.completed":
      return `${e.cached ? "cached · " : ""}${formatDuration(e.durationMs)}`;
    case "node.failed":
      return e.error.message;
    case "node.skipped":
      return e.reason;
    case "run.completed":
      return e.result.status;
  }
}

/**
 * @example
 * ```tsx
 * <RunPanel />
 * ```
 */
export function RunPanel({ flowId: flowIdProp, onOpenProblems }: RunPanelProps) {
  const store = useEditorStore();
  const flowId = useFlowId(flowIdProp);
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const run = useEditorState((s) => s.run);
  const flow = doc?.flows.find((f) => f.id === flowId);
  const scope = useMemo(() => (doc && flow ? scopeForFlow(doc, flow.id, catalog ?? NO_PACKS) : undefined), [doc, flow, catalog]);
  const { push } = useLocalToasts();
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [useCache, setUseCache] = useState(true);
  const [filter, setFilter] = useState("");
  const errorCount = useFlowErrorCount(flowId);
  useEffect(() => setInputs({}), [flowId]);

  const running = run !== undefined && !isRunFinished(run);
  const start = () => {
    if (!flow || running) return;
    const values: Record<string, unknown> = {};
    for (const f of flow.inputs) if (inputs[f.name] !== undefined) values[f.name] = inputs[f.name];
    store.startRun({ flowId: flow.id, inputs: values, useCache }).catch((err: unknown) => {
      // A rejected run is shown in the panel (state.run.status "rejected"); toast anything else.
      if (store.getState().run?.status !== "rejected") push(err instanceof Error ? err.message : String(err));
    });
  };

  useEffect(() => {
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
  const titleOf = (nodeId: string) => {
    const n = flow.nodes.find((x) => x.id === nodeId);
    if (!n) return nodeId;
    if (n.title) return n.title;
    if (n.type === "briar.input") return "Input";
    if (n.type === "briar.output") return "Output";
    return catalog?.get(n.type)?.title ?? n.type;
  };
  const events = (shown?.events ?? []).filter((e) => !filter || ("nodeId" in e && e.nodeId === filter));
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
          <InputRow key={f.name} field={f} scope={scope} value={inputs[f.name]} onChange={(v) => setInputs((s) => ({ ...s, [f.name]: v }))} />
        ))}
        <label className="bf-check">
          <input type="checkbox" className="bf-check__box" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} />
          <span>Use cache</span>
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
          <span className="bf-run__filter">
            <label className="bf-visually-hidden" htmlFor="bf-run-filter">
              Filter events by node
            </label>
            <select id="bf-run-filter" className="bf-input bf-input--select bf-input--compact" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">all nodes</option>
              {flow.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {titleOf(n.id)}
                </option>
              ))}
            </select>
          </span>
        </div>
        {shown?.error && shown.status === "rejected" ? (
          <Rejection error={shown.error} flowId={flow.id} onOpenProblems={onOpenProblems} />
        ) : shown?.error ? (
          <p className="bf-run__error" role="alert">
            {shown.error.message}
          </p>
        ) : null}
        <ol className="bf-log" aria-label="Run events">
          {events.length === 0 ? <li className="bf-log__empty bf-muted">{!shown ? "No runs yet — press RUN or Ctrl+Enter." : shown.status === "rejected" ? "No events: the run was not started." : "Waiting for events…"}</li> : null}
          {events.map((e) => {
            const nodeId = "nodeId" in e ? e.nodeId : undefined;
            return (
              <li key={e.seq}>
                <button type="button" className="bf-log__line" disabled={!nodeId} onClick={() => nodeId && store.select({ nodes: [nodeId], edges: [] }, "replace")}>
                  <span className="bf-muted">{timeOf(e.at)}</span>
                  <span className={`bf-log__type bf-log__type--${e.type.replace(".", "-")}`}>{e.type}</span>
                  <span className="bf-log__node">{nodeId ? titleOf(nodeId) : ""}</span>
                  <span className="bf-log__detail">{eventDetail(e)}</span>
                </button>
              </li>
            );
          })}
        </ol>
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

function OutputValue({ value, mediaUrl }: { value: unknown; mediaUrl: ((id: string) => string) | undefined }) {
  if (value === undefined) return <span className="bf-muted">—</span>;
  if (typeof value === "string") return <pre className="bf-pre">{value}</pre>;
  if (isMediaRef(value)) {
    const href = mediaHref(value, mediaUrl);
    if (href && value.mime.startsWith("image/")) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className="bf-run__image">
          <img src={href} alt={value.meta?.filename ?? "output image"} />
        </a>
      );
    }
    return href ? (
      <a href={href} target="_blank" rel="noreferrer" className="bf-code">
        {value.meta?.filename ?? value.mime}
      </a>
    ) : (
      <span className="bf-code">{value.uri}</span>
    );
  }
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
