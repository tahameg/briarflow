/**
 * Pure helpers for the node palette: grouping, search and a starting config for node types
 * whose config is required (so "add" works without a dialog).
 */
import { scopeForFlow } from "@briarflow/core";
import type { AnyNodeDefinition, ContextDocument, NodeCatalog, NodeDescriptor, Position } from "@briarflow/core";

/** One palette group. */
export interface PaletteGroup {
  category: string;
  nodes: NodeDescriptor[];
}

/**
 * Groups descriptors by category (sorted), filtered by a search over title, type, category and
 * description. Deprecated nodes are hidden unless they match the search exactly by type.
 */
export function paletteGroups(descriptors: readonly NodeDescriptor[], search = ""): PaletteGroup[] {
  const q = search.trim().toLowerCase();
  const groups = new Map<string, NodeDescriptor[]>();
  for (const d of descriptors) {
    if (d.deprecated && d.type !== q) continue;
    if (q && ![d.title, d.type, d.category, d.description].some((s) => s.toLowerCase().includes(q))) continue;
    const list = groups.get(d.category) ?? [];
    list.push(d);
    groups.set(d.category, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, nodes]) => ({ category, nodes: nodes.sort((a, b) => a.title.localeCompare(b.title)) }));
}

/**
 * A config for a new node: field defaults, plus a first sensible choice for required fields
 * without a default (first struct for `typeId`, first variable / global, `text` for `type`).
 * Returns `undefined` when the node has no config fields.
 */
export function initialConfig(def: AnyNodeDefinition | undefined, doc: ContextDocument, flowId: string, catalog: NodeCatalog): Record<string, unknown> | undefined {
  if (!def) return undefined;
  const entries = Object.entries(def.config);
  if (entries.length === 0) return undefined;
  const flow = doc.flows.find((f) => f.id === flowId);
  const scope = scopeForFlow(doc, flowId, catalog);
  const out: Record<string, unknown> = {};
  for (const [key, field] of entries) {
    if (field.default !== undefined) {
      out[key] = field.default;
      continue;
    }
    if (!field.required) continue;
    switch (field.kind) {
      case "text":
        out[key] = "";
        break;
      case "int":
        out[key] = field.min ?? 0;
        break;
      case "boolean":
        out[key] = false;
        break;
      case "choice":
        if (field.choices?.[0] !== undefined) out[key] = field.choices[0];
        break;
      case "type":
        out[key] = "text";
        break;
      case "typeId": {
        const decl = scope.all().find((t) => field.typeKind === undefined || field.typeKind === "any" || t.decl.kind === field.typeKind);
        if (decl) out[key] = decl.decl.id;
        break;
      }
      case "flowVariable":
        if (flow?.variables[0]) out[key] = flow.variables[0].id;
        break;
      case "global": {
        const g = doc.globals.find((x) => !field.writable || x.access === "readwrite");
        if (g) out[key] = g.id;
        break;
      }
    }
  }
  return out;
}

/** Snaps a position to the 12 px half-cell grid (design-system.md §5). */
export function snap(p: Position, grid = 12): Position {
  return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
}

/** Approximate footprint of a node on the canvas, used to avoid stacking new nodes. */
const NODE_FOOTPRINT = { width: 260, height: 200 } as const;

/**
 * The first free spot for a new node at or near `desired`: steps right, then down, until the
 * footprint overlaps no existing node (so a click-added node never hides another node's ports).
 *
 * @example
 * ```ts
 * freePosition([{ x: 0, y: 0 }], { x: 10, y: 10 }); // → { x: 288, y: 12 }
 * ```
 */
export function freePosition(occupied: readonly Position[], desired: Position): Position {
  const { width, height } = NODE_FOOTPRINT;
  const overlaps = (p: Position) => occupied.some((o) => Math.abs(o.x - p.x) < width && Math.abs(o.y - p.y) < height);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 6; col++) {
      const p = snap({ x: desired.x + col * (width + 24), y: desired.y + row * (height + 24) });
      if (!overlaps(p)) return p;
    }
  }
  return snap(desired);
}

/** Drag-and-drop mime type of palette items (payload: the node type). */
export const NODE_TYPE_MIME = "application/x-briarflow-node-type";

/** Drag data: JSON config for the node dropped with {@link NODE_TYPE_MIME} (variable rows). */
export const NODE_CONFIG_MIME = "application/x-briarflow-node-config";
