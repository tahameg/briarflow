/**
 * @briarflow/server — the REST + SSE API over the `briarflow` facade (docs/specs/rest-api.md,
 * docs/tasks/phase-5.md). `createBriarApp` returns a Hono app that runs on any runtime
 * (`app.fetch`); `serve` runs it on Node.
 *
 * @example
 * ```ts
 * import { createBriar } from "briarflow";
 * import { mockPack } from "@briarflow/nodes-mock";
 * import { createBriarApp, serve } from "@briarflow/server";
 *
 * const briar = createBriar({ packs: [mockPack] });
 * const app = createBriarApp(briar);
 * app.get("/health", (c) => c.text("ok"));
 * const server = await serve(app, { port: 3000 });
 * ```
 */
export const PACKAGE_NAME = "@briarflow/server";

export { DEFAULT_CORS_ORIGINS, createBriarApp } from "./app.js";
export type { BriarAppOptions, BriarCorsOptions } from "./app.js";
export type { AuthorizeAction, AuthorizeRequest, AuthorizeResource } from "./authorize.js";
export { UnauthorizedError, briarError, errorStatus } from "./errors.js";
export { serve } from "./serve.js";
export type { BriarServer, FetchApp, ServeOptions } from "./serve.js";
