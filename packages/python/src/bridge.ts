import { NodeError, PackDefinitionError, definePack, defineNode, isBriarError, t } from "@briarflow/core";
import type {
  AnyNodeDefinition,
  EnumType,
  ExecContext,
  NodeDescriptor,
  NodePack,
  NodeRunArgs,
  PortDescriptor,
  PortMap,
  PortOptions,
  StructType,
  TypeDecl,
  UnknownValue,
} from "@briarflow/core";
import { PythonBridgeError, isAbortError } from "./errors.js";
import { attachMediaUrls, storeMediaOutputs } from "./media.js";
import type { TypeLookup } from "./media.js";
import { LoopbackMediaServer } from "./media-server.js";
import type { MediaServerOptions } from "./media-server.js";

/** The only wire protocol version this bridge speaks. */
export const PROTOCOL_VERSION = 1;

/** `GET /briarflow/manifest` (python-protocol.md §1.2). */
export interface PythonManifest {
  protocol: number;
  sdk?: { name: string; version: string };
  pack: { name: string; version: string; title?: string; description?: string };
  types: TypeDecl[];
  nodes: NodeDescriptor[];
}

/** A pack served by a Python worker. `close()` stops the bridge's loopback media server. */
export interface PythonNodePack extends NodePack {
  close(): Promise<void>;
}

/** Options of {@link pythonPack}. */
export interface PythonPackOptions {
  /** Worker base URL, e.g. `"http://127.0.0.1:8765"`. */
  url: string;
  /** Shared bearer token the worker was started with. */
  token?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Timeout of the manifest request. Default 10 000. */
  manifestTimeoutMs?: number;
  /** Where the loopback media server listens (python-protocol.md §3.3). */
  mediaServer?: MediaServerOptions;
}

/** Where an execute request goes. Lets `spawnPythonWorker` follow restarts. */
export interface WorkerTarget {
  url: string;
  /** Aborted when this worker process goes away; executes then fail with `lostError()`. */
  lost?: AbortSignal;
  lostError?: () => NodeError;
}

/** @internal */
export interface Connection {
  token?: string | undefined;
  fetch: typeof fetch;
  /** Resolves when a worker can take requests. */
  acquire(signal: AbortSignal): Promise<WorkerTarget>;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readErrorBody(res: Response): Promise<{ code?: string; message?: string; details?: unknown }> {
  const text = await res.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && isRecord(body.error)) {
      const err = body.error;
      return {
        ...(typeof err.code === "string" ? { code: err.code } : {}),
        ...(typeof err.message === "string" ? { message: err.message } : {}),
        ...(err.details !== undefined ? { details: err.details } : {}),
      };
    }
  } catch {
    // not JSON
  }
  return text ? { message: text.slice(0, 500) } : {};
}

/**
 * Fetches and checks a worker's manifest.
 * @internal
 */
