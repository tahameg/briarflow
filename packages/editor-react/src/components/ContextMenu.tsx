/**
 * Right-click menus. `<ContextMenuProvider>` owns the open menu and the list of contributors;
 * components call `useContextMenu().open(event, target)` from `onContextMenu`, and anyone can
 * add entries for any target with `useContextMenuContributor` (or the provider's
 * `contributors` prop). The menu has submenus, keyboard navigation and, when long, a search
 * field that finds entries at any depth.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { collectItems, leafCount, nextEnabled, searchItems, separatorsBefore } from "../menu.js";
import type { ContextMenuContributor, ContextMenuItem, ContextMenuTarget, ContextMenuTransform, MenuSearchHit } from "../menu.js";
import { isTypingTarget } from "./selection.js";

/** Where a menu opens: a mouse event (right-click) or a point (keyboard). */
export type ContextMenuAnchor =
  | { clientX: number; clientY: number; target: EventTarget | null; preventDefault(): void; stopPropagation(): void }
  | { x: number; y: number; element?: Element | null };

/** Extra options of {@link ContextMenuApi.open}. */
export interface ContextMenuOpenOptions {
  onClose?: () => void;
}

/** Returned by {@link useContextMenu}. */
export interface ContextMenuApi {
  /**
   * Opens the menu for `target` with the contributors' items plus `local` items (entries only
   * the caller can run, such as "Rename" of an inline field). Returns false, and leaves the
   * event alone, when no item applies. `options.onClose` runs once when this menu goes away
   * (an item ran, Escape, a click outside, or another menu replaced it).
   */
  open(anchor: ContextMenuAnchor, target: ContextMenuTarget, local?: readonly ContextMenuItem[], options?: ContextMenuOpenOptions): boolean;
  close(): void;
}

interface Registry extends ContextMenuApi {
  register(contributor: ContextMenuContributor): () => void;
}

const MenuContext = createContext<Registry | null>(null);

/** Props of {@link ContextMenuProvider}. */
export interface ContextMenuProviderProps {
  children?: ReactNode;
  /** App contributors, asked after the ones components register. */
  contributors?: readonly ContextMenuContributor[];
  /** Last pass over the merged items. */
  transform?: ContextMenuTransform;
  /**
   * Hide the browser's own menu everywhere under the document except in text fields and
   * under `[data-bf-native-menu]` (default true).
   */
  suppressBrowserMenu?: boolean;
}

interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
  target: ContextMenuTarget;
  container: Element;
  restoreFocus: Element | null;
  onClose?: () => void;
}

/**
 * @example
 * ```tsx
 * <ContextMenuProvider contributors={[(t) => t.kind === "node" ? [{ id: "log", label: "Log id", run: () => console.log(t.nodeId) }] : null]}>
 *   <App />
 * </ContextMenuProvider>
 * ```
 */
