/**
 * Entry point: `npm start -w @briarflow/server-app` (or `tsx src/main.ts`). Configuration comes
 * from environment variables (see README.md, "Configuration").
 */
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { consoleLogger, startServer } from "./server.js";

const defaultStudioDir = fileURLToPath(new URL("../../studio/dist", import.meta.url));
const logger = consoleLogger(process.env["BRIAR_LOG_LEVEL"] === "debug" ? "debug" : "info");

try {
  const config = loadConfig(process.env, { defaultStudioDir });
  const running = await startServer(config, logger);
  logger.info("server.listening", { url: running.server.url, api: `${running.server.url}/api/v1`, dataDir: config.dataDir, packs: running.packs });
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("server.stopping", { signal });
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error("server.stop_failed", { error: String(err) });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
} catch (err) {
  logger.error("server.start_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
