/**
 * Dockable panels: three zones (left, right, bottom). Side zones stack their panels (each
 * collapsible); the bottom zone shows them as tabs. Drag a panel's title (or a bottom tab) onto
 * another zone or next to another panel, or use its ⇄ menu or right-click menu. The layout
 * persists per browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useContextMenu } from "@briarflow/editor-react";
import type { ContextMenuItem } from "@briarflow/editor-react";

declare module "@briarflow/editor-react" {
  interface ContextMenuTargets {
    /** A dock panel's title bar or bottom tab. */
    panel: { panelId: string };
  }
}

export type Zone = "left" | "right" | "bottom";
export const ZONES: readonly Zone[] = ["left", "right", "bottom"];
export const PANEL_IDS = ["variables", "inspector", "run", "console", "problems"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface DockLayout {
  zones: Record<Zone, PanelId[]>;
  collapsed: PanelId[];
  /** Active tab of the bottom zone. */
  bottomTab: PanelId | undefined;
}

export const DEFAULT_LAYOUT: DockLayout = {
  zones: { left: ["variables"], right: ["inspector"], bottom: ["run", "console", "problems"] },
  collapsed: [],
  bottomTab: "run",
};

const STORAGE_KEY = "briarflow.studio.dock.v1";
const PANEL_MIME = "application/x-briarflow-panel";

const isPanelId = (v: unknown): v is PanelId => (PANEL_IDS as readonly unknown[]).includes(v);

/**
 * A stored layout made valid for the current panel set: unknown panels (from older versions)
 * are dropped, missing ones go to their default zone. `undefined` when it is not a layout.
 */
export function normalizeLayout(v: unknown): DockLayout | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const l = v as Partial<Record<keyof DockLayout, unknown>>;
  const zonesIn = l.zones as Partial<Record<Zone, unknown>> | undefined;
  if (typeof zonesIn !== "object" || zonesIn === null || !ZONES.every((z) => Array.isArray(zonesIn[z]))) return undefined;
  const seen = new Set<PanelId>();
  const zones = Object.fromEntries(
    ZONES.map((z) => [
      z,
      (zonesIn[z] as unknown[]).filter((id): id is PanelId => {
        if (!isPanelId(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    ]),
  ) as Record<Zone, PanelId[]>;
  for (const id of PANEL_IDS) if (!seen.has(id)) zones[zoneOf(DEFAULT_LAYOUT, id)].push(id);
  const collapsed = Array.isArray(l.collapsed) ? l.collapsed.filter(isPanelId) : [];
  const bottomTab = isPanelId(l.bottomTab) && zones.bottom.includes(l.bottomTab) ? l.bottomTab : zones.bottom[0];
  return { zones, collapsed, bottomTab };
}

function loadLayout(): DockLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const layout = normalizeLayout(raw ? JSON.parse(raw) : undefined);
    if (layout) return layout;
  } catch {
    // Storage unavailable or corrupt: fall back to the default.
  }
  return DEFAULT_LAYOUT;
}

/** Zone that holds `id`. */
export function zoneOf(layout: DockLayout, id: PanelId): Zone {
  return ZONES.find((z) => layout.zones[z].includes(id)) ?? "left";
}

/** `layout` with `id` moved into `zone`, before `before` (or last). */
export function movePanel(layout: DockLayout, id: PanelId, zone: Zone, before?: PanelId): DockLayout {
  if (before === id && layout.zones[zone].includes(id)) return layout;
  const zones = Object.fromEntries(ZONES.map((z) => [z, layout.zones[z].filter((p) => p !== id)])) as Record<Zone, PanelId[]>;
  const list = zones[zone];
  const at = before && before !== id ? list.indexOf(before) : -1;
  if (at === -1) list.push(id);
  else list.splice(at, 0, id);
  const bottomTab = zone === "bottom" ? id : layout.bottomTab && zones.bottom.includes(layout.bottomTab) ? layout.bottomTab : zones.bottom[0];
  return { zones, collapsed: layout.collapsed.filter((p) => p !== id), bottomTab };
}

export interface DockApi {
  layout: DockLayout;
  /** Panel being dragged, if any. */
  dragging: PanelId | undefined;
  move: (id: PanelId, zone: Zone, before?: PanelId) => void;
  toggle: (id: PanelId) => void;
  /** Make a panel visible: select its bottom tab or expand it. */
  reveal: (id: PanelId) => void;
  setBottomTab: (id: PanelId) => void;
  setDragging: (id: PanelId | undefined) => void;
  reset: () => void;
}

export function useDock(): DockApi {
  const [layout, setLayout] = useState<DockLayout>(loadLayout);
  const [dragging, setDragging] = useState<PanelId | undefined>(undefined);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Not persisted; the layout still works for this session.
    }
  }, [layout]);
  const move = useCallback((id: PanelId, zone: Zone, before?: PanelId) => setLayout((l) => movePanel(l, id, zone, before)), []);
  const toggle = useCallback((id: PanelId) => setLayout((l) => ({ ...l, collapsed: l.collapsed.includes(id) ? l.collapsed.filter((p) => p !== id) : [...l.collapsed, id] })), []);
  const reveal = useCallback(
    (id: PanelId) =>
      setLayout((l) => ({ ...l, collapsed: l.collapsed.filter((p) => p !== id), bottomTab: l.zones.bottom.includes(id) ? id : l.bottomTab })),
    [],
  );
  const setBottomTab = useCallback((id: PanelId) => setLayout((l) => ({ ...l, bottomTab: id })), []);
  const reset = useCallback(() => setLayout(DEFAULT_LAYOUT), []);
  return { layout, dragging, move, toggle, reveal, setBottomTab, setDragging, reset };
}

