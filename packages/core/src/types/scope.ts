/**
 * Type scopes and name resolution (docs/specs/types.md §3).
 */
import { BriarError } from "../errors.js";
import { findFlow } from "../documents/factories.js";
import type { ContextDocument, TypeDecl } from "../documents/model.js";

/** Where a resolved declaration lives. */
export type TypeOrigin = "local" | "global" | "pack";

/** A declaration plus its origin. */
export interface ScopedTypeDecl {
  decl: TypeDecl;
  origin: TypeOrigin;
}

/** Result of resolving a type name. */
export type ResolveNameResult =
  | { ok: true; decl: TypeDecl; origin: TypeOrigin }
  | { ok: false; code: "type.unknown" | "type.ambiguous"; candidates: readonly string[] };

/**
 * The set of named types visible at one place: local types of one flow (optional), global
 * types, pack types.
 */
export interface TypeScope {
  /** The flow whose local types are visible, if any. */
  readonly flowId: string | undefined;
  /** Looks up a declaration by id (local → global → pack). */
  getType(id: string): ScopedTypeDecl | undefined;
  /**
   * Resolves a name. No dot: local (exact case) → global → pack short name if exactly one
   * pack exports it (else `type.ambiguous`). With a dot: only the pack type with that id.
   */
  resolveName(name: string): ResolveNameResult;
  /** Every visible declaration, local first, then global, then pack (stable order). */
  all(): readonly ScopedTypeDecl[];
}

/** Anything that lists pack types, e.g. a `NodeCatalog`. */
export interface PackTypeSource {
  readonly types: readonly TypeDecl[];
}

/** Sources of a {@link TypeScope}. */
export interface TypeScopeSource {
  localTypes?: readonly TypeDecl[];
  globalTypes?: readonly TypeDecl[];
  packTypes?: readonly TypeDecl[];
  flowId?: string;
}

/**
 * Builds a scope from explicit lists of declarations.
 *
 * @example
 * ```ts
 * const scope = createTypeScope({ globalTypes: doc.types, packTypes: catalog.types });
 * scope.resolveName("Character");
 * ```
 */
export function createTypeScope(source: TypeScopeSource): TypeScope {
  const entries: ScopedTypeDecl[] = [
    ...(source.localTypes ?? []).map((decl) => ({ decl, origin: "local" as const })),
    ...(source.globalTypes ?? []).map((decl) => ({ decl, origin: "global" as const })),
    ...(source.packTypes ?? []).map((decl) => ({ decl, origin: "pack" as const })),
  ];
  const byId = new Map<string, ScopedTypeDecl>();
  for (const entry of entries) if (!byId.has(entry.decl.id)) byId.set(entry.decl.id, entry);
  const flowId = source.flowId;
  return {
    flowId,
    getType: (id) => byId.get(id),
    resolveName(name) {
      if (name.includes(".")) {
        const hit = entries.find((e) => e.origin === "pack" && e.decl.id === name);
        return hit ? { ok: true, decl: hit.decl, origin: "pack" } : { ok: false, code: "type.unknown", candidates: [] };
      }
      for (const origin of ["local", "global"] as const) {
        const hit = entries.find((e) => e.origin === origin && e.decl.name === name);
        if (hit) return { ok: true, decl: hit.decl, origin };
      }
      const packHits = entries.filter((e) => e.origin === "pack" && e.decl.name === name);
      const ids = [...new Set(packHits.map((e) => e.decl.id))];
      if (ids.length === 1 && packHits[0]) return { ok: true, decl: packHits[0].decl, origin: "pack" };
      if (ids.length > 1) return { ok: false, code: "type.ambiguous", candidates: ids };
      return { ok: false, code: "type.unknown", candidates: [] };
    },
    all: () => entries,
  };
}

/**
 * Scope at global level of a context (global types + pack types). Used for global type
 * fields and globals.
 *
 * @example
 * ```ts
 * const scope = scopeForContext(doc, catalog);
 * ```
 */
export function scopeForContext(doc: ContextDocument, packTypes?: PackTypeSource): TypeScope {
  return createTypeScope({ globalTypes: doc.types, packTypes: packTypes?.types ?? [] });
}

/**
 * Scope inside one flow (its local types + global + pack). Throws
 * `BriarError("flow.not_found")` for an unknown flow id.
 *
 * @example
 * ```ts
 * const scope = scopeForFlow(doc, "flow_p", catalog);
 * ```
 */
export function scopeForFlow(
  doc: ContextDocument,
  flowId: string,
  packTypes?: PackTypeSource,
): TypeScope {
  const flow = findFlow(doc, flowId);
  if (!flow) throw flowNotFound(doc, flowId);
  return createTypeScope({ localTypes: flow.types, globalTypes: doc.types, packTypes: packTypes?.types ?? [], flowId });
}

/** Internal: the `flow.not_found` error. */
export function flowNotFound(doc: ContextDocument, flowId: string): BriarError {
  return new BriarError(
    "flow.not_found",
    `Flow "${flowId}" does not exist in context "${doc.name}" (${doc.id}). Check the flow id.`,
    { details: { flowId, contextId: doc.id } },
  );
}
