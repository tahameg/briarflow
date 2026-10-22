/**
 * Top-bar switchers for the open context and flow: a dropdown, a "+" that turns into a name
 * field, and a right-click menu (rename, delete, extras) on the dropdown.
 */
import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Button, useContextMenu } from "@briarflow/editor-react";
import type { ContextMenuItem } from "@briarflow/editor-react";

declare module "@briarflow/editor-react" {
  interface ContextMenuTargets {
    /** The context switcher. */
    context: { contextId: string };
    /** The flow switcher. */
    flow: { flowId: string };
  }
}

/** Props of {@link Switcher}. */
export interface SwitcherProps {
  kind: "context" | "flow";
  items: readonly { id: string; name: string }[];
  value: string | undefined;
  onSelect: (id: string) => void;
  /** Creates an item; resolve `false` or throw to keep the name field open. */
  onCreate: (name: string) => unknown;
  onRename: (id: string, name: string) => unknown;
  /** Asks to delete (the caller confirms). */
  onDelete: (id: string) => void;
  /** More right-click entries for the selected item. */
  extraItems?: (id: string) => ContextMenuItem[];
}

type Editing = { mode: "create" } | { mode: "rename"; id: string; name: string };

/**
 * Dropdown + "+" for one kind of item. With no items it shows only an "Add …" button.
 *
 * @example
 * ```tsx
 * <Switcher kind="flow" items={flows} value={activeId} onSelect={open} onCreate={create} onRename={rename} onDelete={ask} />
 * ```
 */
export function Switcher({ kind, items, value, onSelect, onCreate, onRename, onDelete, extraItems }: SwitcherProps) {
  const menu = useContextMenu();
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const start = (next: Editing) => {
    setDraft(next.mode === "rename" ? next.name : "");
    setError(undefined);
    setEditing(next);
  };
  const commit = async () => {
    const name = draft.trim();
    const current = editing;
    if (!current) return;
    if (!name || (current.mode === "rename" && name === current.name)) {
      setEditing(undefined);
      return;
    }
    try {
      const ok = current.mode === "create" ? await onCreate(name) : await onRename(current.id, name);
      if (ok === false) return;
      setEditing(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return (
      <span className="bf-switcher">
        <input
          className={error ? "bf-input bf-input--invalid bf-switcher__name" : "bf-input bf-switcher__name"}
          aria-label={editing.mode === "create" ? `New ${kind} name` : `New name of ${kind} ${editing.name}`}
          aria-invalid={error ? true : undefined}
          title={error ?? "Enter saves, Esc cancels"}
          placeholder={`New ${kind} name`}
          value={draft}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
          onBlur={() => (editing.mode === "rename" ? void commit() : setEditing(undefined))}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setEditing(undefined);
          }}
        />
        {error ? <span className="bf-switcher__error" role="alert">{error}</span> : null}
      </span>
    );
  }

  if (items.length === 0) {
    return (
      <Button size="sm" variant={kind === "context" ? "primary" : "secondary"} onClick={() => start({ mode: "create" })}>
        + Add {kind}
      </Button>
    );
  }

  const selected = items.find((i) => i.id === value);
  const openMenu = (e: ReactMouseEvent) => {
    if (!selected) return;
    const entries: ContextMenuItem[] = [
      { id: "new", label: `New ${kind}`, order: 100, run: () => start({ mode: "create" }) },
      { id: "rename", label: "Rename", order: 200, run: () => start({ mode: "rename", id: selected.id, name: selected.name }) },
      ...(extraItems?.(selected.id) ?? []),
      { id: "delete", label: `Delete ${kind}`, order: 900, danger: true, run: () => onDelete(selected.id) },
    ];
    menu.open(e, kind === "context" ? { kind: "context", contextId: selected.id } : { kind: "flow", flowId: selected.id }, entries);
  };
  return (
    <span className="bf-switcher" onContextMenu={openMenu}>
      <label className="bf-visually-hidden" htmlFor={`bf-${kind}-switch`}>
        {kind === "context" ? "Context" : "Flow"}
      </label>
      <select
        id={`bf-${kind}-switch`}
        className="bf-input bf-input--select bf-switcher__select"
        value={selected ? selected.id : ""}
        onChange={(e) => e.target.value && onSelect(e.target.value)}
        title={`Switch ${kind} (right-click to rename or delete)`}
      >
        {!selected ? <option value="">— pick a {kind} —</option> : null}
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
      <button type="button" className="bf-button bf-button--sm bf-switcher__add" aria-label={`New ${kind}`} title={`New ${kind}`} onClick={() => start({ mode: "create" })}>
        +
      </button>
    </span>
  );
}
