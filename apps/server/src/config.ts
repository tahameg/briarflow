/**
 * Server configuration from environment variables. Pure: takes the env object, returns a
 * config or throws a `ConfigError` saying which variable is wrong and how to fix it.
 */
import { BriarError } from "@briarflow/core";
import { DEFAULT_CORS_ORIGINS } from "@briarflow/server";

/** Resolved settings of the server app. */
export interface ServerConfig {
  port: number;
  host: string;
  /** Directory holding `briarflow.db`, `vault.key` and `media/`. */
  dataDir: string;
  /**
   * Vault key (`BRIAR_VAULT_KEY`, 64 hex characters). Default: `<dataDir>/vault.key`,
   * created with a random key on first start.
   */
  vaultKey: string | undefined;
  /** Allowed CORS origins; `false` when `BRIAR_CORS_ORIGIN=off`. */
  corsOrigins: readonly string[] | false;
  /** Directory of the built studio, served at `/` when it exists. */
  studioDir: string | undefined;
  /** Python worker to load as a node pack. */
  python: { url: string; token?: string } | undefined;
  /** Add the mock pack (fake LLM / image nodes). Default true. */
  mock: boolean;
  /** Secret names (env vars) that enable the optional provider packs. */
  providerKeys: { anthropic: boolean };
  /**
   * What the studio opens first: a context and optionally a flow, each by id or name
   * (`BRIAR_STUDIO_CONTEXT`, `BRIAR_STUDIO_FLOW`). Missing ones are created at startup.
   */
  studioStart: { context?: string; flow?: string };
}

/** A malformed environment variable. */
export class ConfigError extends BriarError {
  constructor(variable: string, value: string, fix: string) {
    super("config.invalid", `Environment variable ${variable}="${value}" is invalid: ${fix}`, { details: { variable, value } });
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
}

function parseBool(env: Env, name: string, fallback: boolean): boolean {
  const v = nonEmpty(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(name, v, "use true or false.");
}

/**
 * Reads the server configuration.
 *
 * @example
 * ```ts
 * const config = loadConfig(process.env, { defaultStudioDir: "/app/apps/studio/dist" });
 * ```
 */
export function loadConfig(env: Env, defaults: { defaultStudioDir?: string } = {}): ServerConfig {
  const portRaw = nonEmpty(env, "PORT") ?? "3000";
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port > 65_535) throw new ConfigError("PORT", portRaw, "use a port number between 0 and 65535.");

  const corsRaw = nonEmpty(env, "BRIAR_CORS_ORIGIN");
  const corsOrigins =
    corsRaw === undefined
      ? DEFAULT_CORS_ORIGINS
      : corsRaw.toLowerCase() === "off"
        ? false
        : corsRaw.split(",").map((o) => o.trim()).filter((o) => o !== "");

  const pythonUrl = nonEmpty(env, "BRIAR_PYTHON_WORKER_URL");
  const pythonToken = nonEmpty(env, "BRIAR_PYTHON_WORKER_TOKEN");
  const studioRaw = nonEmpty(env, "BRIAR_STUDIO_DIR");
  const startContext = nonEmpty(env, "BRIAR_STUDIO_CONTEXT");
  const startFlow = nonEmpty(env, "BRIAR_STUDIO_FLOW");
  if (startFlow !== undefined && startContext === undefined) {
    throw new ConfigError("BRIAR_STUDIO_FLOW", startFlow, "also set BRIAR_STUDIO_CONTEXT to the context that holds the flow.");
  }

  return {
    port,
    host: nonEmpty(env, "HOST") ?? "127.0.0.1",
    dataDir: nonEmpty(env, "BRIAR_DATA_DIR") ?? "./data",
    vaultKey: nonEmpty(env, "BRIAR_VAULT_KEY"),
    corsOrigins,
    studioDir: studioRaw === "off" ? undefined : (studioRaw ?? defaults.defaultStudioDir),
    python: pythonUrl === undefined ? undefined : pythonToken === undefined ? { url: pythonUrl } : { url: pythonUrl, token: pythonToken },
    mock: parseBool(env, "BRIAR_MOCK_NODES", true),
    providerKeys: { anthropic: nonEmpty(env, "ANTHROPIC_API_KEY") !== undefined },
    studioStart: { ...(startContext !== undefined ? { context: startContext } : {}), ...(startFlow !== undefined ? { flow: startFlow } : {}) },
  };
}

/** True when the host only accepts local connections. */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}
