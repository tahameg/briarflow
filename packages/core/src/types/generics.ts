/**
 * Generic binding (docs/specs/types.md §5).
 */
import { canonicalJson } from "../util/json.js";
import { isAssignable, stripConstraints, typeEquals } from "./assignability.js";
import type { TypeRef } from "./ir.js";
import { containsVar } from "./walk.js";

/** Generic var name → bound type. Stored as `NodeInstance.typeBindings`. */
export type TypeBindings = Record<string, TypeRef>;

/**
 * One connected port of a generic node. For an input, `other` is the type of the feeding
 * output (gives candidates); for an output, `other` is the type of the fed input (gives upper
 * bounds). `other` containing an unbound var of the neighbour must be left out by the caller.
 */
export interface GenericConnection {
  port: string;
  direction: "input" | "output";
  /** The port's declared type, containing vars. */
  pattern: TypeRef;
  /** The concrete type at the other end of the edge. */
  other: TypeRef;
}

/**
 * A failed binding: `{node} already uses T = bound; port would need T = other`, or, with
 * `allowed`, `port` got `other`, which is none of the var's `oneOf` types.
 */
export interface BindingConflict {
  varName: string;
  port: string;
  bound: TypeRef;
  other: TypeRef;
  allowed?: TypeRef[];
}

/** Result of {@link bindTypeVars}. Vars with no constraint are absent from `bindings`. */
export type BindTypeVarsResult =
  | { ok: true; bindings: TypeBindings }
  | { ok: false; conflict: BindingConflict };

interface Bound {
  port: string;
  type: TypeRef;
}

/**
 * Computes bindings from the connected ports (pattern match → join of lower bounds, else meet
 * of upper bounds → check against upper bounds → constraints dropped). Independent of order.
 *
 * @example
 * ```ts
 * bindTypeVars([{ port: "list", direction: "input",
 *   pattern: { kind: "list", of: { kind: "var", name: "T" } },
 *   other: { kind: "list", of: { kind: "named", id: "ty_char" } } }]);
 * // { ok: true, bindings: { T: { kind: "named", id: "ty_char" } } }
 * ```
 */
export function bindTypeVars(connections: readonly GenericConnection[]): BindTypeVarsResult {
  const r = bindTypeVarsAll(connections);
  const first = r.conflicts[0];
  if (first) return { ok: false, conflict: first };
  return { ok: true, bindings: r.bindings };
}

/**
 * Internal: like {@link bindTypeVars} but reports every conflict and still returns the
 * bindings of vars without conflict (conflicting vars stay unbound).
 */
