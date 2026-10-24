/**
 * SQLite vault and settings (docs/specs/secrets.md, settings.md). Secret values are
 * encrypted with AES-256-GCM under a 32-byte key kept outside the database.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { assertNewSecret, BriarError, secretNotFound, secretValueProblem } from "@briarflow/core";
import type { JsonValue, NewSecret, SecretInfo, SecretKind, SecretVault, SettingsStore } from "@briarflow/core";

/** Options of {@link SqliteSecretVault}. */
export interface SqliteSecretVaultOptions {
  /** Database file (may be the context store's file) or `":memory:"`. */
  file: string;
  /** 32-byte AES-256 key. Losing it makes stored values unreadable. See {@link loadVaultKey}. */
  key: Uint8Array;
  clock?: () => Date;
}

interface SecretRow {
  name: string;
  kind: SecretKind;
  iv: Buffer;
  tag: Buffer;
  value: Buffer;
  created_at: string;
  updated_at: string;
}

function open(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  if (file !== ":memory:" && file !== "") db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Reads the vault key from `file` (64 hex characters), creating it (mode 0600) with a random
 * key when it does not exist.
 *
 * @example
 * ```ts
 * const vault = new SqliteSecretVault({ file: "./data/briarflow.db", key: loadVaultKey("./data/vault.key") });
 * ```
 */
export function loadVaultKey(file: string): Uint8Array {
  if (!existsSync(file)) {
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return parseVaultKey(readFileSync(file, "utf8"), file);
}

/** A 32-byte key from 64 hex characters (or 44 base64 characters). */
export function parseVaultKey(text: string, where = "the vault key"): Uint8Array {
  const s = text.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (bytes.length !== 32) {
    throw new BriarError("vault.invalid_key", `${where} must hold 32 bytes as 64 hex characters (got ${bytes.length} bytes).`);
  }
  return new Uint8Array(bytes);
}

/**
 * Secrets in SQLite, values encrypted. Implements `SecretVault`: `list` never returns values;
 * `reveal` is for the engine.
 */
export class SqliteSecretVault implements SecretVault {
  readonly #db: Database.Database;
  readonly #key: Buffer;
  readonly #clock: () => Date;

  constructor(options: SqliteSecretVaultOptions) {
    if (!(options.key instanceof Uint8Array) || options.key.length !== 32) {
      throw new BriarError("vault.invalid_key", "SqliteSecretVault needs a 32-byte key (see loadVaultKey).");
    }
    this.#key = Buffer.from(options.key);
    this.#clock = options.clock ?? (() => new Date());
    this.#db = open(options.file);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS vault_secrets (name TEXT PRIMARY KEY, kind TEXT NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, value BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
  }

  async list(): Promise<SecretInfo[]> {
    const rows = this.#db.prepare("SELECT name, kind, created_at, updated_at FROM vault_secrets ORDER BY name").all() as SecretRow[];
    return rows.map(info);
  }

  async create(secret: NewSecret): Promise<SecretInfo> {
    assertNewSecret(secret);
    const now = this.#clock().toISOString();
    const sealed = this.#seal(secret.value);
    const r = this.#db
      .prepare("INSERT OR IGNORE INTO vault_secrets (name, kind, iv, tag, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(secret.name, secret.kind, sealed.iv, sealed.tag, sealed.value, now, now);
    if (r.changes === 0) {
      throw new BriarError("secret.exists", `A secret named "${secret.name}" already exists. Pick another name or change its value.`, { details: { name: secret.name } });
    }
    return { name: secret.name, kind: secret.kind, createdAt: now, updatedAt: now };
  }

  async update(name: string, value: string): Promise<SecretInfo> {
    const row = this.#row(name);
    if (!row) throw secretNotFound(name);
    const problem = secretValueProblem(row.kind, value);
    if (problem) throw new BriarError("secret.invalid", problem, { details: { name } });
    const now = this.#clock().toISOString();
    const sealed = this.#seal(value);
    this.#db.prepare("UPDATE vault_secrets SET iv = ?, tag = ?, value = ?, updated_at = ? WHERE name = ?").run(sealed.iv, sealed.tag, sealed.value, now, name);
    return { ...info(row), updatedAt: now };
  }

  async delete(name: string): Promise<void> {
    if (this.#db.prepare("DELETE FROM vault_secrets WHERE name = ?").run(name).changes === 0) throw secretNotFound(name);
  }

  async reveal(name: string): Promise<{ kind: SecretKind; value: string } | undefined> {
    const row = this.#row(name);
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
      decipher.setAuthTag(row.tag);
      const value = Buffer.concat([decipher.update(row.value), decipher.final()]).toString("utf8");
      return { kind: row.kind, value };
    } catch {
      throw new BriarError("vault.unreadable", `Secret "${name}" cannot be decrypted: the vault key changed. Create the secret again.`, { details: { name } });
    }
  }

  close(): void {
    this.#db.close();
  }

  #row(name: string): SecretRow | undefined {
    if (typeof name !== "string") return undefined;
    return this.#db.prepare("SELECT * FROM vault_secrets WHERE name = ?").get(name) as SecretRow | undefined;
  }

  #seal(value: string): { iv: Buffer; tag: Buffer; value: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv, tag: cipher.getAuthTag(), value: sealed };
  }
}

function info(row: Pick<SecretRow, "name" | "kind" | "created_at" | "updated_at">): SecretInfo {
  return { name: row.name, kind: row.kind, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Settings values in SQLite (JSON per key). */
export class SqliteSettingsStore implements SettingsStore {
  readonly #db: Database.Database;

  constructor(options: { file: string }) {
    this.#db = open(options.file);
    this.#db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  async all(): Promise<Record<string, JsonValue>> {
    const rows = this.#db.prepare("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as JsonValue]));
  }

  async get(key: string): Promise<JsonValue | undefined> {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as JsonValue) : undefined;
  }

  async set(key: string, value: JsonValue | undefined): Promise<void> {
    if (value === undefined) this.#db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.#db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  close(): void {
    this.#db.close();
  }
}
