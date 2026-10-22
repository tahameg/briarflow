import type { Command, CreatedIds } from "@briarflow/authoring";
import type {
  ContextListQuery,
  Diagnostic,
  FlowDocument,
  FlowSignatureSchema,
  NodeDescriptor,
  RunResult,
  RunStatus,
  TypeDecl,
} from "@briarflow/core";

/** An authoring command (docs/specs/commands.md), re-exported from `@briarflow/authoring`. */
export type { Command, CreatedIds } from "@briarflow/authoring";

/** `fetch`-compatible function. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Static headers, or a function called before every request (e.g. to add a fresh token). */
export type HeadersOption = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

/** Options of {@link createBriarClient}. */
export interface BriarClientOptions {
  /** API root including the base path, e.g. `"http://localhost:3000/api/v1"`. */
  baseUrl: string;
  /** Custom fetch (tests, polyfills, auth wrappers). Default: global `fetch`. */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: HeadersOption;
  /** Run event stream reconnection. */
  reconnect?: ReconnectOptions;
}

/** How `RemoteRun` reconnects a dropped event stream. */
export interface ReconnectOptions {
  /** First delay in ms (doubles each consecutive failure). Default 500. */
  initialDelayMs?: number;
  /** Delay cap in ms. Default 10 000. */
  maxDelayMs?: number;
  /** Consecutive failed attempts before giving up. Default 8. Reset whenever an event arrives. */
  maxAttempts?: number;
}

/** Per-call options. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Query of `contexts.list` (same as `ContextStore.list`). */
export type ListContextsQuery = ContextListQuery;

/** Body of `POST /contexts`. */
export interface CreateContextInput {
  name: string;
  description?: string;
  id?: string;
}

/** Body of `POST /contexts/:id/commands`. */
export interface ApplyCommandsInput {
  /** Revision the commands were made against; a mismatch throws `RevisionConflictError`. */
  baseRevision: number;
  /** Non-empty, at most 1000. */
  commands: readonly Command[];
}

/** Response of `POST /contexts/:id/commands`. */
export interface ApplyCommandsResult {
  /** New revision (unchanged when `changed` is false). */
  revision: number;
  changed: boolean;
  /** Per command, in batch order. */
  created: CreatedIds[];
  /** Full `validateContext` output after the batch. */
  diagnostics: Diagnostic[];
}

/** Response of `GET /contexts/:id/diagnostics`. */
export interface ContextDiagnostics {
  revision: number;
  diagnostics: Diagnostic[];
}

/** Response of `GET /flows/:flowId`. */
export interface FlowInfo {
  contextId: string;
  revision: number;
  flow: FlowDocument;
  signature: FlowSignatureSchema;
}

/** Options of `flows.run`. */
export interface RunFlowOptions extends RequestOptions {
  /** Default true (server side). */
  useCache?: boolean;
  /** Wait for the result (server answers with the result if it finishes within `waitMs`). */
  wait?: boolean;
  /** 1–300 000; server default 60 000. Only with `wait`. */
  waitMs?: number;
}

/** Response of `GET /runs/:runId`. */
export interface RunInfo {
  runId: string;
  flowId: string;
  contextId: string;
  status: RunStatus;
  /** ISO timestamp of when the run was started (sent by `@briarflow/server`). */
  createdAt?: string;
  /** Present once terminal. */
  result?: RunResult;
  /** Outcome of applying the run's global-scope writes; absent when there were none. */
  globalWriteStatus?: "applied" | "partial" | "failed";
}

/** Response of `POST /runs/:runId/cancel`. */
export interface CancelRunResult {
  runId: string;
  status: RunStatus;
}

/** A node pack as listed by `GET /node-types`. */
export interface PackInfo {
  name: string;
  version: string;
  title?: string;
}

/** Response of `GET /node-types`. */
export interface NodeTypesInfo {
  packs: PackInfo[];
  nodes: NodeDescriptor[];
  /** Pack types, ids `<pack>.<Name>`. */
  types: TypeDecl[];
}

/** Options of `media.upload`. */
export interface UploadMediaOptions extends RequestOptions {
  /** Mime type sent as `Content-Type`. Default: the Blob's `type`. Required for other bodies. */
  mime?: string;
  filename?: string;
}

/** Body accepted by `media.upload`. */
export type MediaBody = Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
