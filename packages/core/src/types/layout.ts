/**
 * Struct layouts (docs/specs/types.md §1.3): what a struct holds once `extends` is followed.
 * Instance fields come from the root of the chain (an extending struct adds none); static
 * fields are collected along the chain, the nearest value winning.
 */
import type { FieldDecl, StructDecl, TypeDecl } from "../documents/model.js";
import { builtinType } from "./builtins.js";

/** Looks up a struct or enum by id. */
export type DeclResolver = (id: string) => TypeDecl | undefined;

/** A static field and the value it has in one struct. */
export interface StaticField {
  field: FieldDecl;
  value: unknown;
  /** Id of the struct whose declaration gave the value. */
  from: string;
}

/** What a struct holds, with `extends` followed. */
export interface StructLayout {
  /** The struct itself, then what it extends, up to the root. */
  chain: readonly string[];
  /** Id of the root struct (itself when it extends nothing). */
  root: string;
  /** Fields every value holds, in declaration order. */
  fields: readonly FieldDecl[];
  /** Static fields by name, with this struct's values. */
  statics: ReadonlyMap<string, StaticField>;
  /** Every field (instance first, then static) in display order. */
  all: readonly FieldDecl[];
}

/** A problem with a struct's `extends` (reported by validation). */
export interface ExtendsProblem {
  code: "type.extends_unknown" | "type.extends_not_struct" | "type.extends_cycle" | "type.extends_instance_field" | "type.extends_override";
  /** The struct whose declaration is wrong. */
  structId: string;
  field?: string;
  /** The extended id that is missing or wrong. */
  target?: string;
  chain?: readonly string[];
}

/**
 * The layout of a struct, following `extends`. A broken chain (unknown or cyclic base) stops
 * where it breaks: the layout then holds what could be found, and {@link extendsProblems}
 * says what is wrong.
 *
 * @example
 * ```ts
 * structLayout(shortText, resolve).statics.get("maxLength")?.value; // 80
 * ```
 */
export function structLayout(decl: StructDecl, given: DeclResolver): StructLayout {
  const resolve = withBuiltins(given);
  const chain: StructDecl[] = [decl];
  const seen = new Set([decl.id]);
  let current = decl;
  while (current.extends !== undefined) {
    const base = resolve(current.extends);
    if (base?.kind !== "struct" || seen.has(base.id)) break;
    chain.push(base);
    seen.add(base.id);
    current = base;
  }
  const root = chain[chain.length - 1] ?? decl;
  const statics = new Map<string, StaticField>();
  // From the root down, so nearer declarations replace values.
  for (const s of [...chain].reverse()) {
    for (const f of s.fields) {
      if (!f.static) continue;
      const inherited = statics.get(f.name);
      statics.set(f.name, { field: inherited?.field ?? f, value: f.default ?? null, from: s.id });
    }
  }
  const fields = root.fields.filter((f) => !f.static);
  return {
    chain: chain.map((s) => s.id),
    root: root.id,
    fields,
    statics,
    all: [...fields, ...[...statics.values()].map((s) => s.field)],
  };
}

/** Is struct `id` the struct `baseId` or does it extend it (directly or not)? */
export function extendsStruct(id: string, baseId: string, given: DeclResolver): boolean {
  if (id === baseId) return true;
  const resolve = withBuiltins(given);
  const decl = resolve(id);
  if (decl?.kind !== "struct") return false;
  return structLayout(decl, resolve).chain.includes(baseId);
}

/** The id of the root of a struct's `extends` chain (itself without `extends`). */
export function rootOf(id: string, given: DeclResolver): string {
  const resolve = withBuiltins(given);
  const decl = resolve(id);
  return decl?.kind === "struct" ? structLayout(decl, resolve).root : id;
}

/**
 * Problems with a struct's `extends` and its own fields (types.md §1.3): the base must be a
 * known struct, the chain must not loop, an extending struct may only declare static fields, and
 * a static field that an inherited one already has must keep its type.
 */
export function extendsProblems(decl: StructDecl, given: DeclResolver): ExtendsProblem[] {
  if (decl.extends === undefined) return [];
  const resolve = withBuiltins(given);
  const out: ExtendsProblem[] = [];
  const base = resolve(decl.extends);
  if (!base) return [{ code: "type.extends_unknown", structId: decl.id, target: decl.extends }];
  if (base.kind !== "struct") return [{ code: "type.extends_not_struct", structId: decl.id, target: decl.extends }];
  const chain = [decl.id];
  let current: TypeDecl | undefined = base;
  while (current?.kind === "struct") {
    if (chain.includes(current.id)) {
      out.push({ code: "type.extends_cycle", structId: decl.id, chain: [...chain, current.id] });
      return out;
    }
    chain.push(current.id);
    current = current.extends === undefined ? undefined : resolve(current.extends);
  }
  const inherited = structLayout(base, resolve);
  for (const f of decl.fields) {
    if (!f.static) {
      out.push({ code: "type.extends_instance_field", structId: decl.id, field: f.name });
      continue;
    }
    const prior = inherited.statics.get(f.name);
    if (prior && JSON.stringify(prior.field.type) !== JSON.stringify(f.type)) {
      out.push({ code: "type.extends_override", structId: decl.id, field: f.name });
    }
    if (!prior && inherited.fields.some((x) => x.name === f.name)) {
      out.push({ code: "type.extends_instance_field", structId: decl.id, field: f.name });
    }
  }
  return out;
}

/** A resolver that also knows the built-in types (they are in every scope). */
export function withBuiltins(resolve: DeclResolver): DeclResolver {
  return (id) => resolve(id) ?? builtinType(id);
}
