/**
 * @briarflow/nodes-mock — deterministic, offline fake AI nodes (pack `mock`) for tests and
 * demos. See docs/specs/node-api.md §10.
 *
 * @example
 * ```ts
 * import { createCatalog } from "@briarflow/core";
 * import { stdPack } from "@briarflow/nodes-std";
 * import { mockPack } from "@briarflow/nodes-mock";
 * const catalog = createCatalog([stdPack, mockPack]);
 * ```
 */
import { definePack, type NodePack } from "@briarflow/core";
import { mockDelay, mockFail, mockFlaky, mockImage, mockLlm, mockModel3d, mockStructured } from "./nodes.js";

export const PACKAGE_NAME = "@briarflow/nodes-mock";

export { mockDelay, mockFail, mockFlaky, mockImage, mockLlm, mockModel3d, mockStructured } from "./nodes.js";
export { mockHash } from "./util.js";

/**
 * The mock pack (`mock`, version 0.1.0): `mock.llm`, `mock.structured`, `mock.image`,
 * `mock.model3d`, `mock.delay`, `mock.flaky`, `mock.fail`.
 *
 * @example
 * ```ts
 * const catalog = createCatalog([stdPack, mockPack]);
 * ```
 */
export const mockPack: NodePack = definePack({
  name: "mock",
  version: "0.1.0",
  title: "Mock nodes",
  description: "Deterministic, offline stand-ins for AI providers. For tests and demos.",
  nodes: [mockLlm, mockStructured, mockImage, mockModel3d, mockDelay, mockFlaky, mockFail],
});
