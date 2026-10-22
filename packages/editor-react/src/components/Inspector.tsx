/**
 * `<Inspector>`: details of the selection. One node: title, id, config, input constants,
 * outputs, diagnostics. One edge: both ends and their types. Nothing: the flow's name,
 * description and signature.
 */
import { useMemo } from "react";
import type { ReactNode } from "react";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE, createCatalog, parseType, scopeForFlow } from "@briarflow/core";
import type { ConfigField, ContextDocument, FlowDocument, TypeRef, TypeScope } from "@briarflow/core";
import { useDispatch, useEditorState, useEditorStore, useFlowView, useMedia } from "../context.js";
import type { FlowView, NodeView } from "../graph.js";
import { previewValue } from "../values.js";
import { DiagnosticsList } from "./DiagnosticsList.js";
import { deleteSelection } from "./selection.js";
import { TypePicker } from "./TypePicker.js";
import { Badge, Button, EmptyState, InlineText, TypeChip } from "./ui.js";
import { ValueEditor } from "./ValueEditor.js";
import { SignatureEditor } from "./VariablesPanel.js";

const NO_PACKS = createCatalog([]);

/** Props of {@link Inspector}. */
export interface InspectorProps {
  flowId?: string;
}

/**
 * @example
 * ```tsx
 * <Inspector />
 * ```
 */
export function Inspector({ flowId }: InspectorProps) {
  const view = useFlowView(flowId);
  const selection = useEditorState((s) => s.selection);
  const doc = useEditorState((s) => s.doc);
  if (!doc) return <EmptyState title="Nothing open">Open a context and a flow.</EmptyState>;
  if (!view) return <EmptyState title="No flow">Pick or create a flow.</EmptyState>;
  const count = selection.nodes.length + selection.edges.length;
  if (count === 0) return <FlowDetails flow={view.flow} />;
  if (selection.nodes.length === 1 && selection.edges.length === 0) {
    const node = view.byId.get(selection.nodes[0]!);
    if (node) return <NodeDetails doc={doc} view={view} node={node} />;
  }
  if (selection.edges.length === 1 && selection.nodes.length === 0) {
    const edge = view.edges.find((e) => e.id === selection.edges[0]);
    if (edge) return <EdgeDetails view={view} edgeId={edge.id} />;
  }
  return <MultiDetails view={view} nodes={selection.nodes.length} edges={selection.edges.length} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bf-inspector__section">
      <h3 className="bf-inspector__heading">{title}</h3>
      {children}
    </section>
  );
}

function CopyId({ id }: { id: string }) {
  return (
    <span className="bf-inspector__id">
      <code className="bf-code bf-muted">{id}</code>
      <Button size="sm" variant="ghost" aria-label={`Copy id ${id}`} onClick={() => void navigator.clipboard?.writeText(id).catch(() => undefined)}>
        copy
      </Button>
    </span>
  );
}

function FlowDetails({ flow }: { flow: FlowDocument }) {
  const dispatch = useDispatch();
  return (
    <div className="bf-inspector__stack">
      <div>
        <p className="bf-inspector__kind">Flow</p>
        <InlineText className="bf-inspector__name" value={flow.name} label="Flow name" onCommit={(name) => dispatch({ op: "flow.rename", flowId: flow.id, name })} />
        <CopyId id={flow.id} />
      </div>
      <Section title="Description">
        <InlineText allowEmpty value={flow.description ?? ""} placeholder="What this flow does" label="Flow description" onCommit={(d) => dispatch({ op: "flow.setDescription", flowId: flow.id, description: d === "" ? null : d })} />
      </Section>
      <Section title="Signature">
        <SignatureEditor flowId={flow.id} />
      </Section>
      <Section title="Diagnostics">
        <DiagnosticsList flowId={flow.id} />
      </Section>
    </div>
  );
}

