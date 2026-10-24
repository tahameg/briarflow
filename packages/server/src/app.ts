/**
 * `createBriarApp`: the REST + SSE API over a facade instance (rest-api.md, phase-5.md §3–§4).
 */
import { BriarError, noopLogger, type Logger } from "@briarflow/core";
import type { Briar } from "briarflow";
import { Hono, type Env } from "hono";
import { cors } from "hono/cors";
import type { AuthorizeRequest } from "./authorize.js";
import { briarError, setRequestLogger } from "./errors.js";
import { createRouteKit } from "./kit.js";
import { registerContextRoutes } from "./routes/contexts.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerNodeTypeRoutes } from "./routes/node-types.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSecretRoutes } from "./routes/secrets.js";

/** CORS settings of {@link createBriarApp}. */
export interface BriarCorsOptions {
  /** Allowed origins: one, a list, or a predicate. */
  origin: string | readonly string[] | ((origin: string) => boolean);
  /** Default false. */
  credentials?: boolean;
}

/** Options of {@link createBriarApp}. Every field is optional. */
export interface BriarAppOptions<E extends Env = Env> {
  /** Prefix of every built-in route. Default "/api/v1". "" mounts at the root. */
  basePath?: string;
  /**
   * CORS. Default `{ origin: ["http://localhost:5173", "http://127.0.0.1:5173"] }` (the studio
   * dev server). `false` sends no CORS headers (same-origin deployments).
   */
  cors?: false | BriarCorsOptions;
  /** Called once per request after id resolution. Default: everything allowed. */
  authorize?: (req: AuthorizeRequest<E>) => boolean | Promise<boolean>;
  /** JSON body limit in bytes → 413 `request.too_large`. Default 5 * 1024 * 1024. */
  maxBodyBytes?: number;
  /** Media upload limit in bytes → 413 `media.too_large`. Default 50 * 1024 * 1024. */
  maxUploadBytes?: number;
  /** SSE keep-alive comment interval. Default 15 000 ms. */
  pingIntervalMs?: number;
  /** Server-side log of 500s and dropped streams. Default `noopLogger`. */
  logger?: Logger;
}

/** Default CORS origins: the studio's Vite dev server. */
export const DEFAULT_CORS_ORIGINS: readonly string[] = ["http://localhost:5173", "http://127.0.0.1:5173"];

function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined) return "/api/v1";
  const trimmed = basePath.replace(/\/+$/, "");
  if (trimmed === "") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function corsOrigin(origin: BriarCorsOptions["origin"]): (requestOrigin: string) => string | null {
  if (typeof origin === "function") return (o) => (o !== "" && origin(o) ? o : null);
  const list = typeof origin === "string" ? [origin] : origin;
  if (list.includes("*")) return () => "*";
  return (o) => (list.includes(o) ? o : null);
}

/**
 * Builds the REST + SSE API over a facade instance. Returns a normal Hono app: add routes to
 * it (absolute paths; include the base path yourself) or mount it in your own app.
 *
 * @example
 * ```ts
 * const briar = createBriar({ packs: [mockPack] });
 * const app = createBriarApp(briar, { authorize: ({ c }) => Boolean(c.get("user")) });
 * const server = await serve(app, { port: 3000 });
 * ```
 */
export function createBriarApp<E extends Env = Env>(briar: Briar, options: BriarAppOptions<E> = {}): Hono<E> {
  const base = normalizeBasePath(options.basePath);
  const logger = options.logger ?? noopLogger;
  const app = new Hono<E>();

  app.use("*", async (c, next) => {
    setRequestLogger(c.req.raw, logger);
    await next();
  });

  if (options.cors !== false) {
    const corsOptions = options.cors ?? { origin: DEFAULT_CORS_ORIGINS };
    app.use(
      base === "" ? "*" : `${base}/*`,
      cors({
        origin: corsOrigin(corsOptions.origin),
        credentials: corsOptions.credentials ?? false,
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        exposeHeaders: ["Location", "ETag", "Content-Disposition"],
        maxAge: 600,
      }),
    );
  }

  const kit = createRouteKit<E>({
    app,
    briar,
    base,
    maxBodyBytes: options.maxBodyBytes ?? 5 * 1024 * 1024,
    maxUploadBytes: options.maxUploadBytes ?? 50 * 1024 * 1024,
    pingIntervalMs: options.pingIntervalMs ?? 15_000,
    logger,
    authorize: options.authorize,
  });
  registerContextRoutes(kit);
  registerRunRoutes(kit);
  registerNodeTypeRoutes(kit);
  registerMediaRoutes(kit);
  registerSecretRoutes(kit);

  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    return briarError(
      c,
      new BriarError("route.not_found", `No route for ${c.req.method} ${path}. See docs/specs/rest-api.md.`, {
        details: { method: c.req.method, path },
      }),
    );
  });
  app.onError((err, c) => briarError(c, err));
  return app;
}
