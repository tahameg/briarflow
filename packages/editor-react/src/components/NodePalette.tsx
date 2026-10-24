/**
 * `<NodePalette>`: node types grouped by category with search. Click / Enter adds the node at
 * the canvas center; drag drops it where released.
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useCanvasHandle, useDispatch, useEditorState, useEditorStore, useFlowId } from "../context.js";
import { MEMBER_NODE_TYPES } from "@briarflow/core";
import { NODE_TYPE_MIME, initialConfig, paletteGroups, freePosition } from "../palette.js";
import { nodeAccent } from "../theme.js";

/** Props of {@link NodePalette}. */
export interface NodePaletteProps {
  /** Flow that receives new nodes. Default: the active flow. */
  flowId?: string;
}

/**
 * @example
 * ```tsx
 * <NodePalette />
 * ```
 */
export function NodePalette({ flowId: flowIdProp }: NodePaletteProps) {
  const store = useEditorStore();
  const dispatch = useDispatch();
  const flowId = useFlowId(flowIdProp);
  const catalog = useEditorState((s) => s.catalog);
  const nodeTypes = useEditorState((s) => s.nodeTypes);
  const status = useEditorState((s) => s.status);
  const canvas = useCanvasHandle();
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // Member nodes come from a dropped wire (they need the value's type), not from the palette.
  const descriptors = useMemo(() => (catalog?.descriptors() ?? nodeTypes?.nodes ?? []).filter((d) => d.type !== MEMBER_NODE_TYPES.get && d.type !== MEMBER_NODE_TYPES.set), [catalog, nodeTypes]);
  const groups = useMemo(() => paletteGroups(descriptors, search), [descriptors, search]);

  const add = (type: string) => {
    const s = store.getState();
    if (!flowId || !s.doc || !s.catalog) return;
    const center = canvas.current?.center() ?? { x: 0, y: 0 };
    const config = initialConfig(s.catalog.get(type), s.doc, flowId, s.catalog);
    const occupied = s.doc.flows.find((f) => f.id === flowId)?.nodes.map((n) => n.position) ?? [];
    const position = freePosition(occupied, { x: center.x - 110, y: center.y - 40 });
    const r = dispatch({ op: "node.add", flowId, type, position, ...(config ? { config } : {}) });
    if (r.ok && r.created.nodeId) store.select({ nodes: [r.created.nodeId] }, "replace");
  };

  return (
    <div className="bf-palette">
      <div className="bf-palette__search">
        <label className="bf-visually-hidden" htmlFor="bf-palette-search">
          Search nodes
        </label>
        <input
          id="bf-palette-search"
          data-bf-palette-search=""
          className="bf-input"
          type="search"
          placeholder="Search nodes…  ( / )"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && groups[0]?.nodes[0]) add(groups[0].nodes[0].type);
            if (e.key === "Escape") setSearch("");
          }}
        />
      </div>
      {status === "loading" ? <p className="bf-palette__note">Loading node types…</p> : null}
      {status !== "loading" && groups.length === 0 ? <p className="bf-palette__note">{search ? `No node matches "${search}".` : "No node types available."}</p> : null}
      {!flowId && groups.length > 0 ? <p className="bf-palette__note">Open a flow to add nodes.</p> : null}
      {groups.map((g) => {
        const open = search !== "" || !collapsed.has(g.category);
        return (
          <section className="bf-palette__group" key={g.category}>
            <h3 className="bf-palette__heading">
              <button
                type="button"
                className="bf-palette__toggle"
                aria-expanded={open}
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c);
                    if (n.has(g.category)) n.delete(g.category);
                    else n.add(g.category);
                    return n;
                  })
                }
              >
                <span aria-hidden="true">{open ? "▾" : "▸"}</span> {g.category}
                <span className="bf-palette__count">{g.nodes.length}</span>
              </button>
            </h3>
            {open ? (
              <ul>
                {g.nodes.map((d) => (
                  <li key={d.type}>
                    <button
                      type="button"
                      className="bf-palette__item"
                      style={{ "--bf-node-strip": `var(--bf-${nodeAccent(d.color, d.category)})` } as CSSProperties}
                      draggable={!!flowId}
                      disabled={!flowId}
                      title={`${d.type}${d.description ? ` — ${d.description}` : ""}`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(NODE_TYPE_MIME, d.type);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => add(d.type)}
                    >
                      <span className="bf-palette__title">{d.title}</span>
                      <span className="bf-palette__type">{d.type}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
