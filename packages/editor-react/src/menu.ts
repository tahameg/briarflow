/**
 * Context menu model (no React): targets, items, and the pure helpers that merge contributions,
 * place separators and search nested items. `components/ContextMenu.tsx` renders it.
 */
import type { Position } from "@briarflow/core";

/**
 * What was right-clicked, by kind. Apps add their own kinds with declaration merging:
 *
 * @example
 * ```ts
 * declare module "@briarflow/editor-react" {
 *   interface ContextMenuTargets {
 *     panel: { panelId: string };
 *   }
 * }
 * ```
 */
export interface ContextMenuTargets {
  /** Empty canvas. `position` is in flow coordinates (where an added node lands). */
  pane: { flowId: string; position: Position };
  /** A node. `nodeIds` is what the menu acts on: the selection when the node is part of it. */
  node: { flowId: string; nodeId: string; nodeIds: readonly string[] };
  edge: { flowId: string; edgeId: string };
  /** A port handle on a node. `line`: an execution socket (`in`, `then`, `failed`). */
  port: { flowId: string; nodeId: string; port: string; side: "in" | "out"; line?: boolean };
  /**
   * A wire dropped on empty canvas, dragged from `nodeId.port`; `position` is the drop point.
   * `line`: it is an execution line (port `then` / `failed` / `in`).
   */
  connect: { flowId: string; position: Position; nodeId: string; port: string; side: "in" | "out"; line?: boolean };
  /** A flow variable row. */
  variable: { flowId: string; variableId: string };
  /** A context global row. */
  global: { globalId: string };
  /** A struct or enum. */
  type: { typeId: string };
  /** A struct field (`typeId` set), flow input / output, or another named row. */
  field: { fieldKind: string; name: string; typeId?: string; flowId?: string };
}

/** A right-click target: `{ kind, ...fields }` for one of {@link ContextMenuTargets}. */
export type ContextMenuTarget = { [K in keyof ContextMenuTargets]: { kind: K } & ContextMenuTargets[K] }[keyof ContextMenuTargets];

/** One menu entry: an action (`run`) or a submenu (`items`). */
export interface ContextMenuItem {
  /** Stable id, unique within its menu level (contributors use it to replace or drop items). */
  id: string;
  label: string;
  /**
   * Sort key. Items with equal order keep their contribution order. A line separates items
   * whose hundreds differ (or whose `group` differs). Built-in bands: 100 add, 200 edit,
   * 300 view, 800 navigate, 900 delete.
   */
  order?: number;
  /** Separator group; defaults to the hundreds of `order`. */
  group?: string;
  /** Keyboard hint shown on the right ("Del", "Ctrl+D"). */
  shortcut?: string;
  /** Muted text on the right (a node type, a count). */
  hint?: string;
  /** Extra search words. */
  keywords?: readonly string[];
  /** CSS color of a strip at the left edge (node accents). */
  accent?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip; for a disabled item, say why. */
  title?: string;
  run?: () => void;
  /** Submenu entries. */
  items?: readonly ContextMenuItem[];
}

/** Returns the items a contributor adds for a target (nothing → `undefined`, `null`, `false` or `[]`). */
export type ContextMenuContributor = (target: ContextMenuTarget) => readonly ContextMenuItem[] | null | undefined | false;

/** Final hook over the merged items (rename, drop, reorder). */
export type ContextMenuTransform = (items: ContextMenuItem[], target: ContextMenuTarget) => ContextMenuItem[];

const DEFAULT_ORDER = 500;

/** The separator group of an item. */
export function itemGroup(item: ContextMenuItem): string {
  return item.group ?? String(Math.floor((item.order ?? DEFAULT_ORDER) / 100));
}

/**
 * Merges item lists: a later item with the same id replaces an earlier one (in its place),
 * then a stable sort by `order`. Submenus with the same id are merged recursively.
 *
 * @example
 * ```ts
 * mergeItems([[{ id: "del", label: "Delete", order: 900 }], [{ id: "dup", label: "Duplicate", order: 200 }]]);
 * // → Duplicate, Delete
 * ```
 */
export function mergeItems(lists: readonly (readonly ContextMenuItem[])[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  const at = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) {
      const i = at.get(item.id);
      if (i === undefined) {
        at.set(item.id, out.length);
        out.push(item);
        continue;
      }
      const prev = out[i]!;
      out[i] = prev.items && item.items ? { ...prev, ...item, items: mergeItems([prev.items, item.items]) } : item;
    }
  }
  return out
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? DEFAULT_ORDER) - (b.item.order ?? DEFAULT_ORDER) || a.index - b.index)
    .map(({ item }) => item);
}

/** Collects every contributor's items for `target`, merged and sorted. */
export function collectItems(contributors: Iterable<ContextMenuContributor>, target: ContextMenuTarget, local?: readonly ContextMenuItem[]): ContextMenuItem[] {
  const lists: (readonly ContextMenuItem[])[] = local ? [local] : [];
  for (const c of contributors) {
    const items = c(target);
    if (items && items.length > 0) lists.push(items);
  }
  return mergeItems(lists).filter((item) => item.run !== undefined || (item.items !== undefined && item.items.length > 0));
}

/** Indices before which a separator goes. */
export function separatorsBefore(items: readonly ContextMenuItem[]): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < items.length; i++) if (itemGroup(items[i]!) !== itemGroup(items[i - 1]!)) out.add(i);
  return out;
}

/** Number of runnable entries, submenus included. */
export function leafCount(items: readonly ContextMenuItem[]): number {
  let n = 0;
  for (const item of items) n += item.items ? leafCount(item.items) : item.run ? 1 : 0;
  return n;
}

/** A search hit: a runnable item and the labels of the submenus above it. */
export interface MenuSearchHit {
  item: ContextMenuItem;
  path: readonly string[];
}

/**
 * Runnable items (at any depth) whose label, path, hint or keywords contain every word of
 * `query`, ignoring case. Items whose label starts with the query come first.
 *
 * @example
 * ```ts
 * searchItems(items, "templ"); // → [{ item: { label: "Template", … }, path: ["Text"] }]
 * ```
 */
export function searchItems(items: readonly ContextMenuItem[], query: string): MenuSearchHit[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: MenuSearchHit[] = [];
  const walk = (list: readonly ContextMenuItem[], path: readonly string[]) => {
    for (const item of list) {
      if (item.items) {
        walk(item.items, [...path, item.label]);
        continue;
      }
      if (!item.run || item.disabled) continue;
      const hay = [item.label, item.hint ?? "", ...path, ...(item.keywords ?? [])].join(" ").toLowerCase();
      if (words.every((w) => hay.includes(w))) hits.push({ item, path });
    }
  };
  walk(items, []);
  const first = words[0]!;
  return hits
    .map((h, i) => ({ h, i, rank: h.item.label.toLowerCase().startsWith(first) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ h }) => h);
}

/** Next enabled index from `from` in direction `dir`, wrapping; `-1` when none is enabled. */
export function nextEnabled(items: readonly { disabled?: boolean }[], from: number, dir: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i]!.disabled) return i;
  }
  return -1;
}