/** What the workspace shows for one panel. */
export interface PanelDef {
  title: ReactNode;
  /** Plain-text title for labels. */
  name: string;
  body: ReactNode;
  /** No inner padding. */
  flush?: boolean;
  /** Buttons in the title bar. */
  actions?: ReactNode;
}

function dropTarget(e: ReactDragEvent): PanelId | undefined {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dock-panel]");
  if (!el) return undefined;
  const id = el.dataset.dockPanel as PanelId;
  const r = el.getBoundingClientRect();
  const vertical = el.dataset.dockAxis !== "x";
  const after = vertical ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
  if (!after) return id;
  const next = el.nextElementSibling as HTMLElement | null;
  return (next?.dataset.dockPanel as PanelId | undefined) ?? undefined;
}

function useDropZone(dock: DockApi, zone: Zone) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: ReactDragEvent) => {
        if (!e.dataTransfer.types.includes(PANEL_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e: ReactDragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: ReactDragEvent) => {
        const id = e.dataTransfer.getData(PANEL_MIME) as PanelId;
        setOver(false);
        if (!(PANEL_IDS as readonly string[]).includes(id)) return;
        e.preventDefault();
        dock.move(id, zone, dropTarget(e));
        dock.setDragging(undefined);
      },
    },
  };
}

function dragProps(dock: DockApi, id: PanelId) {
  return {
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      e.dataTransfer.setData(PANEL_MIME, id);
      e.dataTransfer.effectAllowed = "move";
      dock.setDragging(id);
    },
    onDragEnd: () => dock.setDragging(undefined),
  };
}

const ZONE_LABEL: Record<Zone, string> = { left: "Dock left", right: "Dock right", bottom: "Dock bottom" };

/** Right-click entries of a panel: collapse, move to another zone, reset. */
function panelMenuItems(dock: DockApi, id: PanelId): ContextMenuItem[] {
  const zone = zoneOf(dock.layout, id);
  const collapsed = dock.layout.collapsed.includes(id);
  return [
    ...(zone !== "bottom" ? [{ id: "collapse", label: collapsed ? "Expand" : "Collapse", order: 200, run: () => dock.toggle(id) }] : []),
    ...ZONES.filter((z) => z !== zone).map((z) => ({ id: `dock:${z}`, label: ZONE_LABEL[z], order: 300, run: () => dock.move(id, z) })),
    { id: "reset", label: "Reset layout", order: 800, run: () => dock.reset() },
  ];
}

function usePanelMenu(dock: DockApi) {
  const menu = useContextMenu();
  return (e: ReactMouseEvent, id: PanelId) => menu.open(e, { kind: "panel", panelId: id }, panelMenuItems(dock, id));
}

