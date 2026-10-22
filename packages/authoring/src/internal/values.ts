/**
 * Rewriting stored values (constants, defaults, global values) when a struct field or an enum
 * member is renamed (commands.md §3).
 */
import type { ContextDocument, FieldDecl, NodeCatalog, TypeDecl, TypeRef } from "@briarflow/core";
import type { PortsOf } from "./normalize.js";
import { isObject } from "./util.js";

type Visit = (value: unknown, decl: TypeDecl) => unknown;

function lookupFor(doc: ContextDocument, catalog: NodeCatalog): (id: string) => TypeDecl | undefined {
  const all = new Map<string, TypeDecl>();
  for (const t of catalog.types) all.set(t.id, t);
  for (const t of doc.types) all.set(t.id, t);
  for (const f of doc.flows) for (const t of f.types) all.set(t.id, t);
  return (id) => all.get(id);
}

/** Applies `visit` to every value position typed as a named type, bottom-up. */
function mapValue(value: unknown, type: TypeRef, lookup: (id: string) => TypeDecl | undefined, visit: Visit, depth = 0): unknown {
  if (value === undefined || value === null || depth > 64) return value;
  switch (type.kind) {
    case "optional":
      return mapValue(value, type.of, lookup, visit, depth + 1);
    case "list": {
      if (!Array.isArray(value)) return value;
      let changed = false;
      const out = value.map((v) => {
        const n = mapValue(v, type.of, lookup, visit, depth + 1);
        if (n !== v) changed = true;
        return n;
      });
      return changed ? out : value;
    }
    case "named": {
      const decl = lookup(type.id);
      if (!decl) return value;
      let next = value;
      if (decl.kind === "struct" && isObject(value)) {
        let changed = false;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          const field = decl.fields.find((f) => f.name === k);
          const n = field ? mapValue(v, field.type, lookup, visit, depth + 1) : v;
          if (n !== v) changed = true;
          out[k] = n;
        }
        if (changed) next = out;
      }
      return visit(next, decl);
    }
    default:
      return value;
  }
}

/**
 * Rewrites every stored value of the document with `visit` (applied at positions typed as a
 * named type). Port types of constants come from `ports(doc, flowId)`.
 */
export function rewriteStoredValues(doc: ContextDocument, catalog: NodeCatalog, ports: PortsOf, visit: Visit): ContextDocument {
  const lookup = lookupFor(doc, catalog);
  const map = (v: unknown, t: TypeRef) => mapValue(v, t, lookup, visit);
  const mapDefaults = <T extends { type: TypeRef; default?: unknown }>(items: readonly T[]): readonly T[] => {
    let changed = false;
    const out = items.map((x) => {
      if (x.default === undefined) return x;
      const n = map(x.default, x.type);
      if (n === x.default) return x;
      changed = true;
      return { ...x, default: n };
    });
    return changed ? out : items;
  };
  const mapTypes = (types: readonly TypeDecl[]): readonly TypeDecl[] => {
    let changed = false;
    const out = types.map((t) => {
      if (t.kind !== "struct") return t;
      const fields = mapDefaults<FieldDecl>(t.fields);
      if (fields === t.fields) return t;
      changed = true;
      return { ...t, fields };
    });
    return changed ? out : types;
  };

  const globals = doc.globals.map((g) => {
    if (g.value === undefined) return g;
    const n = map(g.value, g.type);
    return n === g.value ? g : { ...g, value: n };
  });
  const flows = doc.flows.map((f) => {
    const fp = ports(doc, f.id);
    const nodes = f.nodes.map((node) => {
      if (!node.values) return node;
      const r = fp.nodes.get(node.id);
      if (!r) return node;
      let changed = false;
      const values: Record<string, unknown> = {};
      for (const [port, v] of Object.entries(node.values)) {
        const p = r.inputs.find((x) => x.name === port);
        const n = p ? map(v, p.type) : v;
        if (n !== v) changed = true;
        values[port] = n;
      }
      return changed ? { ...node, values } : node;
    });
    const next = {
      ...f,
      types: mapTypes(f.types),
      inputs: mapDefaults(f.inputs),
      variables: mapDefaults(f.variables),
      nodes,
    };
    const same = next.types === f.types && next.inputs === f.inputs && next.variables === f.variables && nodes.every((n, i) => n === f.nodes[i]);
    return same ? f : next;
  });
  return { ...doc, types: mapTypes(doc.types), globals, flows };
}

/** Visit that renames key `from` → `to` in values of struct `typeId`. */
export function renameStructKey(typeId: string, from: string, to: string): Visit {
  return (value, decl) => {
    if (decl.id !== typeId || !isObject(value) || !(from in value) || from === to) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k === from ? to : k] = v;
    return out;
  };
}

/** Visit that replaces enum member `from` with `to` in values of enum `typeId`. */
export function renameEnumValue(typeId: string, from: string, to: string): Visit {
  return (value, decl) => (decl.id === typeId && value === from ? to : value);
}
