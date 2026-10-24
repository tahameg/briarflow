/**
 * The secret vault (docs/specs/secrets.md): named secrets the user creates once. The value
 * goes to the server and never comes back: `list` gives names and kinds only, and only the
 * engine calls `reveal` when a node reads a secret it was given.
 */
import { BriarError } from "../errors.js";
import type { SecretKind } from "../types/ir.js";
import { SECRET_KINDS } from "../types/ir.js";
import { isValidSecretName } from "../util/names.js";

/** What anyone may know about a secret. */
export interface SecretInfo {
  name: string;
  kind: SecretKind;
  /** ISO times. */
  createdAt: string;
  updatedAt: string;
}

/** A new secret. */
export interface NewSecret {
  name: string;
  kind: SecretKind;
  value: string;
}

/**
 * Where secrets live. Implementations keep values out of every listing and should store them
 * encrypted. Errors: `secret.invalid` (bad name, kind or value), `secret.exists`,
 * `secret.not_found`.
 */
export interface SecretVault {
  /** Names and kinds, sorted by name. Never values. */
  list(): Promise<SecretInfo[]>;
  create(secret: NewSecret): Promise<SecretInfo>;
  /** Replaces the value; the kind stays. */
  update(name: string, value: string): Promise<SecretInfo>;
  delete(name: string): Promise<void>;
  /** The value, for the engine only. `undefined` when there is no such secret. */
  reveal(name: string): Promise<{ kind: SecretKind; value: string } | undefined>;
}

/**
 * What is wrong with a new secret, or `undefined`. Numbers must read as a finite number,
 * json must parse, every value must be non-empty.
 *
 * @example
 * ```ts
 * secretProblem({ name: "OPENAI_KEY", kind: "apiKey", value: "sk-…" }); // undefined
 * ```
 */
export function secretProblem(secret: { name?: unknown; kind?: unknown; value?: unknown }): string | undefined {
  if (typeof secret.name !== "string" || !isValidSecretName(secret.name)) {
    return "A secret name starts with a letter or _ and uses letters, digits, _, . and - (at most 64 characters).";
  }
  if (!(SECRET_KINDS as readonly unknown[]).includes(secret.kind)) return `A secret kind is one of ${SECRET_KINDS.join(", ")}.`;
  return secretValueProblem(secret.kind as SecretKind, secret.value);
}

/** What is wrong with a value for a secret of `kind`, or `undefined`. */
export function secretValueProblem(kind: SecretKind, value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return "The secret value must be non-empty text.";
  if (value.length > 65_536) return "The secret value is longer than 64 KiB.";
  if (kind === "number" && (value.trim() === "" || !Number.isFinite(Number(value)))) return `A number secret must hold a number, not "${value.length > 20 ? "…" : value}".`;
  if (kind === "json") {
    try {
      JSON.parse(value);
    } catch (err) {
      return `A json secret must hold valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return undefined;
}

/** Throws `secret.invalid` for a bad new secret. */
export function assertNewSecret(secret: NewSecret): void {
  const problem = secretProblem(secret);
  if (problem) throw new BriarError("secret.invalid", problem, { details: { name: typeof secret.name === "string" ? secret.name : null } });
}

/** `secret.not_found` for `name`. */
export function secretNotFound(name: string): BriarError {
  return new BriarError("secret.not_found", `There is no secret "${name}" in the vault. Create it in Secrets, or pick another one.`, { details: { name } });
}

/**
 * A vault in memory (tests, scripts; values are lost on exit).
 *
 * @example
 * ```ts
 * const vault = createMemoryVault();
 * await vault.create({ name: "OPENAI_KEY", kind: "apiKey", value: "sk-…" });
 * ```
 */
export function createMemoryVault(options: { clock?: () => Date } = {}): SecretVault {
  const clock = options.clock ?? (() => new Date());
  const items = new Map<string, SecretInfo & { value: string }>();
  const info = ({ value: _value, ...rest }: SecretInfo & { value: string }): SecretInfo => ({ ...rest });
  return {
    async list() {
      return [...items.values()].map(info).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async create(secret) {
      assertNewSecret(secret);
      if (items.has(secret.name)) throw new BriarError("secret.exists", `A secret named "${secret.name}" already exists. Pick another name or change its value.`, { details: { name: secret.name } });
      const now = clock().toISOString();
      const item = { name: secret.name, kind: secret.kind, value: secret.value, createdAt: now, updatedAt: now };
      items.set(secret.name, item);
      return info(item);
    },
    async update(name, value) {
      const item = items.get(name);
      if (!item) throw secretNotFound(name);
      const problem = secretValueProblem(item.kind, value);
      if (problem) throw new BriarError("secret.invalid", problem, { details: { name } });
      const next = { ...item, value, updatedAt: clock().toISOString() };
      items.set(name, next);
      return info(next);
    },
    async delete(name) {
      if (!items.delete(name)) throw secretNotFound(name);
    },
    async reveal(name) {
      const item = items.get(name);
      return item ? { kind: item.kind, value: item.value } : undefined;
    },
  };
}
