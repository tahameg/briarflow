import type { ContextDocument, ContextSummary, MediaRef, Page, RunResult, RunStatus } from "@briarflow/core";
import { InvalidRequestError } from "./errors.js";
import { Http, readJson, seg } from "./http.js";
import { DEFAULT_RECONNECT, RemoteRun } from "./remote-run.js";
import type {
  ApplyCommandsInput,
  ApplyCommandsResult,
  BriarClientOptions,
  CancelRunResult,
  ContextDiagnostics,
  CreateContextInput,
  FlowInfo,
  ListContextsQuery,
  MediaBody,
  NodeTypesInfo,
  RequestOptions,
  RunFlowOptions,
  RunInfo,
  UploadMediaOptions,
} from "./types.js";

/** Context endpoints. */
export interface ContextsApi {
  /** One page of summaries (`GET /contexts`). */
  list(query?: ListContextsQuery, options?: RequestOptions): Promise<Page<ContextSummary>>;
  /** Every summary, fetching pages lazily (`limit` = page size). */
  iterate(query?: Omit<ListContextsQuery, "cursor">, options?: RequestOptions): AsyncIterable<ContextSummary>;
  /** Creates a context (revision 0, no flows). `409 context.exists` → `ConflictError`. */
  create(input: CreateContextInput, options?: RequestOptions): Promise<ContextDocument>;
  /** Full document. Unknown → `NotFoundError` (`context.not_found`). */
  get(contextId: string, options?: RequestOptions): Promise<ContextDocument>;
  /** Deletes a context. */
  delete(contextId: string, options?: RequestOptions): Promise<void>;
  /**
   * Applies a command batch. Throws `RevisionConflictError` (409) when `baseRevision` is stale
   * and `CommandError` (422, with `commandIndex` / `op`) when a command is rejected.
   */
  apply(contextId: string, input: ApplyCommandsInput, options?: RequestOptions): Promise<ApplyCommandsResult>;
  /** Validation findings of the stored document. */
  diagnostics(contextId: string, options?: RequestOptions): Promise<ContextDiagnostics>;
}

/** Flow endpoints. */
export interface FlowsApi {
  /** Flow document, owning context, revision and signature (JSON Schema). */
  get(flowId: string, options?: RequestOptions): Promise<FlowInfo>;
  /**
   * Starts a run. Invalid inputs / flow → `RunRejectedError` (422). With `wait`, the returned
   * run is already finished if the server finished it within `waitMs`.
   */
  run(flowId: string, inputs?: Record<string, unknown>, options?: RunFlowOptions): Promise<RemoteRun>;
}

/** Run endpoints. */
export interface RunsApi {
  /** Status and (once terminal) result. Unknown or evicted → `NotFoundError`. */
  get(runId: string, options?: RequestOptions): Promise<RunInfo>;
  /** A `RemoteRun` for an existing run id (e.g. after a page reload). */
  open(runId: string, options?: RequestOptions): Promise<RemoteRun>;
  /** Requests cancellation; idempotent on terminal runs. */
  cancel(runId: string, reason?: string, options?: RequestOptions): Promise<CancelRunResult>;
}

/** Node type endpoint. */
export interface NodeTypesApi {
  /** Packs, node descriptors and pack types. Revalidated with `If-None-Match` after the first call. */
  list(options?: RequestOptions): Promise<NodeTypesInfo>;
}

/** Media endpoints. */
export interface MediaApi {
  /** Uploads raw bytes (`POST /media`). */
  upload(body: MediaBody, options?: UploadMediaOptions): Promise<MediaRef>;
  /** Downloads bytes as a Blob (`GET /media/:id`). */
  download(mediaId: string, options?: RequestOptions): Promise<Blob>;
  /** Absolute URL of `GET /media/:id` (for `<img src>`; does not carry custom headers). */
  url(mediaId: string): string;
}

/** Typed client of the Briarflow REST + SSE API. */
export interface BriarClient {
  readonly baseUrl: string;
  readonly contexts: ContextsApi;
  readonly flows: FlowsApi;
  readonly runs: RunsApi;
  readonly nodeTypes: NodeTypesApi;
  readonly media: MediaApi;
}

/**
 * Creates a client for a Briarflow server. Works in browsers, Node ≥ 20, Deno and Bun.
 *
 * @example
 * ```ts
 * const client = createBriarClient({ baseUrl: "http://localhost:3000/api/v1" });
 * const doc = await client.contexts.get("ctx_1");
 * await client.contexts.apply(doc.id, { baseRevision: doc.revision, commands: [{ op: "flow.create", name: "Portrait" }] });
 * const run = await client.flows.run("flow_p", { topic: "cats" });
 * for await (const e of run.events()) console.log(e.type);
 * ```
 */
