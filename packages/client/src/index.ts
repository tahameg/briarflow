/**
 * @briarflow/client — typed fetch-based client for the Briarflow REST + SSE API
 * (docs/specs/rest-api.md). Shared package: no `node:*`, no React.
 *
 * @example
 * ```ts
 * import { createBriarClient } from "@briarflow/client";
 * const client = createBriarClient({ baseUrl: "http://localhost:3000/api/v1" });
 * const run = await client.flows.run("flow_p", { topic: "cats" });
 * console.log((await run.result).status);
 * ```
 */
export const PACKAGE_NAME = "@briarflow/client";

export { createBriarClient } from "./client.js";
export type { BriarClient, ContextsApi, FlowsApi, MediaApi, NodeTypesApi, RunsApi } from "./client.js";
export { RemoteRun } from "./remote-run.js";
export {
  AuthError,
  BriarClientError,
  CommandError,
  ConflictError,
  InvalidRequestError,
  InvalidResponseError,
  NetworkError,
  NotFoundError,
  RevisionConflictError,
  RunRejectedError,
  ServerError,
  errorFromResponse,
} from "./errors.js";
export type { BriarClientErrorOptions } from "./errors.js";
export { SseParser, readSse } from "./sse.js";
export type { SseMessage } from "./sse.js";
export type {
  ApplyCommandsInput,
  ApplyCommandsResult,
  BriarClientOptions,
  CancelRunResult,
  Command,
  ContextDiagnostics,
  CreateContextInput,
  CreatedIds,
  FetchLike,
  FlowInfo,
  HeadersOption,
  ListContextsQuery,
  MediaBody,
  NodeTypesInfo,
  PackInfo,
  ReconnectOptions,
  RequestOptions,
  RunFlowOptions,
  RunInfo,
  UploadMediaOptions,
} from "./types.js";
