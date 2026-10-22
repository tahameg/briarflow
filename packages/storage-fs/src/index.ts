/**
 * @briarflow/storage-fs — File-system ContextStore and MediaStore for Briarflow
 * (docs/specs/storage.md). Node only.
 *
 * @example
 * ```ts
 * import { FsContextStore, FsMediaStore } from "@briarflow/storage-fs";
 * const store = new FsContextStore({ dir: "./data/contexts" });
 * const media = new FsMediaStore({ dir: "./data/media" });
 * ```
 */
export const PACKAGE_NAME = "@briarflow/storage-fs";

export { FsContextStore } from "./context-store.js";
export type { FsContextStoreOptions } from "./context-store.js";
export { FsMediaStore } from "./media-store.js";
export type { FsMediaStoreOptions } from "./media-store.js";
