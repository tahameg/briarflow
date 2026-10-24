/**
 * @briarflow/storage-sqlite — SQLite ContextStore for Briarflow (docs/specs/storage.md),
 * built on `better-sqlite3`. Node only.
 *
 * @example
 * ```ts
 * import { SqliteContextStore } from "@briarflow/storage-sqlite";
 * const store = new SqliteContextStore({ file: "./data/briarflow.db" });
 * ```
 */
export const PACKAGE_NAME = "@briarflow/storage-sqlite";

export { SQLITE_SCHEMA_VERSION, SqliteContextStore } from "./context-store.js";
export type { SqliteContextStoreOptions } from "./context-store.js";
export { SqliteSecretVault, SqliteSettingsStore, loadVaultKey, parseVaultKey } from "./vault.js";
export type { SqliteSecretVaultOptions } from "./vault.js";