export function createBriarClient(options: BriarClientOptions): BriarClient {
  const fetchFn = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const http = new Http(options.baseUrl, fetchFn, options.headers);
  const reconnect = { ...DEFAULT_RECONNECT, ...options.reconnect };
  const sig = (o?: RequestOptions) => (o?.signal ? { signal: o.signal } : {});

  const contexts: ContextsApi = {
    list(query = {}, o) {
      return http.json<Page<ContextSummary>>({
        method: "GET",
        path: "/contexts",
        query: { search: query.search, limit: query.limit, cursor: query.cursor },
        ...sig(o),
      });
    },
    iterate(query = {}, o) {
      return {
        async *[Symbol.asyncIterator]() {
          let cursor: string | undefined;
          do {
            const page = await contexts.list(cursor === undefined ? { ...query } : { ...query, cursor }, o);
            yield* page.items;
            cursor = page.nextCursor;
          } while (cursor !== undefined);
        },
      };
    },
    create(input, o) {
      return http.json<ContextDocument>({ method: "POST", path: "/contexts", json: input, ...sig(o) });
    },
    get(contextId, o) {
      return http.json<ContextDocument>({ method: "GET", path: `/contexts/${seg(contextId)}`, ...sig(o) });
    },
    async delete(contextId, o) {
      await http.send({ method: "DELETE", path: `/contexts/${seg(contextId)}`, ...sig(o) });
    },
    apply(contextId, input, o) {
      return http.json<ApplyCommandsResult>({
        method: "POST",
        path: `/contexts/${seg(contextId)}/commands`,
        json: { baseRevision: input.baseRevision, commands: input.commands },
        ...sig(o),
      });
    },
    diagnostics(contextId, o) {
      return http.json<ContextDiagnostics>({ method: "GET", path: `/contexts/${seg(contextId)}/diagnostics`, ...sig(o) });
    },
  };

  const flows: FlowsApi = {
    get(flowId, o) {
      return http.json<FlowInfo>({ method: "GET", path: `/flows/${seg(flowId)}`, ...sig(o) });
    },
    async run(flowId, inputs = {}, o = {}) {
      const path = `/flows/${seg(flowId)}/runs`;
      const res = await http.send({
        method: "POST",
        path,
        query: o.wait ? { wait: true, waitMs: o.waitMs } : {},
        json: o.useCache === undefined ? { inputs } : { inputs, useCache: o.useCache },
        ...sig(o),
      });
      if (res.status === 200) {
        const result = await readJson<RunResult>(res, `POST ${path}`);
        return new RemoteRun({ http, runId: result.runId, status: result.status, flowId, contextId: result.contextId, result, reconnect });
      }
      const started = await readJson<{ runId: string; status: RunStatus }>(res, `POST ${path}`);
      return new RemoteRun({ http, runId: started.runId, status: started.status, flowId, reconnect });
    },
  };

  const runs: RunsApi = {
    get(runId, o) {
      return http.json<RunInfo>({ method: "GET", path: `/runs/${seg(runId)}`, ...sig(o) });
    },
    async open(runId, o) {
      const info = await runs.get(runId, o);
      return new RemoteRun({
        http,
        runId: info.runId,
        status: info.status,
        flowId: info.flowId,
        contextId: info.contextId,
        ...(info.result ? { result: info.result } : {}),
        reconnect,
      });
    },
    cancel(runId, reason, o) {
      return http.json<CancelRunResult>({
        method: "POST",
        path: `/runs/${seg(runId)}/cancel`,
        json: reason === undefined ? {} : { reason },
        ...sig(o),
      });
    },
  };

  let nodeTypesCache: { etag: string; body: NodeTypesInfo } | undefined;
  const nodeTypes: NodeTypesApi = {
    async list(o) {
      const cached = nodeTypesCache;
      const res = await http.send({
        method: "GET",
        path: "/node-types",
        ...(cached ? { headers: { "if-none-match": cached.etag }, allow: [304] } : {}),
        ...sig(o),
      });
      if (res.status === 304 && cached) return cached.body;
      const body = await readJson<NodeTypesInfo>(res, "GET /node-types");
      const etag = res.headers.get("etag");
      nodeTypesCache = etag ? { etag, body } : undefined;
      return body;
    },
  };

  const media: MediaApi = {
    upload(body, o = {}) {
      const mime = o.mime ?? (typeof Blob !== "undefined" && body instanceof Blob ? body.type : undefined);
      if (!mime) {
        return Promise.reject(
          new InvalidRequestError("media.invalid_mime", "media.upload needs a mime type: pass { mime: \"image/png\" } or upload a Blob with a type."),
        );
      }
      return http.json<MediaRef>({
        method: "POST",
        path: "/media",
        query: { filename: o.filename },
        body: body as BodyInit,
        headers: { "content-type": mime },
        ...sig(o),
      });
    },
    async download(mediaId, o) {
      const res = await http.send({ method: "GET", path: `/media/${seg(mediaId)}`, headers: { accept: "*/*" }, ...sig(o) });
      return res.blob();
    },
    url(mediaId) {
      return http.url(`/media/${seg(mediaId)}`);
    },
  };

  return { baseUrl: options.baseUrl, contexts, flows, runs, nodeTypes, media };
}
