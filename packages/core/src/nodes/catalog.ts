/**
 * Node catalog (docs/specs/node-api.md §7).
 */
import type { TypeDecl } from "../documents/model.js";
import { CatalogError } from "../errors.js";
import type { AnyNodeDefinition } from "./define.js";
import type { NodeDescriptor } from "./descriptor.js";
import { toNodeDescriptor } from "./descriptor.js";
import type { NodePack } from "./pack.js";

/**
 * The loaded packs: resolves node types and pack types. Immutable.
 * `briar.input` / `briar.output` are built into core and are never catalog entries.
 */
export interface NodeCatalog {
  readonly packs: readonly NodePack[];
  /** All pack types, in pack order. */
  readonly types: readonly TypeDecl[];
  /** Definition for a node type, or `undefined`. */
  get(type: string): AnyNodeDefinition | undefined;
  has(type: string): boolean;
  /** Pack that provides a node type. */
  packOf(type: string): NodePack | undefined;
  /** Pack type by qualified id. */
  getType(id: string): TypeDecl | undefined;
  /** Descriptors of every node, in pack then node order. */
  descriptors(): NodeDescriptor[];
}

/**
 * Builds a catalog. Throws `CatalogError` with `catalog.duplicate_pack` (same pack name twice)
 * or `catalog.namespace_conflict` (two packs claim one namespace).
 *
 * @example
 * ```ts
 * const catalog = createCatalog([stdPack, mockPack]);
 * catalog.get("mock.llm");
 * ```
 */
export function createCatalog(packs: readonly NodePack[]): NodeCatalog {
  const names = new Set<string>();
  const namespaceOwner = new Map<string, string>();
  const nodes = new Map<string, { def: AnyNodeDefinition; pack: NodePack }>();
  const typeById = new Map<string, TypeDecl>();
  for (const pack of packs) {
    if (names.has(pack.name)) {
      throw new CatalogError("catalog.duplicate_pack", `Pack "${pack.name}" is loaded twice. Load each pack once.`, {
        details: { pack: pack.name },
      });
    }
    names.add(pack.name);
    for (const ns of pack.namespaces) {
      const owner = namespaceOwner.get(ns);
      if (owner !== undefined) {
        throw new CatalogError(
          "catalog.namespace_conflict",
          `Packs "${owner}" and "${pack.name}" both claim the node-type namespace "${ns}". Remove one of them or rename its namespace.`,
          { details: { namespace: ns, packs: [owner, pack.name] } },
        );
      }
      namespaceOwner.set(ns, pack.name);
    }
    for (const def of pack.nodes) nodes.set(def.type, { def, pack });
    for (const t of pack.types) if (!typeById.has(t.id)) typeById.set(t.id, t);
  }
  const frozenPacks = [...packs];
  const types = frozenPacks.flatMap((p) => p.types);
  return {
    packs: frozenPacks,
    types,
    get: (type) => nodes.get(type)?.def,
    has: (type) => nodes.has(type),
    packOf: (type) => nodes.get(type)?.pack,
    getType: (id) => typeById.get(id),
    descriptors: () => frozenPacks.flatMap((p) => p.nodes.map((def) => toNodeDescriptor(def, p))),
  };
}
