/**
 * Component kit of the Briar Brutal design system (design-system.md §9–§10): buttons, panels,
 * tabs, fields, badges, port markers, type chips, status dots. Styles: `styles/components.css`.
 */
import { useEffect, useId, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { formatType } from "@briarflow/core";
import type { TypeRef, TypeScope } from "@briarflow/core";
import { typeStyle } from "../theme.js";
import type { BriarToken, TypeStyle } from "../theme.js";
import { kindLookup } from "../graph.js";

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---- Button ---------------------------------------------------------------------------------

/** Props of {@link Button}. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` = yellow (one per area), `secondary` = surface, `danger` = destructive, `ghost` = toolbar. */
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  /** Icon before the label (16 px). */
  icon?: ReactNode;
}

/**
 * Brutalist button: square, 2px border, hard shadow, press moves it 2px.
 *
 * @example
 * ```tsx
 * <Button variant="primary">Run</Button>
 * ```
 */
export function Button({ variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx("bf-button", `bf-button--${variant}`, `bf-button--${size}`, icon && !children ? "bf-button--icon" : "", className)} {...rest}>
      {icon ? (
        <span className="bf-button__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

// ---- Panel ----------------------------------------------------------------------------------

/** Props of {@link Panel}. */
export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  /** Shows the 3px yellow underline under the title bar. */
  active?: boolean;
  actions?: ReactNode;
  /** No inner padding (lists, canvases). */
  flush?: boolean;
}

/**
 * Panel: surface, 3px ink border, 36px title bar with an uppercase display title.
 *
 * @example
 * ```tsx
 * <Panel title="Contexts" actions={<Button size="sm">+</Button>}>…</Panel>
 * ```
 */
export function Panel({ title, active = false, actions, flush = false, className, children, ...rest }: PanelProps) {
  return (
    <section className={cx("bf-panel", active && "bf-panel--active", className)} {...rest}>
      <header className="bf-panel__bar">
        <h2 className="bf-panel__title">{title}</h2>
        {actions ? <div className="bf-panel__actions">{actions}</div> : null}
      </header>
      <div className={flush ? "bf-panel__body bf-panel__body--flush" : "bf-panel__body"}>{children}</div>
    </section>
  );
}

/** A small uppercase section heading with optional actions. */
export function SectionHead({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="bf-section-head">
      <h3 className="bf-section-head__title">{title}</h3>
      {actions ? <div className="bf-section-head__actions">{actions}</div> : null}
    </div>
  );
}

// ---- Tabs -----------------------------------------------------------------------------------

/** One tab. */
export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

/**
 * Tab strip (WAI-ARIA tabs: arrow keys move between tabs). Pair each panel with
 * `id={tabPanelId(idBase, key)}` and `aria-labelledby={tabId(idBase, key)}`.
 *
 * @example
 * ```tsx
 * <Tabs idBase="dock" items={[{ key: "run", label: "Run" }]} active={tab} onChange={setTab} label="Dock" />
 * ```
 */
export function Tabs<K extends string>({ idBase, items, active, onChange, label }: { idBase: string; items: readonly TabItem<K>[]; active: K; onChange: (key: K) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((i) => i.key === active);
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    onChange(items[next]!.key);
    refs.current[next]?.focus();
  };
  return (
    <div className="bf-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, item.key)}
            aria-selected={selected}
            aria-controls={tabPanelId(idBase, item.key)}
            tabIndex={selected ? 0 : -1}
            className={selected ? "bf-tab bf-tab--active" : "bf-tab"}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** Id of a tab button. */
export function tabId(idBase: string, key: string): string {
  return `${idBase}-tab-${key}`;
}

/** Id of a tab panel. */
export function tabPanelId(idBase: string, key: string): string {
  return `${idBase}-panel-${key}`;
}

// ---- Fields ---------------------------------------------------------------------------------

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  hideLabel?: boolean | undefined;
}

function FieldShell({ id, label, hint, error, hideLabel, children }: FieldShellProps & { id: string; children: ReactNode }) {
  return (
    <div className={error ? "bf-field bf-field--error" : "bf-field"}>
      <label htmlFor={id} className={hideLabel ? "bf-visually-hidden" : "bf-field__label"}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="bf-field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="bf-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, props: FieldShellProps): string | undefined {
  if (props.error) return `${id}-error`;
  if (props.hint) return `${id}-hint`;
  return undefined;
}

/** Single-line text input with label (32px, surface-2, 2px ink-muted border). */
export function TextField({ label, hint, error, hideLabel, className, ...rest }: FieldShellProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const shell = { label, hint, error, hideLabel };
  return (
    <FieldShell id={id} {...shell}>
      <input id={id} className={cx("bf-input", className)} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, shell)} {...rest} />
    </FieldShell>
  );
}

/** Multi-line text (3 rows, grows). */
export function TextAreaField({ label, hint, error, hideLabel, className, rows = 3, ...rest }: FieldShellProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const shell = { label, hint, error, hideLabel };
  return (
    <FieldShell id={id} {...shell}>
      <textarea id={id} rows={rows} className={cx("bf-input", "bf-input--textarea", className)} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, shell)} {...rest} />
    </FieldShell>
  );
}

