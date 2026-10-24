/**
 * Constant-value widgets by type (design-system.md §7 "Constant value widgets"): text,
 * textarea, password, number, checkbox, enum select, optional "set" box, media chip/upload,
 * JSON editor for json, structs and lists (on a node it opens from a preview button).
 */
import { useEffect, useId, useState } from "react";
import type { KeyboardEvent } from "react";
import type { MediaRef, TypeRef, TypeScope } from "@briarflow/core";
import { formatBytes, initialValue, isMediaRef, jsonErrorLocation, mediaHref, previewValue, widgetKind } from "../values.js";
import { SecretPicker } from "./Vault.js";

/** Props of {@link ValueEditor}. */
export interface ValueEditorProps {
  type: TypeRef;
  /** Current value (`undefined` = none stored). */
  value: unknown;
  /** Called with the new value when the user commits (blur / Enter / change for toggles). */
  onCommit: (value: unknown) => void;
  /** Called when the user clears a stored value (×). Hidden when absent. */
  onClear?: (() => void) | undefined;
  scope?: TypeScope | undefined;
  /** Port widget hint (`textarea`, `password`, `slider`, `color`). */
  widget?: string | undefined;
  /** Accessible label of the control. */
  label: string;
  /** Inline on a node: smaller; structured values show a preview that opens the JSON editor. */
  compact?: boolean;
  /** Placeholder for an empty value (e.g. the port default). */
  placeholder?: string | undefined;
  disabled?: boolean;
  invalid?: boolean;
  mediaUrl?: ((mediaId: string) => string) | undefined;
  uploadMedia?: ((file: File) => Promise<MediaRef>) | undefined;
}

const stop = (e: KeyboardEvent) => e.stopPropagation();

/**
 * Edits a value of `type`.
 *
 * @example
 * ```tsx
 * <ValueEditor type={{ kind: "primitive", name: "text" }} value="Aria" label="name" onCommit={(v) => …} />
 * ```
 */
export function ValueEditor(props: ValueEditorProps) {
  // An optional secret needs no "set" box: picking nothing is no secret.
  if (props.type.kind === "optional" && widgetKind(props.type.of, props.scope) === "secret") return <SecretValue {...props} type={props.type.of} />;
  const kind = widgetKind(props.type, props.scope);
  const cls = (base: string) => [base, props.compact ? "bf-input--compact" : "", props.invalid ? "bf-input--invalid" : "", "nodrag"].filter(Boolean).join(" ");
  switch (kind) {
    case "text":
      return <TextValue {...props} cls={cls} />;
    case "int":
    case "float":
      return <NumberValue {...props} int={kind === "int"} cls={cls} />;
    case "boolean":
      return (
        <input
          type="checkbox"
          className="bf-check__box nodrag"
          aria-label={props.label}
          checked={props.value === true}
          disabled={props.disabled}
          onChange={(e) => props.onCommit(e.target.checked)}
        />
      );
    case "enum": {
      const t = props.type;
      const decl = t.kind === "named" ? props.scope?.getType(t.id)?.decl : undefined;
      const members = decl?.kind === "enum" ? decl.members : [];
      const current = typeof props.value === "string" ? props.value : "";
      return (
        <select
          className={cls("bf-input bf-input--select")}
          aria-label={props.label}
          value={current}
          disabled={props.disabled}
          onChange={(e) => props.onCommit(e.target.value)}
          onKeyDown={stop}
        >
          {current === "" ? <option value="">{props.placeholder ?? "—"}</option> : null}
          {members.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label ?? m.value}
            </option>
          ))}
        </select>
      );
    }
    case "optional":
      return <OptionalValue {...props} />;
    case "media":
      return <MediaValue {...props} />;
    case "unbound":
      return <span className="bf-value-note">connect first</span>;
    case "secret":
      return <SecretValue {...props} />;
    case "json":
    case "struct":
    case "list":
    case "unknown":
      if (props.compact) return <CompactJson {...props} cls={cls} />;
      return <JsonValue {...props} cls={cls} />;
  }
}