function NodeDetails({ doc, view, node }: { doc: ContextDocument; view: FlowView; node: NodeView }) {
  const dispatch = useDispatch();
  const { mediaUrl, uploadMedia } = useMedia();
  const flowId = view.flowId;
  const run = node.run;
  return (
    <div className="bf-inspector__stack">
      <div>
        <p className="bf-inspector__kind">{node.builtin ? "Built-in node" : node.typeTitle}</p>
        {node.builtin ? (
          <h3 className="bf-inspector__name">{node.title}</h3>
        ) : (
          <InlineText
            allowEmpty
            className="bf-inspector__name"
            value={node.instance.title ?? ""}
            placeholder={node.title}
            label="Node title"
            onCommit={(t) => dispatch({ op: "node.setTitle", flowId, nodeId: node.id, title: t === "" ? null : t })}
          />
        )}
        <CopyId id={node.id} />
        <code className="bf-code bf-muted">{node.type}</code>
        {node.definition?.description ? <p className="bf-muted bf-inspector__desc">{node.definition.description}</p> : null}
      </div>
      {node.definition && Object.keys(node.definition.config).length > 0 ? (
        <Section title="Config">
          <ConfigEditor doc={doc} flowId={flowId} node={node} />
        </Section>
      ) : null}
      {node.builtin ? (
        <Section title="Signature">
          <SignatureEditor flowId={flowId} dir={node.type === FLOW_INPUT_NODE_TYPE ? "input" : "output"} />
        </Section>
      ) : null}
      {node.inputs.length > 0 && node.type !== FLOW_OUTPUT_NODE_TYPE ? (
        <Section title="Inputs">
          <dl className="bf-kv bf-kv--stack">
            {node.inputs.map((p) => (
              <div key={p.name} className="bf-kv__row">
                <dt>
                  {p.title} <TypeChip type={p.type} scope={view.scope} />
                </dt>
                <dd>
                  {p.source ? <span className="bf-node__source">← {p.source.label}</span> : null}
                  {p.source && p.hasValue ? <span className="bf-muted bf-code">used when disconnected: {previewValue(p.value)}</span> : null}
                  {!p.source ? (
                    <ValueEditor
                      type={p.type}
                      scope={view.scope}
                      widget={p.widget}
                      label={`${node.title} ${p.title}`}
                      value={p.hasValue ? p.value : undefined}
                      placeholder={p.hasDefault ? `default ${previewValue(p.default, 30)}` : undefined}
                      invalid={p.errors.length > 0}
                      mediaUrl={mediaUrl}
                      uploadMedia={uploadMedia}
                      onCommit={(value) => dispatch({ op: "node.setValue", flowId, nodeId: node.id, port: p.name, value })}
                      onClear={p.hasValue ? () => dispatch({ op: "node.clearValue", flowId, nodeId: node.id, port: p.name }) : undefined}
                    />
                  ) : null}
                  {p.hasValue && !p.source ? (
                    <Button size="sm" variant="ghost" onClick={() => dispatch({ op: "node.clearValue", flowId, nodeId: node.id, port: p.name })}>
                      clear
                    </Button>
                  ) : null}
                  {p.errors.map((e) => (
                    <span key={e} className="bf-field__error">
                      {e}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
      {node.outputs.length > 0 ? (
        <Section title="Outputs">
          <dl className="bf-kv">
            {node.outputs.map((p) => (
              <div key={p.name} className="bf-kv__row">
                <dt>{p.title}</dt>
                <dd>
                  <TypeChip type={p.type} scope={view.scope} />
                  {run?.outputs && p.name in run.outputs ? <span className="bf-code bf-muted">{previewValue(run.outputs[p.name], 40)}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}
      {run ? (
        <Section title="Last run">
          <p className="bf-code">
            <Badge tone={run.status === "failed" ? "danger" : run.status === "running" ? "sky" : run.status === "cached" ? "lavender" : run.status === "skipped" ? "stone" : "mint"}>{run.status}</Badge>{" "}
            {run.error?.message ?? run.message ?? ""}
          </p>
        </Section>
      ) : null}
      <Section title="Diagnostics">
        <DiagnosticsList flowId={flowId} nodeId={node.id} />
      </Section>
    </div>
  );
}

function ConfigEditor({ doc, flowId, node }: { doc: ContextDocument; flowId: string; node: NodeView }) {
  const dispatch = useDispatch();
  const catalog = useEditorState((s) => s.catalog);
  const scope = useMemo(() => scopeForFlow(doc, flowId, catalog ?? NO_PACKS), [doc, flowId, catalog]);
  const flow = doc.flows.find((f) => f.id === flowId);
  const config = node.instance.config ?? {};
  const set = (key: string, value: unknown) => {
    const next: Record<string, unknown> = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    dispatch({ op: "node.setConfig", flowId, nodeId: node.id, config: next });
  };
  return (
    <div className="bf-config">
      {Object.entries(node.definition?.config ?? {}).map(([key, field]) => (
        <label key={key} className="bf-field">
          <span className="bf-field__label">
            {field.title ?? key}
            {field.required ? "" : " (optional)"}
          </span>
          <ConfigFieldEditor field={field} name={key} value={config[key]} scope={scope} doc={doc} flow={flow} onChange={(v) => set(key, v)} />
          {field.description ? <span className="bf-field__hint">{field.description}</span> : null}
        </label>
      ))}
    </div>
  );
}

function ConfigFieldEditor({
  field,
  name,
  value,
  scope,
  doc,
  flow,
  onChange,
}: {
  field: ConfigField;
  name: string;
  value: unknown;
  scope: TypeScope;
  doc: ContextDocument;
  flow: FlowDocument | undefined;
  onChange: (v: unknown) => void;
}) {
  const label = `Config ${name}`;
  const select = (options: { value: string; label: string }[]) => (
    <select className="bf-input bf-input--select" aria-label={label} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
      <option value="">{field.required ? "— choose —" : "— none —"}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  switch (field.kind) {
    case "text": {
      const t: TypeRef = { kind: "primitive", name: "text", ...(field.multiline ? { constraints: { multiline: true } } : {}) };
      return <ValueEditor type={t} label={label} value={value} onCommit={onChange} />;
    }
    case "int": {
      const t: TypeRef = { kind: "primitive", name: "int", constraints: { ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}) } };
      return <ValueEditor type={t} label={label} value={value} onCommit={onChange} />;
    }
    case "boolean":
      return <input type="checkbox" className="bf-check__box" aria-label={label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "choice":
      return select((field.choices ?? []).map((c) => ({ value: c, label: c })));
    case "type": {
      const current = typeof value === "object" && value !== null ? (value as TypeRef) : undefined;
      const parsed = current ?? (typeof value === "string" ? parseTypeOrUndefined(value, scope) : undefined);
      return <TypePicker type={parsed} scope={scope} label={label} onCommit={(t) => onChange(t)} />;
    }
    case "typeId":
      return select(
        scope
          .all()
          .filter((t) => !field.typeKind || field.typeKind === "any" || t.decl.kind === field.typeKind)
          .map((t) => ({ value: t.decl.id, label: `${t.decl.name} (${t.origin})` })),
      );
    case "flowVariable":
      return select((flow?.variables ?? []).map((v) => ({ value: v.id, label: v.name })));
    case "global":
      return select(doc.globals.filter((g) => !field.writable || g.access === "readwrite").map((g) => ({ value: g.id, label: `${g.name}${g.access === "readonly" ? " (readonly)" : ""}` })));
  }
}

function parseTypeOrUndefined(shorthand: string, scope: TypeScope): TypeRef | undefined {
  const r = parseType(shorthand, { scope });
  return r.ok ? r.type : undefined;
}

function EdgeDetails({ view, edgeId }: { view: FlowView; edgeId: string }) {
  const dispatch = useDispatch();
  const edge = view.edges.find((e) => e.id === edgeId)!;
  const from = view.byId.get(edge.source);
  const to = view.byId.get(edge.target);
  const out = from?.outputs.find((p) => p.name === edge.sourcePort);
  const inp = to?.inputs.find((p) => p.name === edge.targetPort);
  return (
    <div className="bf-inspector__stack">
      <div>
        <p className="bf-inspector__kind">Edge</p>
        <CopyId id={edge.id} />
      </div>
      <Section title="From">
        <p>
          {from?.title ?? edge.source}.<span className="bf-code">{edge.sourcePort}</span>
        </p>
        {out ? <TypeChip type={out.type} scope={view.scope} /> : null}
      </Section>
      <Section title="To">
        <p>
          {to?.title ?? edge.target}.<span className="bf-code">{edge.targetPort}</span>
        </p>
        {inp ? <TypeChip type={inp.type} scope={view.scope} /> : null}
      </Section>
      {edge.invalid ? <p className="bf-field__error">{edge.invalid}</p> : null}
      <Button variant="danger" onClick={() => dispatch({ op: "edge.disconnect", flowId: view.flowId, edgeId: edge.id })}>
        Disconnect
      </Button>
      <Section title="Diagnostics">
        <DiagnosticsList flowId={view.flowId} edgeId={edge.id} />
      </Section>
    </div>
  );
}

function MultiDetails({ view, nodes, edges }: { view: FlowView; nodes: number; edges: number }) {
  const store = useEditorStore();
  const dispatch = useDispatch();
  return (
    <div className="bf-inspector__stack">
      <p className="bf-inspector__kind">Selection</p>
      <p>
        {nodes} node{nodes === 1 ? "" : "s"}, {edges} edge{edges === 1 ? "" : "s"}
      </p>
      <Button variant="danger" onClick={() => deleteSelection(store, dispatch, view.flowId, view)}>
        Delete selection
      </Button>
    </div>
  );
}
