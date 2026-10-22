/**
 * `<VariablesPanel>`: the active flow's variables. `<GlobalsPanel>`: context globals.
 * `<SignatureEditor>`: a flow's inputs and outputs. All three are lists of `<FieldRow>`s with
 * a "+" row that adds an entry with a generated name and opens it for renaming; defaults,
 * values and access sit behind each row's `⋯`.
 */
import { useMemo, useState } from "react";
import { VARIABLE_NODE_TYPES, createCatalog, scopeForContext, scopeForFlow } from "@briarflow/core";
import type { FlowDocument, TypeScope } from "@briarflow/core";
import { useCanvasHandle, useDispatch, useEditorState, useEditorStore, useFlowId, useMedia } from "../context.js";
import { nextName } from "../fields.js";
import { NODE_CONFIG_MIME, NODE_TYPE_MIME, freePosition } from "../palette.js";
import { FieldRow } from "./FieldRow.js";
import { AddRow, Button, EmptyState, SectionHead, Toggle } from "./ui.js";
import { ValueEditor } from "./ValueEditor.js";

const NO_PACKS = createCatalog([]);

/** Props of {@link VariablesPanel}. */
export interface VariablesPanelProps {
  flowId?: string;
}

function useAddVariableNode(flowId: string | undefined) {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const canvas = useCanvasHandle();
  return (type: string, config: Record<string, unknown>) => {
    if (!flowId) return;
    const c = canvas.current?.center() ?? { x: 0, y: 0 };
    const occupied = store.getState().doc?.flows.find((f) => f.id === flowId)?.nodes.map((n) => n.position) ?? [];
    const r = dispatch({ op: "node.add", flowId, type, config, position: freePosition(occupied, { x: c.x - 80, y: c.y - 20 }) });
    if (r.ok && r.created.nodeId) store.select({ nodes: [r.created.nodeId] }, "replace");
  };
}