function SecretValue(props: ValueEditorProps) {
  const t = props.type;
  const kind = t.kind === "primitive" && t.name === "secret" ? t.constraints?.kind : undefined;
  return (
    <SecretPicker
      value={typeof props.value === "string" ? props.value : undefined}
      kind={kind}
      label={props.label}
      compact={props.compact === true}
      disabled={props.disabled === true}
      onChange={(name) => (name !== undefined ? props.onCommit(name) : props.onClear ? props.onClear() : props.onCommit(null))}
    />
  );
}

function TextValue(props: ValueEditorProps & { cls: (base: string) => string }) {
  const { type, value, onCommit, widget, label, disabled, placeholder, cls } = props;
  const text = typeof value === "string" ? value : "";
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const multiline = widget === "textarea" || (type.kind === "primitive" && type.name === "text" && type.constraints?.multiline === true);
  const commit = () => {
    if (draft !== text || value === undefined) onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        className={cls("bf-input bf-input--textarea nowheel")}
        aria-label={label}
        rows={props.compact ? 2 : 3}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={stop}
      />
    );
  }
  return (
    <input
      className={cls("bf-input")}
      type={widget === "password" ? "password" : "text"}
      aria-label={label}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(text);
      }}
    />
  );
}

function NumberValue(props: ValueEditorProps & { int: boolean; cls: (base: string) => string }) {
  const { type, value, onCommit, label, disabled, placeholder, int, cls } = props;
  const text = typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const c = type.kind === "primitive" && (type.name === "int" || type.name === "float") ? type.constraints : undefined;
  const commit = () => {
    if (draft.trim() === "") return setDraft(text);
    let n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(text);
    if (int) n = Math.round(n);
    if (c?.min !== undefined) n = Math.max(c.min, n);
    if (c?.max !== undefined) n = Math.min(c.max, n);
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };
  const step = (d: number) => {
    let n = (typeof value === "number" ? value : 0) + d;
    if (c?.min !== undefined) n = Math.max(c.min, n);
    if (c?.max !== undefined) n = Math.min(c.max, n);
    onCommit(n);
  };
  return (
    <span className="bf-number">
      <input
        className={cls("bf-input")}
        type="number"
        inputMode={int ? "numeric" : "decimal"}
        step={int ? 1 : 0.1}
        min={c?.min}
        max={c?.max}
        aria-label={label}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
        }}
      />
      {int && !props.compact ? (
        <>
          <button type="button" className="bf-stepper nodrag" aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => step(-1)}>
            −
          </button>
          <button type="button" className="bf-stepper nodrag" aria-label={`Increase ${label}`} disabled={disabled} onClick={() => step(1)}>
            +
          </button>
        </>
      ) : null}
    </span>
  );
}

function OptionalValue(props: ValueEditorProps) {
  const inner = props.type.kind === "optional" ? props.type.of : props.type;
  const isSet = props.value !== null && props.value !== undefined;
  const id = useId();
  return (
    <span className="bf-optional">
      <input
        id={id}
        type="checkbox"
        className="bf-check__box nodrag"
        aria-label={`Set ${props.label}`}
        title="set"
        checked={isSet}
        disabled={props.disabled}
        onChange={(e) => props.onCommit(e.target.checked ? initialValue(inner, props.scope) : null)}
      />
      {isSet ? <ValueEditor {...props} type={inner} /> : <span className="bf-value-note">none</span>}
    </span>
  );
}

