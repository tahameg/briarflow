/**
 * `serve`: runs a Hono app on Node through `@hono/node-server`, loaded lazily so the main
 * entry stays portable (phase-5.md §2). No `node:*` import here either; the Node server is
 * typed structurally.
 */

/** Options of {@link serve}. */
export interface ServeOptions {
  /** Default 3000. `0` picks a free port (tests). */
  port?: number;
  /** Default "127.0.0.1" (local only); "0.0.0.0" to listen on all interfaces. */
  hostname?: string;
}

/** A running Node HTTP server. */
export interface BriarServer {
  readonly port: number;
  /** e.g. "http://127.0.0.1:41234" (no base path). */
  readonly url: string;
  /** Stops accepting connections, ends open SSE streams, resolves when closed. Idempotent. */
  close(): Promise<void>;
}

/** Anything with a Fetch handler, e.g. a Hono app. */
export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

/** The parts of `node:http`'s `Server` that `serve` uses. */
interface NodeHttpServer {
  address(): { port: number } | string | null;
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
  once(event: "listening", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  off(event: "error", listener: (err: Error) => void): unknown;
}

interface NodeServerModule {
  serve(options: { fetch: (request: Request, ...rest: unknown[]) => Response | Promise<Response>; port: number; hostname: string }): unknown;
}

/** After this long, connections still open during `close()` are cut. */
const FORCE_CLOSE_AFTER_MS = 3_000;

/**
 * Serves a Hono app on Node (`@hono/node-server`, loaded lazily). Resolves once listening.
 *
 * @example
 * ```ts
 * const server = await serve(app, { port: 0 });
 * const client = createBriarClient({ baseUrl: `${server.url}/api/v1` });
 * await server.close();
 * ```
 */
export async function serve(app: FetchApp, options: ServeOptions = {}): Promise<BriarServer> {
  const mod = (await import("@hono/node-server")) as unknown as NodeServerModule;
  const hostname = options.hostname ?? "127.0.0.1";
  const streams = new Set<() => void>();
  const fetchApp = app.fetch as (request: Request, ...rest: unknown[]) => Response | Promise<Response>;

  const server = mod.serve({
    port: options.port ?? 3000,
    hostname,
    fetch: async (request, ...rest) => {
      const response = await fetchApp.call(app, request, ...rest);
      return isEventStream(response) ? trackStream(response, streams) : response;
    },
  }) as NodeHttpServer;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 3000);
  const urlHost = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname.includes(":") ? `[${hostname}]` : hostname;
  let closing: Promise<void> | undefined;

  return {
    port,
    url: `http://${urlHost}:${port}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections?.(), FORCE_CLOSE_AFTER_MS);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        for (const end of [...streams]) end();
        server.closeIdleConnections?.();
      });
      return closing;
    },
  };
}

function isEventStream(response: Response): boolean {
  return response.body !== null && (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
}

/** Re-wraps an SSE body so `close()` can end it; adds `Connection: keep-alive` (Node only). */
function trackStream(response: Response, streams: Set<() => void>): Response {
  const source = (response.body as ReadableStream<Uint8Array>).getReader();
  let end: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      end = () => {
        streams.delete(end as () => void);
        void source.cancel("The server is shutting down.").catch(() => {});
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      streams.add(end);
    },
    async pull(controller) {
      try {
        const { done, value } = await source.read();
        if (done) {
          if (end) streams.delete(end);
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        if (end) streams.delete(end);
        try {
          controller.error(err);
        } catch {
          // already closed by end()
        }
      }
    },
    cancel(reason) {
      if (end) streams.delete(end);
      return source.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.set("Connection", "keep-alive");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
