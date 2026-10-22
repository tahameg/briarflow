/**
 * Type picker: a shorthand text input (`list<Character?>`) with instant parse feedback and a
 * datalist of known names. Commits the shorthand string (commands accept shorthand).
 */
import { useEffect, useId, useMemo, useState } from "react";
import { PRIMITIVE_NAMES, formatType, parseType } from "@briarflow/core";
import type { TypeRef, TypeScope } from "@briarflow/core";

/** Props of {@link TypeInput}. */
export interface TypeInputProps {
  type: TypeRef | undefined;
  scope: TypeScope | undefined;
  /** Receives the shorthand text once it parses. */
  onCommit: (shorthand: string) => void;
  label: string;
  /** Names offered in the suggestion list (struct/enum names in scope). */
  names?: readonly string[];
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
}

/**
 * @example
 * ```tsx
 * <TypeInput type={field.type} scope={scope} label="Type of name" onCommit={(t) => dispatch({ op: "type.field.setType", typeId, field: "name", type: t })} />
 * ```
 */
export function TypeInput({ type, scope, onCommit, label, names = [], disabled, placeholder }: TypeInputProps) {
  const text = type ? formatType(type, scope) : "";
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | undefined>(undefined);
  const listId = useId();
  useEffect(() => {
    setDraft(text);
    setError(undefined);
  }, [text]);
  const suggestions = useMemo(() => [...PRIMITIVE_NAMES, ...names, ...PRIMITIVE_NAMES.map((p) => `list<${p}>`), ...names.map((n) => `${n}?`)], [names]);
  const commit = () => {
    const s = draft.trim();
    if (s === text) return setError(undefined);
    if (s === "") return setDraft(text);
    const r = parseType(s, scope ? { scope } : {});
    if (!r.ok) {
      setError(r.diagnostic.message);
      return;
    }
    setError(undefined);
    onCommit(s);
  };
  return (
    <span className="bf-type-input">
      <input
        className={error ? "bf-input bf-input--invalid bf-code" : "bf-input bf-code"}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        list={listId}
        value={draft}
        disabled={disabled}
        placeholder={placeholder ?? "text, int, list<Name>, Name?"}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(text);
            setError(undefined);
          }
        }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {error ? (
        <span className="bf-field__error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
