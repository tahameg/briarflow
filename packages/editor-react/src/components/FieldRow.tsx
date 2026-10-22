/**
 * `<FieldRow>`: one named, typed entry (variable, global, flow input / output, struct field):
 * click the name to rename, click the type chip to retype, `[ ]` for a list, `⋯` for details
 * such as defaults and access, `×` to remove. Right-click: rename, list toggle, the caller's
 * `menuItems`, remove (plus whatever contributors add for `menuTarget`).
 */
import { useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { TypeRef, TypeScope } from "@briarflow/core";
import { toggleArray, typeShape } from "../fields.js";
import type { ContextMenuItem, ContextMenuTarget } from "../menu.js";
import { useContextMenu } from "./ContextMenu.js";
import { isTypingTarget } from "./selection.js";
import { TypePicker } from "./TypePicker.js";
import { EditableName } from "./ui.js";

/** Props of {@link FieldRow}. */
export interface FieldRowProps {
  name: string;
  /** What the row is, for labels ("variable", "global", "input", "field"). */
  kind: string;
  type: TypeRef;
  scope: TypeScope | undefined;
  onRename: (name: string) => void;
  onSetType: (shorthand: string) => void;
  onRemove?: () => void;
  /** Open the name for editing (a row a "+" just created). */
  autoEdit?: boolean;
  onEditEnd?: () => void;
  /** Shown under the row behind the `⋯` toggle. */
  details?: ReactNode;
  /** Before the name (e.g. a drag grip). */
  lead?: ReactNode;
  /** Extra buttons before `⋯` and `×`. */
  trail?: ReactNode;
  /** Right-click target (default: `{ kind: "field", fieldKind: kind, name }`). */
  menuTarget?: ContextMenuTarget;
  /** Extra right-click entries. */
  menuItems?: readonly ContextMenuItem[];
}

/**
 * @example
 * ```tsx
 * <FieldRow kind="variable" name={v.name} type={v.type} scope={scope} onRename={rename} onSetType={retype} onRemove={remove} />
 * ```
 */
export function FieldRow({ name, kind, type, scope, onRename, onSetType, onRemove, autoEdit, onEditEnd, details, lead, trail, menuTarget, menuItems }: FieldRowProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const menu = useContextMenu();
  const array = typeShape(type).array;
  const onContextMenu = (e: ReactMouseEvent) => {
    if (isTypingTarget(e.target)) return;
    const items: ContextMenuItem[] = [
      { id: "rename", label: "Rename", order: 200, run: () => setRenaming(true) },
      { id: "list", label: array ? "Make single value" : "Make list", order: 200, run: () => onSetType(toggleArray(type, scope)) },
      ...(details ? [{ id: "details", label: open ? "Hide details" : "Details", order: 300, run: () => setOpen((o) => !o) }] : []),
      ...(menuItems ?? []),
      ...(onRemove ? [{ id: "remove", label: `Remove ${kind}`, order: 900, danger: true, run: onRemove }] : []),
    ];
    menu.open(e, menuTarget ?? { kind: "field", fieldKind: kind, name }, items);
  };
  return (
    <div className={open ? "bf-field-row bf-field-row--open" : "bf-field-row"}>
      <div className="bf-field-row__main" onContextMenu={onContextMenu}>
        {lead}
        <EditableName
          className="bf-field-row__name"
          value={name}
          label={`Name of ${kind} ${name}`}
          autoEdit={(autoEdit ?? false) || renaming}
          onEditEnd={() => {
            setRenaming(false);
            onEditEnd?.();
          }}
          onCommit={onRename}
        />
        <TypePicker type={type} scope={scope} label={`Type of ${kind} ${name}`} onCommit={onSetType} />
        <span className="bf-field-row__end">
          {trail}
          {details ? (
            <button
              type="button"
              className="bf-icon-btn"
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} details of ${kind} ${name}`}
              title={open ? "Hide details" : "Details"}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? "▴" : "⋯"}
            </button>
          ) : null}
          {onRemove ? (
            <button type="button" className="bf-icon-btn bf-icon-btn--danger" aria-label={`Remove ${kind} ${name}`} title={`Remove ${kind}`} onClick={onRemove}>
              ×
            </button>
          ) : null}
        </span>
      </div>
      {open && details ? <div className="bf-field-row__details">{details}</div> : null}
    </div>
  );
}