/** A side zone (left / right): stacked, collapsible panels. Renders a drop strip while empty and dragging. */
export function SideZone({ dock, zone, panels }: { dock: DockApi; zone: "left" | "right"; panels: Record<PanelId, PanelDef> }) {
  const ids = dock.layout.zones[zone];
  const drop = useDropZone(dock, zone);
  const panelMenu = usePanelMenu(dock);
  if (ids.length === 0 && !dock.dragging) return null;
  return (
    <aside className={["bf-zone", `bf-zone--${zone}`, ids.length === 0 && "bf-zone--empty", dock.dragging && "bf-zone--target", drop.over && "bf-zone--over"].filter(Boolean).join(" ")} aria-label={`${zone} dock`} {...drop.props}>
      {ids.length === 0 ? <div className="bf-zone__hint">Drop here</div> : null}
      {ids.map((id) => {
        const def = panels[id];
        const collapsed = dock.layout.collapsed.includes(id);
        return (
          <section key={id} className={collapsed ? "bf-panel bf-dock-panel bf-dock-panel--collapsed" : "bf-panel bf-dock-panel"} data-dock-panel={id} aria-label={def.name}>
            <header className="bf-panel__bar bf-dock-panel__bar" onContextMenu={(e) => panelMenu(e, id)}>
              <button
                type="button"
                className="bf-dock-panel__toggle"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${def.name}`}
                onClick={() => dock.toggle(id)}
              >
                <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
              </button>
              <h2 className="bf-panel__title bf-dock-panel__title" title="Drag to move this panel" {...dragProps(dock, id)}>
                {def.title}
              </h2>
              <div className="bf-panel__actions">
                {def.actions}
                <MoveMenu dock={dock} id={id} name={def.name} />
              </div>
            </header>
            {collapsed ? null : <div className={def.flush ? "bf-panel__body bf-panel__body--flush" : "bf-panel__body"}>{def.body}</div>}
          </section>
        );
      })}
    </aside>
  );
}

/** The bottom zone: tabs. */
export function BottomZone({ dock, panels }: { dock: DockApi; panels: Record<PanelId, PanelDef> }) {
  const ids = dock.layout.zones.bottom;
  const drop = useDropZone(dock, "bottom");
  const panelMenu = usePanelMenu(dock);
  if (ids.length === 0 && !dock.dragging) return null;
  const active = dock.layout.bottomTab && ids.includes(dock.layout.bottomTab) ? dock.layout.bottomTab : ids[0];
  const def = active ? panels[active] : undefined;
  return (
    <section className={["bf-dock", "bf-zone", "bf-zone--bottom", ids.length === 0 && "bf-zone--empty", dock.dragging && "bf-zone--target", drop.over && "bf-zone--over"].filter(Boolean).join(" ")} aria-label="Bottom dock" {...drop.props}>
      {ids.length === 0 ? (
        <div className="bf-zone__hint">Drop here</div>
      ) : (
        <>
          <div className="bf-dock__bar">
            <div className="bf-tabs" role="tablist" aria-label="Bottom dock panels">
              {ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`dock-tab-${id}`}
                  aria-selected={id === active}
                  aria-controls={`dock-panel-${id}`}
                  className={id === active ? "bf-tab bf-tab--active" : "bf-tab"}
                  data-dock-panel={id}
                  data-dock-axis="x"
                  title="Drag to move this panel"
                  onClick={() => dock.setBottomTab(id)}
                  onContextMenu={(e) => panelMenu(e, id)}
                  {...dragProps(dock, id)}
                >
                  {panels[id].title}
                </button>
              ))}
            </div>
            {active && def ? (
              <div className="bf-panel__actions">
                {def.actions}
                <MoveMenu dock={dock} id={active} name={def.name} />
              </div>
            ) : null}
          </div>
          {active && def ? (
            <div className={def.flush ? "bf-dock__body bf-dock__body--flush" : "bf-dock__body"} role="tabpanel" id={`dock-panel-${active}`} aria-labelledby={`dock-tab-${active}`} tabIndex={0}>
              {def.body}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function MoveMenu({ dock, id, name }: { dock: DockApi; id: PanelId; name: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = zoneOf(dock.layout, id);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="bf-move" ref={ref}>
      <button type="button" className="bf-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Move ${name}`} title="Move panel" onClick={() => setOpen((o) => !o)}>
        ⇄
      </button>
      {open ? (
        <div className="bf-move__menu" role="menu" aria-label={`Move ${name}`}>
          {ZONES.filter((z) => z !== current).map((z) => (
            <button
              key={z}
              type="button"
              role="menuitem"
              className="bf-move__item"
              onClick={() => {
                setOpen(false);
                dock.move(id, z);
              }}
            >
              {ZONE_LABEL[z]}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="bf-move__item bf-move__item--muted"
            onClick={() => {
              setOpen(false);
              dock.reset();
            }}
          >
            Reset layout
          </button>
        </div>
      ) : null}
    </div>
  );
}