function MediaValue(props: ValueEditorProps) {
  const { value, onCommit, onClear, label, disabled, mediaUrl, uploadMedia, compact } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const ref = isMediaRef(value) ? value : undefined;
  const href = ref ? mediaHref(ref, mediaUrl) : undefined;
  return (
    <span className="bf-media">
      {ref ? (
        <span className="bf-media__chip" title={ref.uri}>
          {href && ref.mime.startsWith("image/") && !compact ? <img className="bf-media__thumb" src={href} alt={ref.meta?.filename ?? label} /> : null}
          <span className="bf-code">
            {ref.meta?.filename ?? ref.mime} {ref.bytes !== undefined ? `· ${formatBytes(ref.bytes)}` : ""}
          </span>
        </span>
      ) : (
        <span className="bf-value-note">{compact ? "media" : "no file"}</span>
      )}
      {uploadMedia ? (
        <label className="bf-button bf-button--secondary bf-button--sm bf-media__pick nodrag" title={compact ? "Upload a file" : undefined}>
          {busy ? (compact ? "…" : "Uploading…") : compact ? "↑" : "Choose file"}
          <input
            type="file"
            className="bf-visually-hidden"
            aria-label={`Upload ${label}`}
            disabled={disabled || busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              setError(undefined);
              try {
                onCommit(await uploadMedia(file));
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      ) : null}
      {ref && onClear && !compact ? (
        <button type="button" className="bf-button bf-button--ghost bf-button--sm bf-row-x" aria-label={`Clear ${label}`} onClick={onClear}>
          ×
        </button>
      ) : null}
      {error ? <span className="bf-field__error">{error}</span> : null}
    </span>
  );
}

/** On a node: a preview button that opens the JSON editor under it. */
function CompactJson(props: ValueEditorProps & { cls: (base: string) => string }) {
  const [open, setOpen] = useState(false);
  const kind = widgetKind(props.type, props.scope);
  const preview =
    props.value === undefined
      ? (props.placeholder ?? "—")
      : kind === "list" && Array.isArray(props.value)
        ? `${props.value.length} items`
        : previewValue(props.value, 24);
  return (
    <span className="bf-json-compact nodrag">
      <button
        type="button"
        className="bf-value-note bf-code bf-json-compact__toggle"
        aria-expanded={open}
        aria-label={`Edit ${props.label} as JSON`}
        disabled={props.disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾ " : "▸ "}
        {preview}
      </button>
      {open ? <JsonValue {...props} compact={false} cls={(base) => props.cls(base).replace("bf-input--compact", "")} /> : null}
    </span>
  );
}

/**
 * json, structs and lists: a JSON textarea with a live syntax check. Empty values start from a skeleton of the type (not
 * stored until edited); valid JSON is pretty-printed on blur; parse errors name line and column.
 */
function JsonValue(props: ValueEditorProps & { cls: (base: string) => string }) {
  const { value, onCommit, label, disabled, cls, placeholder, type, scope } = props;
  const kind = widgetKind(type, scope);
  const skeleton = kind === "unknown" ? "" : JSON.stringify(initialValue(type, scope), null, 2);
  const text = value === undefined ? skeleton : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    setDraft(text);
    setError(undefined);
  }, [text]);
  const commit = () => {
    if (draft.trim() === "" || draft === text) return;
    try {
      const parsed: unknown = JSON.parse(draft);
      setError(undefined);
      setDraft(JSON.stringify(parsed, null, 2));
      onCommit(parsed);
    } catch {
      const where = jsonErrorLocation(draft);
      setError(`Not valid JSON${where ? ` (${where})` : ""}. Use double quotes for keys and strings.`);
    }
  };
  const rows = Math.min(10, Math.max(3, draft.split("\n").length));
  return (
    <span className="bf-json">
      <textarea
        className={cls("bf-input bf-input--textarea bf-code nowheel")}
        aria-label={`${label} (JSON)`}
        aria-invalid={error ? true : undefined}
        rows={rows}
        value={draft}
        disabled={disabled}
        placeholder={placeholder ?? "JSON"}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(syntaxError(e.target.value));
        }}
        onBlur={commit}
        onKeyDown={stop}
        spellCheck={false}
      />
      {error ? (
        <span className="bf-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Live check while typing: the parse error with line and column, or undefined. */
function syntaxError(draft: string): string | undefined {
  if (draft.trim() === "") return undefined;
  try {
    JSON.parse(draft);
    return undefined;
  } catch {
    const where = jsonErrorLocation(draft);
    return `Not valid JSON${where ? ` (${where})` : ""}. Use double quotes for keys and strings.`;
  }
}