export async function fetchManifest(
  url: string,
  options: { token?: string | undefined; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<PythonManifest> {
  const base = trimUrl(url);
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let res: Response;
  let raw: string;
  try {
    res = await doFetch(`${base}/briarflow/manifest`, { headers: authHeaders(options.token), signal });
    if (!res.ok) {
      const err = await readErrorBody(res);
      throw new PythonBridgeError(
        "python.protocol_error",
        `Python worker at ${base} refused the manifest request (HTTP ${res.status}${err.code ? `, ${err.code}` : ""}): ${err.message ?? "no message"}`,
        {
          details: {
            url: base,
            status: res.status,
            ...(err.code ? { workerCode: err.code } : {}),
            ...(err.details !== undefined ? { worker: err.details } : {}),
          },
        },
      );
    }
    raw = await res.text();
  } catch (err) {
    if (err instanceof PythonBridgeError) throw err;
    const timedOut = timeout.aborted;
    throw new PythonBridgeError(
      "python.unreachable",
      timedOut
        ? `Python worker at ${base} did not answer GET /briarflow/manifest within ${options.timeoutMs ?? 10_000} ms. Check that it is running.`
        : `Cannot reach the Python worker at ${base}: ${err instanceof Error ? err.message : String(err)}. Check that it is running and the url is right.`,
      { cause: err, details: { url: base } },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw new PythonBridgeError("python.protocol_error", `Python worker at ${base} sent a manifest that is not JSON.`, {
      cause: err,
      details: { url: base },
    });
  }
  if (!isRecord(body)) {
    throw new PythonBridgeError("python.protocol_error", `Python worker at ${base} sent a manifest that is not a JSON object.`);
  }
  if (body.protocol !== PROTOCOL_VERSION) {
    throw new PythonBridgeError(
      "python.unsupported_protocol",
      `Python worker at ${base} speaks protocol ${JSON.stringify(body.protocol)}, but this bridge supports only protocol ${PROTOCOL_VERSION}. Use matching versions of briarflow (pip) and @briarflow/python.`,
      { details: { url: base, protocol: body.protocol ?? null, supported: [PROTOCOL_VERSION] } },
    );
  }
  const pack = body.pack;
  const problems: string[] = [];
  if (!isRecord(pack) || typeof pack.name !== "string" || typeof pack.version !== "string") {
    problems.push('"pack" needs string "name" and "version"');
  }
  if (!Array.isArray(body.nodes)) problems.push('"nodes" must be an array');
  if (body.types !== undefined && !Array.isArray(body.types)) problems.push('"types" must be an array');
  if (Array.isArray(body.nodes)) {
    body.nodes.forEach((n, i) => {
      if (!isRecord(n) || typeof n.type !== "string" || !Array.isArray(n.inputs) || !Array.isArray(n.outputs)) {
        problems.push(`nodes[${i}] needs a string "type" and "inputs"/"outputs" arrays`);
      }
    });
  }
  if (problems.length > 0) {
    throw new PackDefinitionError(`Python worker at ${base} sent an invalid manifest: ${problems.join("; ")}.`, {
      details: { url: base, problems },
    });
  }
  return { ...(body as unknown as PythonManifest), types: (body.types as TypeDecl[] | undefined) ?? [] };
}

function toPortMap(ports: readonly PortDescriptor[]): PortMap {
  const map: PortMap = {};
  for (const p of ports) {
    const port: PortOptions = { type: t.fromRef(p.type), title: p.title };
    if (p.description !== undefined) port.description = p.description;
    if (p.default !== undefined) port.default = p.default as UnknownValue;
    if (p.widget !== undefined && p.widget !== null) port.widget = p.widget;
    map[p.name] = port;
  }
  return map;
}

const LOSS_GRACE_MS = 1_000;
/** Execute statuses that come from a gateway in front of the worker → `python.unreachable`. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

function waitForAbort(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function cancelledError(signal: AbortSignal, nodeType: string): Error {
  const reason: unknown = signal.reason;
  if (isBriarError(reason)) return reason;
  return new NodeError("node.cancelled", `${nodeType}: the execution was cancelled.`, {
    ...(reason !== undefined ? { cause: reason } : {}),
  });
}

/** Shared state of one Python pack: worker connection, types, media server. @internal */
export class PackRuntime {
  readonly types: TypeLookup;
  #mediaServer: LoopbackMediaServer | undefined;

  constructor(
    readonly connection: Connection,
    manifest: PythonManifest,
    readonly mediaServerOptions: MediaServerOptions | undefined,
  ) {
    this.types = new Map(manifest.types.map((decl) => [decl.id, decl]));
  }

  get mediaServer(): LoopbackMediaServer {
    this.#mediaServer ??= new LoopbackMediaServer(this.mediaServerOptions);
    return this.#mediaServer;
  }

  async close(): Promise<void> {
    const server = this.#mediaServer;
    this.#mediaServer = undefined;
    await server?.close();
  }

  async execute(desc: NodeDescriptor, args: NodeRunArgs<Readonly<Record<string, unknown>>, unknown>): Promise<Record<string, UnknownValue>> {
    const { ctx } = args;
    if (ctx.signal.aborted) throw cancelledError(ctx.signal, desc.type);
    const target = await this.connection.acquire(ctx.signal);
    const tokens: string[] = [];
    try {
      const inputs = await attachMediaUrls(args.inputs, desc.inputs, this.types, async (ref) => {
        const resolved = ctx.media.resolveUrl ? await ctx.media.resolveUrl(ref) : undefined;
        if (resolved) return resolved;
        if (/^https?:\/\//i.test(ref.uri)) return ref.uri;
        const registered = await this.mediaServer.register(ref, ctx.media);
        tokens.push(registered.token);
        return registered.url;
      });
      const secrets: Record<string, string> = {};
      for (const name of desc.secrets) secrets[name] = await ctx.secrets.get(name);
      const body = {
        protocol: PROTOCOL_VERSION,
        nodeType: desc.type,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        attempt: ctx.attempt,
        timeoutMs: desc.timeoutMs,
        inputs,
        config: {},
        secrets,
      };
      return await this.#stream(desc, ctx, target, JSON.stringify(body));
    } finally {
      if (tokens.length > 0) this.#mediaServer?.release(tokens);
    }
  }

  async #stream(desc: NodeDescriptor, ctx: ExecContext, target: WorkerTarget, body: string): Promise<Record<string, UnknownValue>> {
    const signal = target.lost ? AbortSignal.any([ctx.signal, target.lost]) : ctx.signal;
    const base = trimUrl(target.url);
    const fail = async (err: unknown, during: string): Promise<Error> => {
      if (ctx.signal.aborted) return cancelledError(ctx.signal, desc.type);
      // A dropped connection usually means the worker process died; its exit event may arrive
      // a moment after the socket error.
      if (target.lost && !target.lost.aborted && !(err instanceof NodeError)) await waitForAbort(target.lost, LOSS_GRACE_MS);
      if (target.lost?.aborted && target.lostError) return target.lostError();
      if (err instanceof NodeError) return err;
      return new NodeError(
        "python.unreachable",
        `${desc.type}: ${during} the Python worker at ${base} failed: ${err instanceof Error ? err.message : String(err)}.`,
        { retryable: true, cause: err, details: { url: base } },
      );
    };

    let res: Response;
    try {
      res = await this.connection.fetch(`${base}/briarflow/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(this.connection.token) },
        body,
        signal,
      });
    } catch (err) {
      throw await fail(err, "sending the request to");
    }

    if (res.status !== 200) {
      const err = await readErrorBody(res).catch(() => ({}) as { code?: string; message?: string; details?: unknown });
      if (err.code === "node.invalid_input") {
        throw new NodeError("node.invalid_input", err.message ?? `${desc.type}: the Python worker rejected the inputs.`, {
          retryable: false,
          ...(err.details !== undefined ? { details: err.details } : {}),
        });
      }
      const details = { status: res.status, ...(err.code ? { workerCode: err.code } : {}), ...(err.details !== undefined ? { worker: err.details } : {}) };
      if (GATEWAY_STATUSES.has(res.status)) {
        // A proxy or load balancer in front of the worker: the worker is down or overloaded
        // (python-protocol.md §3.1). Retryable, like a refused connection.
        throw new NodeError(
          "python.unreachable",
          `${desc.type}: the Python worker at ${base} is unavailable (HTTP ${res.status} from a gateway${err.code ? `, ${err.code}` : ""}). The node may be retried.`,
          { retryable: true, details },
        );
      }
      throw new NodeError(
        "python.protocol_error",
        `${desc.type}: the Python worker refused the execute request (HTTP ${res.status}${err.code ? `, ${err.code}` : ""}): ${err.message ?? "no message"}`,
        {
          retryable: false,
          details,
        },
      );
    }
    if (res.body === null) {
      throw new NodeError("python.protocol_error", `${desc.type}: the Python worker sent an empty response.`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal: { outputs: Record<string, unknown> } | NodeError | undefined;

    const handleLine = (line: string): void => {
      if (terminal !== undefined || line.trim() === "") return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        throw new NodeError("python.protocol_error", `${desc.type}: the Python worker sent a line that is not JSON: ${line.slice(0, 200)}`, {
          cause: err,
        });
      }
      if (!isRecord(msg)) return;
      switch (msg.type) {
        case "progress":
          if (typeof msg.fraction === "number") {
            ctx.progress(msg.fraction, typeof msg.message === "string" ? msg.message : undefined);
          }
          return;
        case "log": {
          const level = msg.level === "debug" || msg.level === "warn" || msg.level === "error" ? msg.level : "info";
          const message = typeof msg.message === "string" ? msg.message : String(msg.message);
          if (isRecord(msg.data)) ctx.log[level](message, msg.data);
          else ctx.log[level](message);
          return;
        }
        case "result":
          if (!isRecord(msg.outputs)) {
            throw new NodeError("python.protocol_error", `${desc.type}: the Python worker sent a result without an "outputs" object.`);
          }
          terminal = { outputs: msg.outputs };
          return;
        case "error": {
          const code = typeof msg.code === "string" && msg.code ? msg.code : "node.failed";
          const message = typeof msg.message === "string" && msg.message ? msg.message : `${desc.type} failed in the Python worker.`;
          terminal = new NodeError(code, message, {
            ...(typeof msg.retryable === "boolean" ? { retryable: msg.retryable } : {}),
            ...(msg.details !== undefined && !(isRecord(msg.details) && Object.keys(msg.details).length === 0)
              ? { details: msg.details }
              : {}),
          });
          return;
        }
        default:
          return; // unknown line types are ignored (protocol §1.3)
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      handleLine(buffer);
    } catch (err) {
      void reader.cancel().catch(() => {});
      if (err instanceof NodeError && !ctx.signal.aborted && !target.lost?.aborted) throw err;
      throw await fail(err, isAbortError(err) ? "streaming from" : "reading the response of");
    }

    if (ctx.signal.aborted) throw cancelledError(ctx.signal, desc.type);
    if (terminal === undefined) {
      if (target.lost && !target.lost.aborted) await waitForAbort(target.lost, LOSS_GRACE_MS);
      if (target.lost?.aborted && target.lostError) throw target.lostError();
      throw new NodeError("python.protocol_error", `${desc.type}: Worker closed the stream without a result.`);
    }
    if (terminal instanceof NodeError) throw terminal;
    const outputs = await storeMediaOutputs(terminal.outputs, desc.outputs, this.types, ctx.media, desc.type);
    return outputs as Record<string, UnknownValue>;
  }
}

/**
 * Builds a core `NodePack` from a manifest; every node's `run` executes on the worker.
 * @internal
 */
export function manifestToPack(manifest: PythonManifest, connection: Connection, mediaServer?: MediaServerOptions): PythonNodePack {
  const runtime = new PackRuntime(connection, manifest, mediaServer);
  const packName = manifest.pack.name;
  try {
    const types: (StructType | EnumType)[] = manifest.types.map((decl) => {
      if (decl.id !== `${packName}.${decl.name}`) {
        throw new PackDefinitionError(
          `Python pack ${packName}: type id "${decl.id}" must be "${packName}.${decl.name}".`,
          { details: { typeId: decl.id } },
        );
      }
      const bare = { ...decl, id: decl.name };
      return decl.kind === "struct"
        ? ({ kind: "structType", decl: bare } as StructType)
        : ({ kind: "enumType", decl: bare } as EnumType);
    });
    const nodes: AnyNodeDefinition[] = manifest.nodes.map((desc) => {
      const def = defineNode<PortMap, PortMap>({
        type: desc.type,
        title: desc.title,
        description: desc.description,
        category: desc.category,
        ...(desc.icon ? { icon: desc.icon } : {}),
        ...(desc.color ? { color: desc.color } : {}),
        inputs: toPortMap(desc.inputs),
        outputs: toPortMap(desc.outputs),
        secrets: desc.secrets,
        cache: desc.cache,
        timeoutMs: desc.timeoutMs,
        retry: desc.retry,
        ...(typeof desc.concurrency === "number" ? { concurrency: desc.concurrency } : {}),
        ...(desc.deprecated ? { deprecated: desc.deprecated } : {}),
        // Python nodes call out to a worker: they can fail, so they get a failed line.
        ...(desc.outputs.some((o) => o.name === "error") ? {} : { canFail: true }),
        run: (args) => runtime.execute(desc, args),
      });
      return def as unknown as AnyNodeDefinition;
    });
    const pack = definePack({
      name: packName,
      version: manifest.pack.version,
      ...(manifest.pack.title !== undefined ? { title: manifest.pack.title } : {}),
      ...(manifest.pack.description !== undefined ? { description: manifest.pack.description } : {}),
      types,
      nodes,
    });
    return { ...pack, close: () => runtime.close() };
  } catch (err) {
    if (isBriarError(err) && (err.code === "pack.invalid" || err.code === "not_implemented")) throw err;
    if (isBriarError(err)) {
      throw new PackDefinitionError(`Python pack ${packName} has an invalid manifest: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * Connects to a running Python worker: fetches its manifest, checks the protocol version and
 * returns a `NodePack` whose nodes execute on the worker (progress, logs, errors, media and
 * cancellation included).
 *
 * @example
 * ```ts
 * const imaging = await pythonPack({ url: "http://127.0.0.1:8765" });
 * const briar = createBriar({ packs: [stdPack, imaging] });
 * // later: await imaging.close();
 * ```
 */
export async function pythonPack(options: PythonPackOptions): Promise<PythonNodePack> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const manifest = await fetchManifest(options.url, {
    token: options.token,
    fetch: doFetch,
    ...(options.manifestTimeoutMs !== undefined ? { timeoutMs: options.manifestTimeoutMs } : {}),
  });
  const url = options.url;
  return manifestToPack(
    manifest,
    { token: options.token, fetch: doFetch, acquire: async () => ({ url }) },
    options.mediaServer,
  );
}
