/**
 * `<TypePicker>`: a clickable type chip. Click opens a menu of every primitive and every
 * struct / enum in scope, with list and optional switches; the `[ ]` button next to the chip
 * turns the type into a list (and back) in one click. Commits shorthand strings.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { PRIMITIVE_NAMES, formatType, parseType } from "@briarflow/core";
import type { TypeRef, TypeScope } from "@briarflow/core";
import { kindLookup } from "../graph.js";
import { shapeShorthand, toggleArray, typeShape } from "../fields.js";
import type { TypeShape } from "../fields.js";
import { typeStyle } from "../theme.js";
import { PortMarker } from "./ui.js";

/** Props of {@link TypePicker}. */
export interface TypePickerProps {
  type: TypeRef | undefined;
  scope: TypeScope | undefined;
  /** Receives the new type as shorthand (`list<Character?>`). */
  onCommit: (shorthand: string) => void;
  /** Accessible name of the field whose type this is ("Type of input prompt"). */
  label: string;
  disabled?: boolean | undefined;
  /** Show the one-click `[ ]` list toggle (default true). */
  arrayToggle?: boolean;
  /** Smaller chip for canvas nodes. */
  compact?: boolean;
}

interface MenuItem {
  key: string;
  group: "Primitives" | "Structs" | "Enums" | "Custom";
  label: string;
  /** Base type picked by this item. */
  base: TypeRef | undefined;
  /** Shorthand committed as-is (custom entries). */
  raw?: string;
  hint?: string;
}

/**
 * @example
 * ```tsx
 * <TypePicker type={field.type} scope={scope} label="Type of name" onCommit={(t) => dispatch({ op: "type.field.setType", typeId, field: "name", type: t })} />
 * ```
 */
