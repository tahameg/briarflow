/**
 * @briarflow/editor — headless, framework-agnostic editor store for Briarflow contexts
 * (docs/ARCHITECTURE.md §7.3). Shared package: no React, no `node:*`.
 *
 * @example
 * ```ts
 * import { createBriarClient } from "@briarflow/client";
 * import { clientBackend, createEditorStore } from "@briarflow/editor";
 * const client = createBriarClient({ baseUrl: "http://localhost:3000/api/v1" });
 * const store = createEditorStore({ backend: clientBackend(client), contextId: "ctx_1" });
 * await store.ready;
 * store.dispatch({ op: "flow.create", name: "Portrait" });
 * ```
 */
export const PACKAGE_NAME = "@briarflow/editor";

export { createEditorStore, isRunFinished } from "./store.js";
export { clientBackend, isCommandRejection, isRevisionConflict } from "./backend.js";
export type { BackendApplyInput, BackendApplyResult, BackendRunOptions, EditorBackend } from "./backend.js";
export { catalogFromNodeTypes, definitionFromDescriptor } from "./catalog.js";
export type { CatalogFromNodeTypesOptions, NodeTypesCatalog } from "./catalog.js";
export { createCatalogFromDescriptors } from "@briarflow/core";
export type { DescriptorCatalog } from "@briarflow/core";
export { completeRun, reduceRunEvent } from "./run-state.js";
export type { EditorRunStatus, NodeRunState, NodeRunStatus, RunState } from "./run-state.js";
export type {
  CommandApplier,
  EditorListener,
  EditorNotice,
  EditorNoticeKind,
  EditorState,
  EditorStatus,
  EditorStore,
  EditorStoreOptions,
  HistoryState,
  SelectMode,
  Selection,
  StartRunOptions,
  SyncState,
} from "./types.js";
