/**
 * `<TypesPanel>`: structs and enums, as a list (global types, the active flow's local types)
 * beside an editor for the picked type. "+ struct" / "+ enum" add a type with a generated
 * name and open it; fields and members are `<FieldRow>`s with a "+" row at the end.
 */
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createCatalog, scopeForContext, scopeForFlow } from "@briarflow/core";
import type { ContextDocument, EnumDecl, StructDecl, TypeDecl, TypeScope } from "@briarflow/core";
import { useDispatch, useEditorState, useFlowId } from "../context.js";
import { nextName } from "../fields.js";
import { useContextMenu } from "./ContextMenu.js";
import { isTypingTarget } from "./selection.js";
import { FieldRow } from "./FieldRow.js";
import { AddRow, Badge, Button, EditableName, EmptyState, InlineText } from "./ui.js";

const NO_PACKS = createCatalog([]);

type TypeScopeRef = { kind: "global" } | { kind: "flow"; flowId: string };

/** Props of {@link TypesPanel}. */
export interface TypesPanelProps {
  /** Flow whose local types are shown. Default: the active flow. */
  flowId?: string;
}

/** Rough usage count: how often the type id is referenced in the document. */
function usageCount(doc: ContextDocument, typeId: string): number {
  const json = JSON.stringify(doc);
  const needle = JSON.stringify(typeId);
  let count = 0;
  for (let i = json.indexOf(needle); i !== -1; i = json.indexOf(needle, i + needle.length)) count++;
  return Math.max(0, count - 1);
}

/**
 * @example
 * ```tsx
 * <TypesPanel />
 * ```
 */