export function TypePicker({ type, scope, onCommit, label, disabled, arrayToggle = true, compact = false }: TypePickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const text = type ? formatType(type, scope) : "choose type";
  const style = type ? typeStyle(type, scope ? kindLookup(scope) : undefined) : undefined;
  const shape = type ? typeShape(type) : undefined;
  const commit = (s: string) => {
    if (type && s === formatType(type, scope)) return;
    onCommit(s);
  };
  return (
    <span className={compact ? "bf-type-picker bf-type-picker--compact nodrag nopan" : "bf-type-picker nodrag nopan"}>
      <button
        ref={anchor}
        type="button"
        className="bf-type-picker__chip"
        style={{ "--bf-chip-color": style?.color ?? "var(--bf-ink-muted)" } as CSSProperties}
        aria-label={`${label}: ${text}. Change type`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${text} — click to change`}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {style ? <PortMarker style={style} /> : null}
        <span className="bf-type-picker__name">{text}</span>
        <span className="bf-type-picker__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {arrayToggle && type ? (
        <button
          type="button"
          className={shape?.array ? "bf-type-picker__array bf-type-picker__array--on" : "bf-type-picker__array"}
          aria-pressed={shape?.array ?? false}
          aria-label={`${label}: list`}
          title={shape?.array ? "List — click for a single value" : "Single value — click to make it a list"}
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onCommit(toggleArray(type, scope));
          }}
        >
          [ ]
        </button>
      ) : null}
      {open && anchor.current ? <TypeMenu anchor={anchor.current} shape={shape} scope={scope} label={label} onCommit={commit} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

/** Where the menu is portaled: the open modal `<dialog>` (top layer) or the body. */
function portalTarget(anchor: HTMLElement): HTMLElement {
  return anchor.closest("dialog") ?? document.body;
}

function TypeMenu({
  anchor,
  shape,
  scope,
  label,
  onCommit,
  onClose,
}: {
  anchor: HTMLElement;
  shape: TypeShape | undefined;
  scope: TypeScope | undefined;
  label: string;
  onCommit: (shorthand: string) => void;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number }>(() => {
    const r = anchor.getBoundingClientRect();
    return { top: r.bottom + 4, left: r.left };
  });
  const wrappers = shape ?? { base: { kind: "primitive", name: "text" } as TypeRef, array: false, optional: false, itemOptional: false };
  const currentBase = shape ? formatType(shape.base, scope) : undefined;

  const items = useMemo<MenuItem[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => q === "" || s.toLowerCase().includes(q);
    const out: MenuItem[] = [];
    for (const p of PRIMITIVE_NAMES) if (match(p)) out.push({ key: `p:${p}`, group: "Primitives", label: p, base: { kind: "primitive", name: p } as TypeRef });
    for (const e of scope?.all() ?? []) {
      const ref: TypeRef = { kind: "named", id: e.decl.id };
      const name = formatType(ref, scope);
      if (!match(name)) continue;
      out.push({ key: `n:${e.decl.id}`, group: e.decl.kind === "struct" ? "Structs" : "Enums", label: name, base: ref, hint: e.origin });
    }
    const raw = query.trim();
    if (raw && !out.some((i) => i.label === raw) && parseType(raw, scope ? { scope } : {}).ok) {
      out.push({ key: `c:${raw}`, group: "Custom", label: raw, base: undefined, raw, hint: "use as typed" });
    }
    return out;
  }, [query, scope]);

  useEffect(() => setActive(0), [query]);

  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const m = el.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 4);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8));
    setPos((p) => (p.top === top && p.left === left ? p : { top, left }));
  }, [anchor, items.length]);

  useEffect(() => {
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    const onWheel = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("wheel", onWheel, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("wheel", onWheel, true);
    };
  }, [anchor, onClose]);

  const close = () => {
    onClose();
    anchor.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.raw !== undefined) onCommit(item.raw);
    else if (item.base) onCommit(shapeShorthand({ ...wrappers, base: item.base }, scope));
    close();
  };
  const setWrappers = (next: Partial<TypeShape>) => {
    if (!shape) return;
    const s = { ...shape, ...next };
    if (!s.array) s.itemOptional = false;
    onCommit(shapeShorthand(s, scope));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) pick(item);
    }
  };

  const lookup = scope ? kindLookup(scope) : undefined;
  let lastGroup: string | undefined;
  return createPortal(
    <div
      ref={menu}
      className="bf-type-menu nodrag nopan nowheel"
      role="dialog"
      aria-label={label}
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        className="bf-input bf-code bf-type-menu__search"
        aria-label="Search types"
        placeholder="search or type list<Name>…"
        value={query}
        autoFocus
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="bf-type-menu__list" role="listbox" aria-label="Types">
        {items.map((item, i) => {
          const head = item.group !== lastGroup ? item.group : undefined;
          lastGroup = item.group;
          const selected = item.base !== undefined && formatType(item.base, scope) === currentBase;
          const style = item.base ? typeStyle(item.base, lookup) : undefined;
          return (
            <li key={item.key} role="presentation">
              {head ? <div className="bf-type-menu__group">{head}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={["bf-type-menu__item", i === active && "bf-type-menu__item--active", selected && "bf-type-menu__item--current"].filter(Boolean).join(" ")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item)}
              >
                {style ? <PortMarker style={style} /> : <span className="bf-type-menu__blank" />}
                <span className="bf-code">{item.label}</span>
                {item.hint ? <span className="bf-type-menu__hint">{item.hint}</span> : null}
              </button>
            </li>
          );
        })}
        {items.length === 0 ? <li className="bf-type-menu__empty">No type matches “{query}”.</li> : null}
      </ul>
      {shape ? (
        <div className="bf-type-menu__wrappers">
          <label className="bf-check">
            <input type="checkbox" className="bf-check__box" checked={shape.array} onChange={(e) => setWrappers({ array: e.target.checked })} />
            <span>list</span>
          </label>
          <label className="bf-check">
            <input type="checkbox" className="bf-check__box" checked={shape.optional} onChange={(e) => setWrappers({ optional: e.target.checked })} />
            <span>optional</span>
          </label>
          {shape.array ? (
            <label className="bf-check">
              <input type="checkbox" className="bf-check__box" checked={shape.itemOptional} onChange={(e) => setWrappers({ itemOptional: e.target.checked })} />
              <span>items optional</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>,
    portalTarget(anchor),
  );
}