/** Grip that drags a GET node for a variable or global onto the canvas. */
function DragGrip({ type, config, name }: { type: string; config: Record<string, unknown>; name: string }) {
  return (
    <span
      className="bf-grip"
      draggable
      role="img"
      aria-label={`Drag ${name} onto the canvas`}
      title="Drag onto the canvas for a GET node"
      onDragStart={(e) => {
        e.dataTransfer.setData(NODE_TYPE_MIME, type);
        e.dataTransfer.setData(NODE_CONFIG_MIME, JSON.stringify(config));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      ⠿
    </span>
  );
}

/**
 * The active flow's variables.
 *
 * @example
 * ```tsx
 * <VariablesPanel />
 * ```
 */
export function VariablesPanel({ flowId: flowIdProp }: VariablesPanelProps) {
  const flowId = useFlowId(flowIdProp);
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const flow = doc?.flows.find((f) => f.id === flowId);
  const scope = useMemo(() => (doc && flow ? scopeForFlow(doc, flow.id, catalog ?? NO_PACKS) : undefined), [doc, flow, catalog]);
  if (!doc) return <EmptyState title="No context">Open a context to edit its variables.</EmptyState>;
  if (!flow) return <p className="bf-muted">Open a flow to edit its variables.</p>;
  return <FlowVariables flow={flow} scope={scope} />;
}

function FlowVariables({ flow, scope }: { flow: FlowDocument; scope: TypeScope | undefined }) {
  const dispatch = useDispatch();
  const { mediaUrl, uploadMedia } = useMedia();
  const addNode = useAddVariableNode(flow.id);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const flowId = flow.id;
  const add = () => {
    const name = nextName("variable", flow.variables.map((v) => v.name));
    const r = dispatch({ op: "flow.variable.create", flowId, name, type: "text", access: "private" });
    if (r.ok && r.created.variableId) setFresh(r.created.variableId);
  };
  return (
    <div className="bf-fields" aria-label={`Variables of ${flow.name}`} role="group">
      {flow.variables.length === 0 ? <p className="bf-muted bf-fields__empty">No variables yet.</p> : null}
      {flow.variables.map((v) => (
        <FieldRow
          key={v.id}
          kind="variable"
          name={v.name}
          type={v.type}
          scope={scope}
          autoEdit={fresh === v.id}
          onEditEnd={() => setFresh(undefined)}
          lead={<DragGrip type={VARIABLE_NODE_TYPES.variableGet} config={{ variableId: v.id }} name={v.name} />}
          menuTarget={{ kind: "variable", flowId, variableId: v.id }}
          menuItems={[
            { id: "get", label: "Add GET node", order: 100, run: () => addNode(VARIABLE_NODE_TYPES.variableGet, { variableId: v.id }) },
            { id: "set", label: "Add SET node", order: 100, run: () => addNode(VARIABLE_NODE_TYPES.variableSet, { variableId: v.id }) },
            {
              id: "access",
              label: v.access === "public" ? "Make private" : "Make public",
              order: 200,
              run: () => dispatch({ op: "flow.variable.setAccess", flowId, variableId: v.id, access: v.access === "public" ? "private" : "public" }),
            },
          ]}
          onRename={(name) => dispatch({ op: "flow.variable.rename", flowId, variableId: v.id, name })}
          onSetType={(type) => dispatch({ op: "flow.variable.setType", flowId, variableId: v.id, type })}
          onRemove={() => dispatch({ op: "flow.variable.delete", flowId, variableId: v.id })}
          details={
            <>
              <div className="bf-field-row__line">
                <Toggle label={`Visibility of ${v.name}`} value={v.access} options={["public", "private"] as const} onChange={(access) => dispatch({ op: "flow.variable.setAccess", flowId, variableId: v.id, access })} />
                <span className="bf-list__end">
                  <Button size="sm" variant="secondary" onClick={() => addNode(VARIABLE_NODE_TYPES.variableGet, { variableId: v.id })}>
                    Get
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => addNode(VARIABLE_NODE_TYPES.variableSet, { variableId: v.id })}>
                    Set
                  </Button>
                </span>
              </div>
              <div className="bf-field-row__line">
                <span className="bf-muted">default</span>
                <ValueEditor
                  type={v.type}
                  scope={scope}
                  label={`Default of variable ${v.name}`}
                  value={v.default}
                  mediaUrl={mediaUrl}
                  uploadMedia={uploadMedia}
                  onCommit={(value) => dispatch({ op: "flow.variable.setDefault", flowId, variableId: v.id, value })}
                  onClear={v.default === undefined ? undefined : () => dispatch({ op: "flow.variable.clearDefault", flowId, variableId: v.id })}
                />
              </div>
            </>
          }
        />
      ))}
      <AddRow label="Add variable" onAdd={add}>
        variable
      </AddRow>
    </div>
  );
}

/**
 * The context's globals (name, type, access, value).
 *
 * @example
 * ```tsx
 * <Modal open title="Globals" onClose={close}><GlobalsPanel /></Modal>
 * ```
 */
export function GlobalsPanel({ flowId: flowIdProp }: { flowId?: string }) {
  const flowId = useFlowId(flowIdProp);
  const dispatch = useDispatch();
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const { mediaUrl, uploadMedia } = useMedia();
  const addNode = useAddVariableNode(flowId);
  const scope = useMemo(() => (doc ? scopeForContext(doc, catalog ?? NO_PACKS) : undefined), [doc, catalog]);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  if (!doc) return <EmptyState title="No context">Open a context to edit its globals.</EmptyState>;
  const add = () => {
    const name = nextName("global", doc.globals.map((g) => g.name));
    const r = dispatch({ op: "global.create", name, type: "text", access: "readwrite" });
    if (r.ok && r.created.globalId) setFresh(r.created.globalId);
  };
  return (
    <div className="bf-fields bf-fields--wide" role="group" aria-label="Globals">
      {doc.globals.length === 0 ? <p className="bf-muted bf-fields__empty">No globals yet. Globals are shared by every flow in this context.</p> : null}
      {doc.globals.map((g) => (
        <FieldRow
          key={g.id}
          kind="global"
          name={g.name}
          type={g.type}
          scope={scope}
          autoEdit={fresh === g.id}
          onEditEnd={() => setFresh(undefined)}
          onRename={(name) => dispatch({ op: "global.rename", globalId: g.id, name })}
          onSetType={(type) => dispatch({ op: "global.setType", globalId: g.id, type })}
          onRemove={() => dispatch({ op: "global.delete", globalId: g.id })}
          menuTarget={{ kind: "global", globalId: g.id }}
          menuItems={[
            ...(flowId
              ? [
                  { id: "get", label: "Add GET node", order: 100, run: () => addNode(VARIABLE_NODE_TYPES.globalGet, { globalId: g.id }) },
                  { id: "set", label: "Add SET node", order: 100, disabled: g.access === "readonly", run: () => addNode(VARIABLE_NODE_TYPES.globalSet, { globalId: g.id }) },
                ]
              : []),
            {
              id: "access",
              label: g.access === "readonly" ? "Make read-write" : "Make read-only",
              order: 200,
              run: () => dispatch({ op: "global.setAccess", globalId: g.id, access: g.access === "readonly" ? "readwrite" : "readonly" }),
            },
          ]}
          trail={<Toggle label={`Access of ${g.name}`} value={g.access} options={["readonly", "readwrite"] as const} onChange={(access) => dispatch({ op: "global.setAccess", globalId: g.id, access })} />}
          details={
            <>
              <div className="bf-field-row__line">
                <span className="bf-muted">value</span>
                <ValueEditor
                  type={g.type}
                  scope={scope}
                  label={`Value of global ${g.name}`}
                  value={g.value}
                  mediaUrl={mediaUrl}
                  uploadMedia={uploadMedia}
                  onCommit={(value) => dispatch({ op: "global.setValue", globalId: g.id, value })}
                  onClear={g.value === undefined ? undefined : () => dispatch({ op: "global.clearValue", globalId: g.id })}
                />
              </div>
              {flowId ? (
                <div className="bf-field-row__line">
                  <span className="bf-muted">add to flow</span>
                  <span className="bf-list__end">
                    <Button size="sm" variant="secondary" onClick={() => addNode(VARIABLE_NODE_TYPES.globalGet, { globalId: g.id })}>
                      Get
                    </Button>
                    <Button size="sm" variant="secondary" disabled={g.access === "readonly"} onClick={() => addNode(VARIABLE_NODE_TYPES.globalSet, { globalId: g.id })}>
                      Set
                    </Button>
                  </span>
                </div>
              ) : null}
            </>
          }
        />
      ))}
      <AddRow label="Add global" onAdd={add}>
        global
      </AddRow>
    </div>
  );
}

/** Props of {@link SignatureEditor}. */
export interface SignatureEditorProps {
  flowId?: string;
  /** Only one side of the signature. Default: both. */
  dir?: "input" | "output";
}

/**
 * Edits a flow's inputs (name, type, default) and outputs (name, type).
 *
 * @example
 * ```tsx
 * <SignatureEditor flowId="flow_p" />
 * ```
 */
export function SignatureEditor({ flowId: flowIdProp, dir }: SignatureEditorProps) {
  const flowId = useFlowId(flowIdProp);
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const flow = doc?.flows.find((f) => f.id === flowId);
  const scope = useMemo(() => (doc && flow ? scopeForFlow(doc, flow.id, catalog ?? NO_PACKS) : undefined), [doc, flow, catalog]);
  if (!flow) return null;
  return (
    <section aria-label="Flow signature" className="bf-signature">
      {dir !== "output" ? <SignatureList flow={flow} scope={scope} dir="input" /> : null}
      {dir !== "input" ? <SignatureList flow={flow} scope={scope} dir="output" /> : null}
    </section>
  );
}

function SignatureList({ flow, scope, dir }: { flow: FlowDocument; scope: TypeScope | undefined; dir: "input" | "output" }) {
  const dispatch = useDispatch();
  const { mediaUrl, uploadMedia } = useMedia();
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const fields = dir === "input" ? flow.inputs : flow.outputs;
  const flowId = flow.id;
  const add = () => {
    const name = nextName(dir, fields.map((f) => f.name));
    const r = dispatch(dir === "input" ? { op: "flow.input.add", flowId, name, type: "text" } : { op: "flow.output.add", flowId, name, type: "text" });
    if (r.ok) setFresh(name);
  };
  return (
    <div className="bf-fields" role="group" aria-label={dir === "input" ? "Flow inputs" : "Flow outputs"}>
      <SectionHead title={dir === "input" ? "Inputs" : "Outputs"} />
      {fields.map((f) => (
        <FieldRow
          key={f.name}
          kind={dir}
          name={f.name}
          type={f.type}
          scope={scope}
          autoEdit={fresh === f.name}
          onEditEnd={() => setFresh(undefined)}
          menuTarget={{ kind: "field", fieldKind: dir, name: f.name, flowId }}
          onRename={(n) => dispatch(dir === "input" ? { op: "flow.input.rename", flowId, name: f.name, newName: n } : { op: "flow.output.rename", flowId, name: f.name, newName: n })}
          onSetType={(t) => dispatch(dir === "input" ? { op: "flow.input.setType", flowId, name: f.name, type: t } : { op: "flow.output.setType", flowId, name: f.name, type: t })}
          onRemove={() => dispatch(dir === "input" ? { op: "flow.input.remove", flowId, name: f.name } : { op: "flow.output.remove", flowId, name: f.name })}
          {...(dir === "input"
            ? {
                details: (
                  <div className="bf-field-row__line">
                    <span className="bf-muted">default</span>
                    <ValueEditor
                      type={f.type}
                      scope={scope}
                      label={`Default of input ${f.name}`}
                      value={f.default}
                      mediaUrl={mediaUrl}
                      uploadMedia={uploadMedia}
                      onCommit={(value) => dispatch({ op: "flow.input.setDefault", flowId, name: f.name, value })}
                      onClear={f.default === undefined ? undefined : () => dispatch({ op: "flow.input.clearDefault", flowId, name: f.name })}
                    />
                  </div>
                ),
              }
            : {})}
        />
      ))}
      <AddRow label={`Add flow ${dir}`} onAdd={add}>
        {dir}
      </AddRow>
    </div>
  );
}
