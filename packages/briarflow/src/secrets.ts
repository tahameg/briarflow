/**
 * Secret resolvers. Portable: `envSecrets` reads `globalThis.process?.env` when it exists and
 * never imports Node modules.
 */
import type { SecretResolver } from "@briarflow/core";

/** Options of {@link envSecrets}. */
export interface EnvSecretsOptions {
  /** Prepended to every name: `envSecrets({ prefix: "BRIAR_" }).get("OPENAI_API_KEY")` reads `BRIAR_OPENAI_API_KEY`. */
  prefix?: string;
  /** Variables to read. Default: `process.env` (Node, Bun, Deno with node compat); `{}` when there is none. */
  env?: Readonly<Record<string, string | undefined>>;
}

function processEnv(): Readonly<Record<string, string | undefined>> {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env ?? {};
}

/**
 * Reads secrets from environment variables. Empty values count as missing. The environment is
 * read on every `get`, so variables set later are seen.
 *
 * @example
 * ```ts
 * const briar = createBriar({ secrets: envSecrets() });            // OPENAI_API_KEY
 * const prefixed = envSecrets("BRIAR_");                           // BRIAR_OPENAI_API_KEY
 * ```
 */
export function envSecrets(options: string | EnvSecretsOptions = {}): SecretResolver {
  const opts: EnvSecretsOptions = typeof options === "string" ? { prefix: options } : options;
  const prefix = opts.prefix ?? "";
  return {
    async get(name: string): Promise<string | undefined> {
      const value = (opts.env ?? processEnv())[prefix + name];
      return value === undefined || value === "" ? undefined : value;
    },
  };
}

/**
 * Secrets from a fixed object (tests, scripts).
 *
 * @example
 * ```ts
 * const briar = createBriar({ secrets: staticSecrets({ OPENAI_API_KEY: "sk-test" }) });
 * ```
 */
export function staticSecrets(values: Readonly<Record<string, string>>): SecretResolver {
  const copy = { ...values };
  return {
    async get(name: string): Promise<string | undefined> {
      return Object.prototype.hasOwnProperty.call(copy, name) ? copy[name] : undefined;
    },
  };
}

/** A resolver without secrets: every `get` gives `undefined`. */
export const noSecrets: SecretResolver = {
  async get(): Promise<string | undefined> {
    return undefined;
  },
};