export function bindTypeVarsAll(connections: readonly GenericConnection[]): {
  bindings: TypeBindings;
  conflicts: BindingConflict[];
} {
  const sorted = [...connections].sort((a, b) => {
    const ka = `${a.direction === "input" ? 0 : 1}\u0000${a.port}\u0000${canonicalJson(a.other)}`;
    const kb = `${b.direction === "input" ? 0 : 1}\u0000${b.port}\u0000${canonicalJson(b.other)}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const lower = new Map<string, Bound[]>();
  const upper = new Map<string, Bound[]>();
  const order: string[] = [];
  const allowed = new Map<string, TypeRef[]>();
  for (const c of sorted) collectOneOf(c.pattern, allowed);
  for (const c of sorted) {
    if (containsVar(c.other)) continue;
    const found = new Map<string, TypeRef[]>();
    match(c.pattern, stripConstraints(c.other), found);
    for (const [name, types] of found) {
      if (!order.includes(name)) order.push(name);
      const target = c.direction === "input" ? lower : upper;
      const list = target.get(name) ?? [];
      for (const type of types) list.push({ port: c.port, type });
      target.set(name, list);
    }
  }
  const bindings: TypeBindings = {};
  const conflicts: BindingConflict[] = [];
  for (const name of order) {
    const lows = lower.get(name) ?? [];
    const ups = upper.get(name) ?? [];
    let binding: TypeRef | undefined;
    let conflict: BindingConflict | undefined;
    const combine = lows.length > 0 ? joinTypes : meetTypes;
    for (const b of lows.length > 0 ? lows : ups) {
      if (binding === undefined) {
        binding = b.type;
        continue;
      }
      const next = combine(binding, b.type);
      if (next === undefined) {
        conflict = { varName: name, port: b.port, bound: binding, other: b.type };
        break;
      }
      binding = next;
    }
    if (!conflict && binding !== undefined) {
      for (const u of ups) {
        if (!isAssignable(binding, u.type)) {
          conflict = { varName: name, port: u.port, bound: binding, other: u.type };
          break;
        }
      }
    }
    const oneOf = allowed.get(name);
    if (!conflict && binding !== undefined && oneOf && !oneOf.some((o) => isAssignable(binding!, o))) {
      const port = (lows.length > 0 ? lows : ups)[0]?.port ?? "";
      conflict = { varName: name, port, bound: binding, other: binding, allowed: oneOf };
    }
    if (conflict) conflicts.push(conflict);
    else if (binding !== undefined) bindings[name] = binding;
  }
  return { bindings, conflicts };
}

/** `oneOf` limits of the vars in a pattern, by var name. */
export function collectOneOf(type: TypeRef, out: Map<string, TypeRef[]> = new Map()): Map<string, TypeRef[]> {
  switch (type.kind) {
    case "var":
      if (type.oneOf && !out.has(type.name)) out.set(type.name, type.oneOf);
      break;
    case "list":
    case "optional":
      collectOneOf(type.of, out);
      break;
    default:
      break;
  }
  return out;
}

function match(pattern: TypeRef, other: TypeRef, out: Map<string, TypeRef[]>): void {
  switch (pattern.kind) {
    case "var": {
      const list = out.get(pattern.name) ?? [];
      list.push(other);
      out.set(pattern.name, list);
      return;
    }
    case "list":
      if (other.kind === "list") match(pattern.of, other.of, out);
      return;
    case "optional":
      if (other.kind === "optional") match(pattern.of, other.of, out);
      else match(pattern.of, other, out);
      return;
    default:
      // Concrete pattern or mismatch: no candidate. The caller checks assignability of the
      // substituted port type against the other end.
      return;
  }
}

/** Replaces bound vars; unbound vars stay as `var`. `T?` with `T = X?` gives `X?`. */
export function substituteTypeVars(type: TypeRef, bindings: TypeBindings): TypeRef {
  switch (type.kind) {
    case "var":
      return Object.prototype.hasOwnProperty.call(bindings, type.name) ? (bindings[type.name] as TypeRef) : type;
    case "list":
      return { ...type, of: substituteTypeVars(type.of, bindings) };
    case "optional": {
      const of = substituteTypeVars(type.of, bindings);
      return of.kind === "optional" ? of : { kind: "optional", of };
    }
    default:
      return type;
  }
}

/** Names of vars in a type, in order of first appearance, without duplicates. */
export function collectTypeVars(type: TypeRef, out: string[] = []): string[] {
  switch (type.kind) {
    case "var":
      if (!out.includes(type.name)) out.push(type.name);
      break;
    case "list":
    case "optional":
      collectTypeVars(type.of, out);
      break;
    default:
      break;
  }
  return out;
}

/** Least upper bound (`join(int, float) = float`, `join(X, X?) = X?`), or `undefined`. */
export function joinTypes(a: TypeRef, b: TypeRef): TypeRef | undefined {
  a = stripConstraints(a);
  b = stripConstraints(b);
  if (containsVar(a) || containsVar(b)) return undefined;
  if (typeEquals(a, b)) return a;
  if (a.kind === "optional" || b.kind === "optional") {
    const ia = a.kind === "optional" ? a.of : a;
    const ib = b.kind === "optional" ? b.of : b;
    const inner = joinTypes(ia, ib);
    return inner === undefined ? undefined : { kind: "optional", of: inner };
  }
  if (a.kind === "primitive" && b.kind === "primitive") {
    const names = [a.name, b.name].sort().join(",");
    return names === "float,int" ? { kind: "primitive", name: "float" } : undefined;
  }
  if (a.kind === "list" && b.kind === "list") {
    const of = joinTypes(a.of, b.of);
    return of === undefined ? undefined : { kind: "list", of };
  }
  return undefined;
}

/** Greatest lower bound (`meet(int, float) = int`, `meet(X?, X) = X`), or `undefined`. */
export function meetTypes(a: TypeRef, b: TypeRef): TypeRef | undefined {
  a = stripConstraints(a);
  b = stripConstraints(b);
  if (containsVar(a) || containsVar(b)) return undefined;
  if (typeEquals(a, b)) return a;
  if (a.kind === "optional" && b.kind === "optional") {
    const inner = meetTypes(a.of, b.of);
    return inner === undefined ? undefined : { kind: "optional", of: inner };
  }
  if (a.kind === "optional") return meetTypes(a.of, b);
  if (b.kind === "optional") return meetTypes(a, b.of);
  if (a.kind === "primitive" && b.kind === "primitive") {
    const names = [a.name, b.name].sort().join(",");
    return names === "float,int" ? { kind: "primitive", name: "int" } : undefined;
  }
  if (a.kind === "list" && b.kind === "list") {
    const of = meetTypes(a.of, b.of);
    return of === undefined ? undefined : { kind: "list", of };
  }
  return undefined;
}