export function TypesPanel({ flowId: flowIdProp }: TypesPanelProps) {
  const flowId = useFlowId(flowIdProp);
  const dispatch = useDispatch();
  const doc = useEditorState((s) => s.doc);
  const catalog = useEditorState((s) => s.catalog);
  const flow = doc?.flows.find((f) => f.id === flowId);
  const globalScope = useMemo(() => (doc ? scopeForContext(doc, catalog ?? NO_PACKS) : undefined), [doc, catalog]);
  const flowScope = useMemo(() => (doc && flow ? scopeForFlow(doc, flow.id, catalog ?? NO_PACKS) : undefined), [doc, flow, catalog]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const all = useMemo(() => [...(doc?.types ?? []), ...(flow?.types ?? [])], [doc, flow]);
  useEffect(() => {
    if (selected === undefined || !all.some((t) => t.id === selected)) setSelected(all[0]?.id);
  }, [all, selected]);
  if (!doc) return <EmptyState title="No context">Open a context to edit its types.</EmptyState>;

  const create = (kind: "struct" | "enum", scope: TypeScopeRef) => {
    const name = nextName(kind === "struct" ? "Struct" : "Enum", all.map((t) => t.name));
    const r = dispatch(kind === "struct" ? { op: "type.defineStruct", scope, name } : { op: "type.defineEnum", scope, name });
    if (r.ok && r.created.typeId) {
      setSelected(r.created.typeId);
      setFresh(r.created.typeId);
    }
  };
  const menu = useContextMenu();
  const typeMenu = (e: ReactMouseEvent, t: TypeDecl) => {
    const isLocal = flow?.types.some((x) => x.id === t.id) === true;
    menu.open(e, { kind: "type", typeId: t.id }, [
      {
        id: "rename",
        label: "Rename",
        order: 200,
        run: () => {
          setSelected(t.id);
          setFresh(t.id);
        },
      },
      ...(isLocal
        ? [{ id: "scope", label: "Move to global types", order: 300, run: () => dispatch({ op: "type.moveScope", typeId: t.id, to: { kind: "global" } }) }]
        : flow
          ? [{ id: "scope", label: `Move to ${flow.name}`, order: 300, run: () => dispatch({ op: "type.moveScope", typeId: t.id, to: { kind: "flow", flowId: flow.id } }) }]
          : []),
      { id: "delete", label: "Delete type", order: 900, danger: true, run: () => dispatch({ op: "type.delete", typeId: t.id }) },
    ]);
  };
  const decl = all.find((t) => t.id === selected);
  const local = decl !== undefined && flow?.types.some((t) => t.id === decl.id) === true;
  return (
    <div className="bf-types">
      <nav className="bf-types__nav" aria-label="Types">
        <TypeGroup title="Global" types={doc.types} selected={selected} onSelect={setSelected} onMenu={typeMenu} onCreate={(k) => create(k, { kind: "global" })} />
        {flow ? (
          <TypeGroup title={`Local · ${flow.name}`} types={flow.types} selected={selected} onSelect={setSelected} onMenu={typeMenu} onCreate={(k) => create(k, { kind: "flow", flowId: flow.id })} />
        ) : (
          <p className="bf-muted bf-pad">Open a flow to see its local types.</p>
        )}
      </nav>
      <div className="bf-types__detail">
        {decl ? (
          <TypeEditor
            key={decl.id}
            doc={doc}
            decl={decl}
            scope={local ? flowScope : globalScope}
            local={local}
            flowId={flow?.id}
            autoEdit={fresh === decl.id}
            onEditEnd={() => setFresh(undefined)}
          />
        ) : (
          <EmptyState title="No type picked">Add a struct (named fields) or an enum (a fixed set of values) on the left.</EmptyState>
        )}
      </div>
    </div>
  );
}

function TypeGroup({
  title,
  types,
  selected,
  onSelect,
  onMenu,
  onCreate,
}: {
  title: string;
  types: readonly TypeDecl[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  onMenu: (e: ReactMouseEvent, decl: TypeDecl) => void;
  onCreate: (kind: "struct" | "enum") => void;
}) {
  return (
    <section className="bf-types__group" aria-label={`${title} types`}>
      <h3 className="bf-types__group-title">{title}</h3>
      <ul className="bf-types__list">
        {types.map((t) => (
          <li key={t.id}>
            <button type="button" className={t.id === selected ? "bf-types__item bf-types__item--on" : "bf-types__item"} aria-current={t.id === selected ? "true" : undefined} onClick={() => onSelect(t.id)} onContextMenu={(e) => onMenu(e, t)}>
              <span className={`bf-kind bf-kind--${t.kind}`} aria-label={t.kind}>
                {t.kind === "struct" ? "S" : "E"}
              </span>
              <span className="bf-code bf-types__name">{t.name}</span>
              <span className="bf-muted bf-types__count">{t.kind === "struct" ? t.fields.length : t.members.length}</span>
            </button>
          </li>
        ))}
        {types.length === 0 ? <li className="bf-muted bf-types__none">none</li> : null}
      </ul>
      <div className="bf-types__adds">
        <AddRow label={`Add struct to ${title}`} onAdd={() => onCreate("struct")}>
          struct
        </AddRow>
        <AddRow label={`Add enum to ${title}`} onAdd={() => onCreate("enum")}>
          enum
        </AddRow>
      </div>
    </section>
  );
}

function TypeEditor({
  doc,
  decl,
  scope,
  local,
  flowId,
  autoEdit,
  onEditEnd,
}: {
  doc: ContextDocument;
  decl: TypeDecl;
  scope: TypeScope | undefined;
  local: boolean;
  flowId: string | undefined;
  autoEdit: boolean;
  onEditEnd: () => void;
}) {
  const dispatch = useDispatch();
  const uses = usageCount(doc, decl.id);
  return (
    <div className="bf-type-editor">
      <header className="bf-type-editor__head">
        <span className={`bf-kind bf-kind--${decl.kind}`} aria-hidden="true">
          {decl.kind === "struct" ? "S" : "E"}
        </span>
        <EditableName className="bf-type-editor__name" value={decl.name} label={`Name of type ${decl.name}`} autoEdit={autoEdit} onEditEnd={onEditEnd} onCommit={(name) => dispatch({ op: "type.rename", typeId: decl.id, name })} />
        <Badge tone="lavender">{decl.kind}</Badge>
        <Badge tone="stone">{local ? "local" : "global"}</Badge>
        <span className="bf-muted bf-code" title="References in this context">
          {uses} use{uses === 1 ? "" : "s"}
        </span>
        <span className="bf-list__end">
          {!local && flowId ? (
            <Button size="sm" variant="secondary" onClick={() => dispatch({ op: "type.moveScope", typeId: decl.id, to: { kind: "flow", flowId } })} title="Move to the open flow's local types">
              → local
            </Button>
          ) : null}
          {local ? (
            <Button size="sm" variant="secondary" onClick={() => dispatch({ op: "type.moveScope", typeId: decl.id, to: { kind: "global" } })} title="Move to global types">
              → global
            </Button>
          ) : null}
          <Button size="sm" variant="danger" aria-label={`Delete type ${decl.name}`} onClick={() => dispatch({ op: "type.delete", typeId: decl.id })}>
            Delete
          </Button>
        </span>
      </header>
      <InlineText allowEmpty value={decl.description ?? ""} placeholder="Description (optional)" label={`Description of ${decl.name}`} onCommit={(d) => dispatch({ op: "type.setDescription", typeId: decl.id, description: d === "" ? null : d })} />
      {decl.kind === "struct" ? <StructFields decl={decl} scope={scope} /> : <EnumMembers decl={decl} />}
    </div>
  );
}

function StructFields({ decl, scope }: { decl: StructDecl; scope: TypeScope | undefined }) {
  const dispatch = useDispatch();
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const add = () => {
    const name = nextName("field", decl.fields.map((f) => f.name));
    const r = dispatch({ op: "type.field.add", typeId: decl.id, name, type: "text" });
    if (r.ok) setFresh(name);
  };
  return (
    <div className="bf-fields" role="group" aria-label={`Fields of ${decl.name}`}>
      <h4 className="bf-type-editor__sub">Fields</h4>
      {decl.fields.length === 0 ? <p className="bf-muted bf-fields__empty">No fields yet.</p> : null}
      {decl.fields.map((f) => (
        <FieldRow
          key={f.name}
          kind="field"
          name={f.name}
          type={f.type}
          scope={scope}
          autoEdit={fresh === f.name}
          onEditEnd={() => setFresh(undefined)}
          menuTarget={{ kind: "field", fieldKind: "field", name: f.name, typeId: decl.id }}
          onRename={(name) => dispatch({ op: "type.field.rename", typeId: decl.id, field: f.name, name })}
          onSetType={(type) => dispatch({ op: "type.field.setType", typeId: decl.id, field: f.name, type })}
          onRemove={() => dispatch({ op: "type.field.remove", typeId: decl.id, field: f.name })}
        />
      ))}
      <AddRow label={`Add field to ${decl.name}`} onAdd={add}>
        field
      </AddRow>
    </div>
  );
}

function EnumMembers({ decl }: { decl: EnumDecl }) {
  const dispatch = useDispatch();
  const menu = useContextMenu();
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const add = () => {
    const value = nextName("value", decl.members.map((m) => m.value));
    const r = dispatch({ op: "type.enum.addMember", typeId: decl.id, value });
    if (r.ok) setFresh(value);
  };
  return (
    <div className="bf-fields" role="group" aria-label={`Members of ${decl.name}`}>
      <h4 className="bf-type-editor__sub">Values</h4>
      {decl.members.length === 0 ? <p className="bf-muted bf-fields__empty">No values yet.</p> : null}
      {decl.members.map((m) => (
        <div
          key={m.value}
          className="bf-field-row"
          onContextMenu={(e) =>
            !isTypingTarget(e.target) &&
            menu.open(e, { kind: "field", fieldKind: "value", name: m.value, typeId: decl.id }, [
              { id: "rename", label: "Rename", order: 200, run: () => setFresh(m.value) },
              { id: "remove", label: "Remove value", order: 900, danger: true, run: () => dispatch({ op: "type.enum.removeMember", typeId: decl.id, value: m.value }) },
            ])
          }
        >
          <div className="bf-field-row__main">
            <EditableName
              className="bf-field-row__name"
              value={m.value}
              label={`Value ${m.value} of ${decl.name}`}
              autoEdit={fresh === m.value}
              onEditEnd={() => setFresh(undefined)}
              onCommit={(v) => dispatch({ op: "type.enum.renameMember", typeId: decl.id, value: m.value, newValue: v })}
            />
            <InlineText
              allowEmpty
              className="bf-field-row__label"
              value={m.label ?? ""}
              placeholder="label (optional)"
              label={`Label of ${m.value}`}
              onCommit={(l) => dispatch({ op: "type.enum.setMemberLabel", typeId: decl.id, value: m.value, label: l === "" ? null : l })}
            />
            <span className="bf-field-row__end">
              <button type="button" className="bf-icon-btn bf-icon-btn--danger" aria-label={`Remove value ${m.value}`} title="Remove value" onClick={() => dispatch({ op: "type.enum.removeMember", typeId: decl.id, value: m.value })}>
                ×
              </button>
            </span>
          </div>
        </div>
      ))}
      <AddRow label={`Add value to ${decl.name}`} onAdd={add}>
        value
      </AddRow>
    </div>
  );
}