export function ContextMenuProvider({ children, contributors, transform, suppressBrowserMenu = true }: ContextMenuProviderProps) {
  const registered = useRef<ContextMenuContributor[]>([]);
  const [menu, setMenu] = useState<OpenState | undefined>(undefined);
  const props = useRef({ contributors, transform });
  props.current = { contributors, transform };

  const close = useCallback(() => setMenu(undefined), []);
  const api = useMemo<Registry>(
    () => ({
      register(contributor) {
        registered.current = [...registered.current, contributor];
        return () => {
          registered.current = registered.current.filter((c) => c !== contributor);
        };
      },
      open(anchor, target, local, options) {
        const all = [...registered.current, ...(props.current.contributors ?? [])];
        let items = collectItems(all, target, local);
        if (props.current.transform) items = props.current.transform(items, target);
        if (items.length === 0) return false;
        let x: number;
        let y: number;
        let from: Element | null = null;
        if ("clientX" in anchor) {
          anchor.preventDefault();
          anchor.stopPropagation();
          x = anchor.clientX;
          y = anchor.clientY;
          from = anchor.target instanceof Element ? anchor.target : null;
        } else {
          x = anchor.x;
          y = anchor.y;
          from = anchor.element ?? null;
        }
        setMenu({ x, y, items, target, container: from?.closest("dialog") ?? document.body, restoreFocus: document.activeElement, ...(options?.onClose ? { onClose: options.onClose } : {}) });
        return true;
      },
      close: () => setMenu(undefined),
    }),
    [],
  );

  // Tell the previous menu it went away (not a cleanup: StrictMode re-runs effects on mount).
  const shown = useRef<OpenState | undefined>(undefined);
  useEffect(() => {
    if (shown.current && shown.current !== menu) shown.current.onClose?.();
    shown.current = menu;
  }, [menu]);

  useEffect(() => {
    if (!suppressBrowserMenu) return;
    const onMenu = (e: MouseEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-bf-native-menu]")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, [suppressBrowserMenu]);

  const onClose = useCallback(
    (restore: boolean) => {
      close();
      const el = menu?.restoreFocus;
      if (restore && el instanceof HTMLElement && el.isConnected) el.focus();
    },
    [close, menu],
  );

  return (
    <MenuContext.Provider value={api}>
      {children}
      {menu ? <MenuView key={`${menu.x}:${menu.y}:${menu.target.kind}`} state={menu} onClose={onClose} /> : null}
    </MenuContext.Provider>
  );
}

/** True inside a {@link ContextMenuProvider}. */
export function useHasContextMenu(): boolean {
  return useContext(MenuContext) !== null;
}

const NO_MENU: ContextMenuApi = { open: () => false, close: () => undefined };

/**
 * Opens and closes the context menu. Outside a provider, `open` does nothing (and returns false).
 *
 * @example
 * ```tsx
 * const menu = useContextMenu();
 * <div onContextMenu={(e) => menu.open(e, { kind: "global", globalId: g.id })} />
 * ```
 */
export function useContextMenu(): ContextMenuApi {
  return useContext(MenuContext) ?? NO_MENU;
}

/**
 * Adds menu entries while the calling component is mounted. The latest `contributor` is used,
 * so it may close over props and state.
 *
 * @example
 * ```tsx
 * useContextMenuContributor((t) => t.kind === "edge" ? [{ id: "inspect", label: "Inspect edge", order: 300, run: () => show(t.edgeId) }] : null);
 * ```
 */
export function useContextMenuContributor(contributor: ContextMenuContributor): void {
  const registry = useContext(MenuContext);
  const latest = useRef(contributor);
  latest.current = contributor;
  useEffect(() => registry?.register((t) => latest.current(t)), [registry]);
}

// ---- view -----------------------------------------------------------------------------------

/** Long menus get a search field. */
const SEARCH_ABOVE = 10;

interface Cursor {
  level: number;
  index: number;
}

function MenuView({ state, onClose }: { state: OpenState; onClose: (restoreFocus: boolean) => void }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  const rows = useRef(new Map<string, HTMLElement>());
  const searchable = leafCount(state.items) > SEARCH_ABOVE;
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<number[]>([]);
  const [cursor, setCursor] = useState<Cursor>({ level: 0, index: -1 });
  const [pos, setPos] = useState<({ left: number; top: number } | undefined)[]>([]);

  const hits = useMemo<MenuSearchHit[] | undefined>(() => (query.trim() ? searchItems(state.items, query) : undefined), [state.items, query]);
  const levels = useMemo(() => {
    const out: (readonly ContextMenuItem[])[] = [state.items];
    for (const i of expanded) {
      const sub = out[out.length - 1]![i]?.items;
      if (!sub) break;
      out.push(sub);
    }
    return out;
  }, [state.items, expanded]);

  useEffect(() => {
    setCursor({ level: 0, index: hits && hits.length > 0 ? 0 : -1 });
    if (hits) setExpanded([]);
  }, [hits]);

  // Place the root at the pointer and each submenu next to its parent row, inside the viewport.
  useLayoutEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const next: { left: number; top: number }[] = [];
    const shown = hits ? 1 : levels.length;
    for (let l = 0; l < shown; l++) {
      const el = panels.current[l];
      if (!el) break;
      const m = el.getBoundingClientRect();
      let left: number;
      let top: number;
      if (l === 0) {
        left = state.x + m.width > vw - 8 ? Math.max(8, state.x - m.width) : state.x;
        top = state.y + m.height > vh - 8 ? Math.max(8, vh - 8 - m.height) : state.y;
      } else {
        const row = rows.current.get(`${l - 1}:${expanded[l - 1]}`)?.getBoundingClientRect();
        const parent = next[l - 1]!;
        const parentWidth = panels.current[l - 1]?.getBoundingClientRect().width ?? 0;
        left = parent.left + parentWidth - 2;
        if (left + m.width > vw - 8) left = Math.max(8, parent.left - m.width + 2);
        top = Math.max(8, Math.min((row?.top ?? parent.top) - 4, vh - 8 - m.height));
      }
      next.push({ left, top });
    }
    setPos((p) => (p.length === next.length && p.every((q, i) => q?.left === next[i]!.left && q?.top === next[i]!.top) ? p : next));
  }, [levels, hits, expanded, state.x, state.y]);

  useEffect(() => {
    if (!searchable) root.current?.focus();
    const inside = (t: EventTarget | null) => t instanceof Node && root.current?.contains(t) === true;
    const onDown = (e: PointerEvent) => !inside(e.target) && onClose(false);
    const onWheel = (e: WheelEvent) => !inside(e.target) && onClose(false);
    const onBlur = () => onClose(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("wheel", onWheel, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose, searchable]);

  const activate = (item: ContextMenuItem, level: number, index: number) => {
    if (item.disabled) return;
    if (item.items) {
      setExpanded((e) => [...e.slice(0, level), index]);
      setCursor({ level: level + 1, index: nextEnabled(item.items, -1, 1) });
      return;
    }
    onClose(true);
    item.run?.();
  };

  const list: readonly { disabled?: boolean }[] = hits ? hits.map((h) => h.item) : (levels[cursor.level] ?? []);
  const current: ContextMenuItem | undefined = hits ? hits[cursor.index]?.item : levels[cursor.level]?.[cursor.index];

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else if (expanded.length > 0 && cursor.level > 0) {
        setCursor({ level: cursor.level - 1, index: expanded[cursor.level - 1]! });
        setExpanded((x) => x.slice(0, cursor.level - 1));
      } else onClose(true);
    } else if (k === "ArrowDown" || k === "ArrowUp") {
      e.preventDefault();
      if (list.length > 0) setCursor((c) => ({ level: c.level, index: nextEnabled(list, c.index, k === "ArrowDown" ? 1 : -1) }));
    } else if (k === "ArrowRight" && !hits) {
      if (current?.items && !current.disabled) {
        e.preventDefault();
        activate(current, cursor.level, cursor.index);
      }
    } else if (k === "ArrowLeft" && !hits) {
      if (cursor.level > 0) {
        e.preventDefault();
        setCursor({ level: cursor.level - 1, index: expanded[cursor.level - 1]! });
        setExpanded((x) => x.slice(0, cursor.level - 1));
      }
    } else if (k === "Enter") {
      e.preventDefault();
      if (current) activate(current, hits ? 0 : cursor.level, cursor.index);
    } else if (k === "Tab") {
      e.preventDefault();
    }
  };

  const hover = (level: number, index: number, item: ContextMenuItem) => {
    setCursor({ level, index });
    if (hits) return;
    setExpanded((e) => (item.items && !item.disabled ? [...e.slice(0, level), index] : e.slice(0, level)));
  };

  const rowId = (level: number, index: number) => `${id}-${level}-${index}`;
  const panelStyle = (l: number): CSSProperties => {
    const p = pos[l];
    // Unplaced panels stay focusable (the search field autofocuses) but invisible.
    return p ? { left: p.left, top: p.top } : { left: state.x, top: state.y, opacity: 0, pointerEvents: "none" };
  };

  const renderRow = (item: ContextMenuItem, level: number, index: number, path?: readonly string[]) => {
    const active = cursor.level === level && cursor.index === index;
    const open = !hits && expanded[level] === index && item.items !== undefined;
    return (
      <button
        key={item.id}
        id={rowId(level, index)}
        ref={(el) => {
          if (el) rows.current.set(`${level}:${index}`, el);
          else rows.current.delete(`${level}:${index}`);
        }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={item.disabled || undefined}
        aria-haspopup={item.items ? "menu" : undefined}
        aria-expanded={item.items ? open : undefined}
        className={["bf-cmenu__item", active && "bf-cmenu__item--active", open && "bf-cmenu__item--open", item.danger && "bf-cmenu__item--danger", item.disabled && "bf-cmenu__item--disabled"].filter(Boolean).join(" ")}
        title={item.title}
        onMouseEnter={() => hover(level, index, item)}
        onClick={() => activate(item, level, index)}
      >
        <span className="bf-cmenu__strip" style={item.accent ? { background: item.accent } : undefined} aria-hidden="true" />
        <span className="bf-cmenu__label">
          {path && path.length > 0 ? <span className="bf-cmenu__path">{path.join(" › ")} › </span> : null}
          {item.label}
        </span>
        {item.hint ? <span className="bf-cmenu__hint">{item.hint}</span> : null}
        {item.shortcut ? <kbd className="bf-cmenu__key">{item.shortcut}</kbd> : null}
        {item.items ? (
          <span className="bf-cmenu__chev" aria-hidden="true">
            ▸
          </span>
        ) : null}
      </button>
    );
  };

  const renderList = (items: readonly ContextMenuItem[], level: number) => {
    const seps = separatorsBefore(items);
    return items.map((item, i) => (
      <div key={item.id} role="none">
        {seps.has(i) ? <div className="bf-cmenu__sep" role="separator" /> : null}
        {renderRow(item, level, i)}
      </div>
    ));
  };

  return createPortal(
    <div
      ref={root}
      className="bf-cmenu-root nodrag nopan nowheel"
      tabIndex={-1}
      aria-activedescendant={cursor.index >= 0 ? rowId(cursor.level, cursor.index) : undefined}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={(el) => void (panels.current[0] = el)} className="bf-cmenu" role="menu" aria-label="Context menu" style={panelStyle(0)}>
        {searchable ? (
          <input
            className="bf-input bf-cmenu__search"
            aria-label="Search menu"
            placeholder="Search…"
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        <div className="bf-cmenu__list">
          {hits ? (
            hits.length > 0 ? (
              hits.map((h, i) => renderRow(h.item, 0, i, h.path))
            ) : (
              <p className="bf-cmenu__empty">No match for “{query}”.</p>
            )
          ) : (
            renderList(state.items, 0)
          )}
        </div>
      </div>
      {hits
        ? null
        : levels.slice(1).map((items, i) => (
            <div key={`${i}:${expanded[i]}`} ref={(el) => void (panels.current[i + 1] = el)} className="bf-cmenu bf-cmenu--sub" role="menu" style={panelStyle(i + 1)}>
              <div className="bf-cmenu__list">{renderList(items, i + 1)}</div>
            </div>
          ))}
    </div>,
    state.container,
  );
}
