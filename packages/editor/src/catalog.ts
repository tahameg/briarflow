/**
 * Catalog from `GET /node-types` descriptors. The implementation lives in `@briarflow/core`
 * (`createCatalogFromDescriptors`, DECISIONS #58); this module keeps the editor's original
 * names as thin wrappers.
 */
import type { NodeTypesInfo } from "@briarflow/client";
import { createCatalogFromDescriptors } from "@briarflow/core";
import type { CatalogFromDescriptorsOptions, DescriptorCatalog } from "@briarflow/core";

export { definitionFromDescriptor } from "@briarflow/core";

/** Options of {@link catalogFromNodeTypes} (same as core's `CatalogFromDescriptorsOptions`). */
export type CatalogFromNodeTypesOptions = CatalogFromDescriptorsOptions;

/** Result of {@link catalogFromNodeTypes}. */
export interface NodeTypesCatalog {
  catalog: DescriptorCatalog;
  /** Same as `catalog.approximateTypes`. */
  approximateTypes: readonly string[];
}

/**
 * Builds a catalog from node-type descriptors (plus optional local packs).
 *
 * @deprecated Use `createCatalogFromDescriptors` from `@briarflow/core`.
 * @example
 * ```ts
 * const { catalog } = catalogFromNodeTypes(await client.nodeTypes.list(), { localPacks: [stdPack] });
 * ```
 */
export function catalogFromNodeTypes(info: NodeTypesInfo, options: CatalogFromNodeTypesOptions = {}): NodeTypesCatalog {
  const catalog = createCatalogFromDescriptors(info, options);
  return { catalog, approximateTypes: catalog.approximateTypes };
}
