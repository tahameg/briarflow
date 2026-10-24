/**
 * Builds and starts the Briarflow server from a {@link ServerConfig}: SQLite contexts and
 * filesystem media under the data dir, std + image + mock packs, optional Python and provider packs,
 * the REST + SSE API, `/health`, the studio start target (`/api/studio`) and the studio UI with
 * SPA fallback.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Logger, LogData, NodePack } from "@briarflow/core";
import { imagePack } from "@briarflow/nodes-image";
import { mockPack } from "@briarflow/nodes-mock";
import { createBriarApp, serve, type BriarServer } from "@briarflow/server";
import { FsMediaStore } from "@briarflow/storage-fs";
import { SqliteContextStore, SqliteSecretVault, SqliteSettingsStore, loadVaultKey, parseVaultKey } from "@briarflow/storage-sqlite";
import { createBriar, envSecrets, type Briar } from "briarflow";
import { serveStatic } from "@hono/node-server/serve-static";
import { isLoopback, type ServerConfig } from "./config.js";
import { loadProviderPacks } from "./providers.js";
import { ensureStudioStart } from "./studio.js";

/** A running server app. */
export interface RunningServer {
  briar: Briar;
  server: BriarServer;
  /** Names of the loaded node packs. */
  packs: string[];
  /** Stops the HTTP server, then the facade (runs, packs, stores). Idempotent. */
  close(): Promise<void>;
}

/** A logger writing one JSON line per entry to stderr (warn/error) or stdout. */
export function consoleLogger(minLevel: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const order = ["debug", "info", "warn", "error"] as const;
  const log = (level: (typeof order)[number]) => (message: string, data?: LogData) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...(data ? { data } : {}) });
    (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") };
}

/**
 * Starts the server.
 *
 * @example
 * ```ts
 * const running = await startServer(loadConfig(process.env), consoleLogger());
 * console.log(running.server.url);
 * ```
 */
export async function startServer(config: ServerConfig, logger: Logger): Promise<RunningServer> {
  const dataDir = resolve(config.dataDir);
  mkdirSync(join(dataDir, "media"), { recursive: true });

  const packs: NodePack[] = [imagePack];
  if (config.mock) packs.push(mockPack);
  if (config.python) {
    // Loaded lazily: only deployments with a worker need the bridge. `briar.close()` closes it.
    const { pythonPack } = await import("@briarflow/python");
    packs.push(await pythonPack(config.python));
  }
  packs.push(...loadProviderPacks(config));

  const dbFile = join(dataDir, "briarflow.db");
  const vaultKey = config.vaultKey !== undefined ? parseVaultKey(config.vaultKey, "BRIAR_VAULT_KEY") : loadVaultKey(join(dataDir, "vault.key"));
  const briar = createBriar({
    store: new SqliteContextStore({ file: dbFile }),
    media: new FsMediaStore({ dir: join(dataDir, "media") }),
    secrets: envSecrets(),
    vault: new SqliteSecretVault({ file: dbFile, key: vaultKey }),
    settings: new SqliteSettingsStore({ file: dbFile }),
    packs,
    logger,
  });

  const app = createBriarApp(briar, {
    cors: config.corsOrigins === false ? false : { origin: config.corsOrigins },
    logger,
  });
  app.get("/health", (c) => c.text("ok"));
  const studioStart = await ensureStudioStart(briar, config.studioStart, logger);
  app.get("/api/studio", (c) => c.json(studioStart));

  if (config.studioDir !== undefined && existsSync(join(config.studioDir, "index.html"))) {
    const root = relative(process.cwd(), resolve(config.studioDir)) || ".";
    const assets = serveStatic({ root });
    const spaIndex = serveStatic({ path: join(root, "index.html") });
    app.get(
      "*",
      async (c, next) => (c.req.path === "/api" || c.req.path.startsWith("/api/") ? c.notFound() : next()),
      assets,
      spaIndex,
    );
  }

  const server = await serve(app, { port: config.port, hostname: config.host });
  if (!isLoopback(config.host)) {
    logger.warn("server.no_authorize", {
      host: config.host,
      hint: "The API is open to anyone who can reach this host. Put it behind a proxy with auth, or embed @briarflow/server with an authorize hook.",
    });
  }

  let closing: Promise<void> | undefined;
  return {
    briar,
    server,
    packs: ["briar", ...packs.map((p) => p.name)],
    close() {
      closing ??= (async () => {
        await server.close();
        await briar.close();
      })();
      return closing;
    },
  };
}
