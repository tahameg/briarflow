import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { MediaRef, NodeMedia } from "@briarflow/core";
import { bridgeError } from "./errors.js";

/** Options of the loopback media server (python-protocol.md §3.3). */
export interface MediaServerOptions {
  /** Address to listen on. Default `"127.0.0.1"`. Use e.g. `"0.0.0.0"` for workers on another host. */
  host?: string;
  /** Default `0` (a free port). */
  port?: number;
  /**
   * Base URL put into the media URLs handed to workers, when the address workers reach
   * differs from the bind address (`host: "0.0.0.0"`, NAT, containers). An `http(s)` URL,
   * optionally with a path prefix; `/media/<token>` is appended. Default
   * `http://<host>:<port>` with the bound port (REQ-18).
   *
   * @example
   * ```ts
   * mediaServer: { host: "0.0.0.0", port: 8790, publicUrl: "http://briar-host.internal:8790" }
   * ```
   */
  publicUrl?: string;
}

interface Entry {
  ref: MediaRef;
  media: NodeMedia;
}

/**
 * Serves `GET /media/<token>` for MediaRefs handed to a worker. Tokens are random, valid for
 * any number of reads until released. Started lazily, unref'd so it never keeps the process alive.
 */
export class LoopbackMediaServer {
  readonly #entries = new Map<string, Entry>();
  readonly #host: string;
  readonly #port: number;
  readonly #publicUrl: string | undefined;
  #server: Promise<{ server: Server; base: string }> | undefined;

  constructor(options: MediaServerOptions = {}) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#publicUrl = options.publicUrl === undefined ? undefined : checkPublicUrl(options.publicUrl);
  }

  /** Registers `ref` and returns its URL. Release the token with {@link release}. */
  async register(ref: MediaRef, media: NodeMedia): Promise<{ url: string; token: string }> {
    const { base } = await this.#start();
    const token = randomBytes(18).toString("base64url");
    this.#entries.set(token, { ref, media });
    return { url: `${base}/media/${token}`, token };
  }

  release(tokens: Iterable<string>): void {
    for (const token of tokens) this.#entries.delete(token);
  }

  async close(): Promise<void> {
    const started = this.#server;
    this.#server = undefined;
    this.#entries.clear();
    if (started === undefined) return;
    const { server } = await started.catch(() => ({ server: undefined }));
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  #start(): Promise<{ server: Server; base: string }> {
    this.#server ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#handle(req.method ?? "GET", req.url ?? "/", res);
      });
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        server.off("error", reject);
        server.unref();
        const { port } = server.address() as AddressInfo;
        const host = this.#host.includes(":") ? `[${this.#host}]` : this.#host;
        resolve({ server, base: this.#publicUrl ?? `http://${host}:${port}` });
      });
    });
    return this.#server;
  }

  async #handle(method: string, url: string, res: ServerResponse): Promise<void> {
    const match = /^\/media\/([A-Za-z0-9_-]+)$/.exec(url.split("?", 1)[0] ?? "");
    const entry = match ? this.#entries.get(match[1] ?? "") : undefined;
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (entry === undefined) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Unknown or expired media token.");
      return;
    }
    try {
      let bytes: Uint8Array;
      let mime: string;
      try {
        [bytes, mime] = await Promise.all([entry.media.read(entry.ref), entry.media.entry(entry.ref).then((e) => e.mime)]);
      } catch (err) {
        if ((err as { code?: unknown }).code !== "media.not_found") throw err;
        res.writeHead(404, { "Content-Type": "text/plain" }).end(`Media ${entry.ref.mediaId} was not found.`);
        return;
      }
      res.writeHead(200, { "Content-Type": mime, "Content-Length": String(bytes.byteLength) });
      if (method === "HEAD") {
        res.end();
        return;
      }
      res.write(bytes);
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end(err instanceof Error ? err.message : String(err));
      } else {
        res.destroy();
      }
    }
  }
}

function checkPublicUrl(value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:") || url.search !== "" || url.hash !== "") {
    throw bridgeError(
      "python.invalid_options",
      `mediaServer.publicUrl ${JSON.stringify(value)} is not a valid base URL. Use an http(s) URL without query or fragment, e.g. "http://my-host:8790".`,
      { details: { publicUrl: value } },
    );
  }
  return url.href.replace(/\/+$/, "");
}
