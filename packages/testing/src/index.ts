/**
 * @briarflow/testing — conformance suites, fixtures and test helpers for Briarflow and its
 * extensions.
 *
 * Shared fixtures (documents, test packs, an in-memory media store, value tables), the
 * conformance suites `describeContextStore`, `describeMediaStore`, `describeNodePack`, and
 * `runNode` (one node with a fake ExecContext).
 *
 * @example
 * ```ts
 * import { portraitContext, testCatalog } from "@briarflow/testing";
 * const diagnostics = validateContext(portraitContext(), testCatalog());
 * ```
 */
export const PACKAGE_NAME = "@briarflow/testing";

export * from "./fixtures/index.js";
export * from "./run-node.js";
export * from "./conformance/context-store.js";
export * from "./conformance/media-store.js";
export * from "./conformance/node-pack.js";