/** Select with label. */
export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  options,
  className,
  ...rest
}: FieldShellProps & SelectHTMLAttributes<HTMLSelectElement> & { options: readonly { value: string; label: string }[] }) {
  const id = useId();
  const shell = { label, hint, error, hideLabel };
  return (
    <FieldShell id={id} {...shell}>
      <select id={id} className={cx("bf-input", "bf-input--select", className)} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, shell)} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

/** Square 16px checkbox with a yellow check. */
export function CheckboxField({ label, className, ...rest }: { label: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const id = useId();
  return (
    <div className="bf-check">
      <input id={id} type="checkbox" className={cx("bf-check__box", className)} {...rest} />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/**
 * Two-option toggle (`readonly | readwrite`, `public | private`), rendered as a radio group of
 * square buttons.
 */
export function Toggle<V extends string>({ value, options, onChange, label, disabled }: { value: V; options: readonly V[]; onChange: (v: V) => void; label: string; disabled?: boolean }) {
  return (
    <div className="bf-toggle" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          disabled={disabled}
          className={o === value ? "bf-toggle__opt bf-toggle__opt--on" : "bf-toggle__opt"}
          onClick={() => o !== value && onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// ---- Badges, ports, types, status -----------------------------------------------------------

/** Pastel / status tones; text on them is always ink-inverse. */
export type Tone = Extract<BriarToken, "yellow" | "mint" | "lavender" | "peach" | "sky" | "pink" | "lime" | "aqua" | "sand" | "coral" | "stone" | "danger">;

/**
 * Small pastel label in code font (`CACHED`, `0.8s`, `retry 2/3`).
 *
 * @example
 * ```tsx
 * <Badge tone="lavender">CACHED</Badge>
 * ```
 */
export function Badge({ tone = "stone", children, title }: { tone?: Tone; children: ReactNode; title?: string | undefined }) {
  return (
    <span className="bf-badge" style={{ "--bf-badge-bg": `var(--bf-${tone})` } as CSSProperties} title={title}>
      {children}
    </span>
  );
}

/** CSS classes of a port marker for a type style (shared with canvas handles). */
export function portClasses(style: TypeStyle): string {
  return cx("bf-port", style.shape === "diamond" && "bf-port--diamond", style.hollow && "bf-port--hollow", style.optional && "bf-port--optional", style.unbound && "bf-port--unbound");
}

/** Port marker in the color and shape of a type (§6). */
export function PortMarker({ style }: { style: TypeStyle }) {
  return <span className={portClasses(style)} style={{ "--bf-port-color": style.color } as CSSProperties} aria-hidden="true" />;
}

/**
 * Type chip: port marker + the type shorthand in code font, colored by kind. The name is always
 * shown (color is never the only cue).
 *
 * @example
 * ```tsx
 * <TypeChip type={{ kind: "list", of: { kind: "primitive", name: "text" } }} />
 * ```
 */
export function TypeChip({ type, scope }: { type: TypeRef; scope?: TypeScope | undefined }) {
  const style = typeStyle(type, scope ? kindLookup(scope) : undefined);
  return (
    <span className="bf-type-chip" style={{ "--bf-chip-color": style.color } as CSSProperties}>
      <PortMarker style={style} />
      <span className="bf-type-chip__name">{formatType(type, scope)}</span>
    </span>
  );
}

/** Dot state of a node or run. */
export type DotState = "queued" | "running" | "done" | "cached" | "error" | "skipped" | "warning";

/** 10px square status dot (§9), with an accessible label. */
export function StatusDot({ state, label }: { state: DotState; label?: string }) {
  return <span className={`bf-status-dot bf-status-dot--${state}`} role="img" aria-label={label ?? state} title={label ?? state} />;
}

// ---- Inline text ----------------------------------------------------------------------------

/**
 * Text input that commits on blur / Enter (Escape reverts). Use for renames so each edit is one
 * command and one undo step.
 *
 * @example
 * ```tsx
 * <InlineText value={type.name} label="Type name" onCommit={(name) => dispatch({ op: "type.rename", typeId, name })} />
 * ```
 */
export function InlineText({
  value,
  onCommit,
  label,
  className,
  placeholder,
  disabled,
  allowEmpty = false,
  code = false,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Commit "" (e.g. to clear a description); otherwise empty input reverts. */
  allowEmpty?: boolean;
  /** Code font (names, ids). */
  code?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next === value) return;
    if (next === "" && !allowEmpty) return setDraft(value);
    onCommit(next);
  };
  return (
    <input
      className={cx("bf-input", "bf-input--inline", code && "bf-code", className)}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

/**
 * A name shown as text; click it to rename in place (Enter / blur saves, Escape cancels).
 * `autoEdit` opens it in edit mode with the text selected, for rows a "+" just created.
 *
 * @example
 * ```tsx
 * <EditableName value={v.name} label="Name of variable count" onCommit={(name) => dispatch({ op: "flow.variable.rename", flowId, variableId, name })} />
 * ```
 */
export function EditableName({
  value,
  onCommit,
  label,
  autoEdit = false,
  onEditEnd,
  className,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  autoEdit?: boolean;
  /** Called when edit mode closes (saved or cancelled). */
  onEditEnd?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  useEffect(() => {
    if (autoEdit) {
      done.current = false;
      setDraft(value);
      setEditing(true);
    }
    // Only reacts to autoEdit turning on.
  }, [autoEdit]);
  if (editing) {
    const finish = (save: boolean) => {
      if (done.current) return;
      done.current = true;
      setEditing(false);
      const next = draft.trim();
      if (save && next && next !== value) onCommit(next);
      onEditEnd?.();
    };
    return (
      <input
        className={cx("bf-input", "bf-input--name", "bf-code", "nodrag", "nopan", className)}
        aria-label={label}
        value={draft}
        autoFocus
        spellCheck={false}
        size={Math.max(4, draft.length + 1)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={cx("bf-name", "bf-code", "nodrag", className)}
      aria-label={`${label}: ${value}. Rename`}
      title="Click to rename"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        done.current = false;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </button>
  );
}

/**
 * Full-width "+" row at the end of a list: adds an item with a generated name; the new row
 * then opens its name for editing.
 *
 * @example
 * ```tsx
 * <AddRow label="Add variable" onAdd={addVariable}>variable</AddRow>
 * ```
 */
export function AddRow({ label, onAdd, children, className, disabled }: { label: string; onAdd: () => void; children?: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={cx("bf-add-row", "nodrag", className)}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      <span aria-hidden="true">+</span>
      {children ? <span>{children}</span> : null}
    </button>
  );
}

/** Empty-state block: big uppercase display headline + muted text. */
export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="bf-empty">
      <p className="bf-empty__title">{title}</p>
      {children ? <div className="bf-empty__body">{children}</div> : null}
    </div>
  );
}

// ---- Modal ----------------------------------------------------------------------------------

/** Props of {@link Modal}. */
export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra buttons in the title bar, before the close button. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Large modal panel (`<dialog>`, Esc or × closes). Content renders only while open.
 *
 * @example
 * ```tsx
 * <Modal open={open} title="Globals" onClose={() => setOpen(false)}><GlobalsPanel /></Modal>
 * ```
 */
export function Modal({ open, title, onClose, children, actions, className }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={cx("bf-modal", className)}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog element itself, outside its box) closes.
        if (e.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      {open ? (
        <div className="bf-modal__frame">
          <header className="bf-modal__bar">
            <h2 id={titleId} className="bf-modal__title">
              {title}
            </h2>
            <div className="bf-modal__actions">
              {actions}
              <Button size="sm" variant="ghost" aria-label="Close" title="Close (Esc)" onClick={onClose}>
                ×
              </Button>
            </div>
          </header>
          <div className="bf-modal__body">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}

// ---- ConfirmDialog --------------------------------------------------------------------------

/** Props of {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Open while true (modal `<dialog>`, focus trapped, Esc cancels). */
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  /** Label of the confirm button (filled danger). Default "Delete". */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirmation for destructive actions (design-system §10: filled danger on confirm).
 *
 * @example
 * ```tsx
 * <ConfirmDialog open={asking} title="Delete flow Portrait?" onConfirm={del} onCancel={() => setAsking(false)}>
 *   This cannot be undone.
 * </ConfirmDialog>
 * ```
 */
export function ConfirmDialog({ open, title, children, confirmLabel = "Delete", onConfirm, onCancel }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="bf-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      {open ? (
        <form
          method="dialog"
          className="bf-dialog__body"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <h2 id={titleId} className="bf-dialog__title">
            {title}
          </h2>
          {children ? <div className="bf-dialog__text">{children}</div> : null}
          <div className="bf-dialog__actions">
            <Button variant="secondary" onClick={onCancel} autoFocus>
              Cancel
            </Button>
            <Button type="submit" variant="danger" className="bf-button--filled">
              {confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
