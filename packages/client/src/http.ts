import { InvalidResponseError, NetworkError, errorFromResponse } from "./errors.js";
import type { FetchLike, HeadersOption } from "./types.js";

/** Query parameters; `undefined` values are skipped. */
export type Query = Record<string, string | number | boolean | undefined>;

/** One HTTP call made by the client. */
export interface HttpRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Query;
  /** Serialized as JSON with `Content-Type: application/json`. */
  json?: unknown;
  /** Raw body (media upload). */
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** Non-2xx statuses that are not errors (e.g. 304). */
  allow?: readonly number[];
}

/** Thin fetch wrapper: URL building, headers, error mapping. Internal. */
export class Http {
  private readonly root: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: FetchLike,
    private readonly headers: HeadersOption | undefined,
  ) {
    this.root = baseUrl.replace(/\/+$/, "");
  }

  url(path: string, query?: Query): string {
    let url = this.root + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  /** Performs the request; throws a mapped `BriarClientError` for non-2xx (unless allowed). */
  async send(req: HttpRequest): Promise<Response> {
    const headers = new Headers(typeof this.headers === "function" ? await this.headers() : this.headers);
    for (const [k, v] of Object.entries(req.headers ?? {})) headers.set(k, v);
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (req.json !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(req.json);
    } else if (req.body !== undefined) {
      init.body = req.body;
      if (typeof ReadableStream !== "undefined" && req.body instanceof ReadableStream) init.duplex = "half";
    }
    if (req.signal) init.signal = req.signal;
    if (!headers.has("accept")) headers.set("accept", "application/json");

    const where = `${req.method} ${req.path}`;
    let res: Response;
    try {
      res = await this.fetchFn(this.url(req.path, req.query), init);
    } catch (err) {
      if (isAbort(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new NetworkError(`${where} could not reach the Briarflow server at ${this.root} (${reason}). Check that the server is running and the baseUrl is right.`, { cause: err });
    }
    if (res.ok || req.allow?.includes(res.status)) return res;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw errorFromResponse(res.status, body, where);
  }

  /** `send` + parse a JSON body. */
  async json<T>(req: HttpRequest): Promise<T> {
    const res = await this.send(req);
    return readJson<T>(res, `${req.method} ${req.path}`);
  }
}

/** Parses a JSON response body or throws `InvalidResponseError`. */
export async function readJson<T>(res: Response, where: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new InvalidResponseError(`${where} returned HTTP ${res.status} with a body that is not valid JSON.`, { status: res.status, cause: err });
  }
}

/** True for an `AbortError` / `TimeoutError` raised by fetch or a signal. */
export function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && ((err as { name?: unknown }).name === "AbortError" || (err as { name?: unknown }).name === "TimeoutError");
}

/** Encodes a path segment (ids). */
export function seg(id: string): string {
  return encodeURIComponent(id);
}
