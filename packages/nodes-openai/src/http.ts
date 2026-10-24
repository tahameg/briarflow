/**
 * Calls the OpenAI API with plain `fetch` and maps failures to `NodeError`. Never logs or
 * returns the API key.
 */
import { NodeError } from "@briarflow/core";

/** One API call. */
export interface OpenAICall {
  fetch: typeof fetch;
  baseUrl: string;
  /** e.g. `/responses`. */
  path: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}

/** `retry-after-ms`, else `retry-after` (seconds or an HTTP date), in ms. */
export function retryAfterMs(headers: Headers, now: () => number = Date.now): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.round(Number(ms));
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now());
}

/** Replaces the key and anything that looks like an OpenAI key with `[redacted]`. */
export function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

async function errorBody(res: Response): Promise<{ type?: string; code?: string; message?: string }> {
  try {
    const json = (await res.json()) as { error?: { type?: unknown; code?: unknown; message?: unknown } };
    return {
      ...(typeof json.error?.type === "string" ? { type: json.error.type } : {}),
      ...(typeof json.error?.code === "string" ? { code: json.error.code } : {}),
      ...(typeof json.error?.message === "string" ? { message: json.error.message } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Maps a non-2xx response to a `NodeError`.
 *
 * | Status | Code | Retryable |
 * |---|---|---|
 * | 429 (rate limit) | `node.rate_limited` | yes |
 * | 429 (`insufficient_quota`) | `openai.quota_exceeded` | no |
 * | 408, 409, 5xx | `node.unavailable` | yes |
 * | 401, 403 | `openai.unauthorized` | no |
 * | 404 | `openai.not_found` | no |
 * | other | `openai.bad_request` | no |
 */
export async function httpError(res: Response, apiKey: string): Promise<NodeError> {
  const { type, code, message } = await errorBody(res);
  const after = retryAfterMs(res.headers);
  const details = { status: res.status, ...(type ? { type } : {}), ...(code ? { apiCode: code } : {}), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  const said = message ? `: ${redact(message, apiKey)}` : ".";
  const s = res.status;
  if (s === 429 && (code === "insufficient_quota" || type === "insufficient_quota")) {
    return new NodeError("openai.quota_exceeded", `The OpenAI account has no quota left${said} Check billing, or pick another key in Settings → OpenAI.`, { retryable: false, details });
  }
  if (s === 429) return new NodeError("node.rate_limited", `The OpenAI API is rate limiting requests${said}`, { retryable: true, details });
  if (s === 408 || s === 409 || s >= 500) {
    return new NodeError("node.unavailable", `The OpenAI API answered ${s}${said} The request will be retried.`, { retryable: true, details });
  }
  if (s === 401 || s === 403) {
    return new NodeError("openai.unauthorized", `The OpenAI API rejected the key (${s})${said} Check the key secret picked in Settings → OpenAI.`, { retryable: false, details });
  }
  if (s === 404) return new NodeError("openai.not_found", `The OpenAI API answered 404${said} Check the model id in the node config.`, { retryable: false, details });
  return new NodeError("openai.bad_request", `The OpenAI API refused the request (${s})${said}`, { retryable: false, details });
}

/** Sends one JSON request; resolves with the parsed body or throws a `NodeError`. */
export async function callOpenAI<T>(call: OpenAICall): Promise<T> {
  const headers = { authorization: `Bearer ${call.apiKey}`, "content-type": "application/json" };
  let res: Response;
  try {
    res = await call.fetch(`${call.baseUrl}${call.path}`, { method: "POST", headers, body: JSON.stringify(call.body), signal: call.signal });
  } catch (err) {
    if (call.signal.aborted) throw err;
    const reason = err instanceof Error ? redact(err.message, call.apiKey) : "network error";
    throw new NodeError("node.unavailable", `Could not reach the OpenAI API (${reason}). The request will be retried.`, { retryable: true, cause: err });
  }
  if (!res.ok) throw await httpError(res, call.apiKey);
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (call.signal.aborted) throw err;
    throw new NodeError("openai.invalid_response", "The OpenAI API sent a response Briarflow could not read. The request will be retried.", {
      retryable: true,
      details: { status: res.status },
    });
  }
}
