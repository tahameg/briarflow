/**
 * Calls `POST {baseUrl}/messages` with plain `fetch` and maps failures to `NodeError`
 * (docs/tasks/phase-8.md §4.1–§4.2). Never logs or returns the API key.
 */
import { NodeError } from "@briarflow/core";

/** Anthropic API version header value. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** The parts of a Messages API response the nodes read. */
export interface MessagesResponse {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: readonly ({ type: "text"; text: string } | { type: string })[];
  usage: { input_tokens: number; output_tokens: number };
}

/** One Messages API call. */
export interface MessagesCall {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
  /** `anthropic-beta` header values. */
  betas?: readonly string[];
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

/** Replaces the key and anything that looks like an Anthropic/OpenAI key with `[redacted]`. */
export function redact(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey.replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

async function errorBody(res: Response): Promise<{ type?: string; message?: string }> {
  try {
    const json = (await res.json()) as { error?: { type?: unknown; message?: unknown } };
    return {
      ...(typeof json.error?.type === "string" ? { type: json.error.type } : {}),
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
 * | 429 | `node.rate_limited` | yes |
 * | 408, 409, 5xx, 529 | `node.unavailable` | yes |
 * | 401, 403 | `anthropic.unauthorized` | no |
 * | 404 | `anthropic.not_found` | no |
 * | 413 | `anthropic.request_too_large` | no |
 * | other | `anthropic.bad_request` | no |
 */
export async function httpError(res: Response, apiKey: string): Promise<NodeError> {
  const { type, message } = await errorBody(res);
  const after = retryAfterMs(res.headers);
  const details = { status: res.status, ...(type ? { type } : {}), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  const said = message ? `: ${redact(message, apiKey)}` : ".";
  const s = res.status;
  if (s === 429) return new NodeError("node.rate_limited", `The Anthropic API is rate limiting requests${said}`, { retryable: true, details });
  if (s === 408 || s === 409 || s >= 500) {
    const what = s === 529 ? "is overloaded" : `answered ${s}`;
    return new NodeError("node.unavailable", `The Anthropic API ${what}${said} The request will be retried.`, { retryable: true, details });
  }
  if (s === 401 || s === 403) {
    return new NodeError("anthropic.unauthorized", `The Anthropic API rejected the key (${s})${said} Check the ANTHROPIC_API_KEY secret.`, { retryable: false, details });
  }
  if (s === 404) return new NodeError("anthropic.not_found", `The Anthropic API answered 404${said} Check the model id in the node config.`, { retryable: false, details });
  if (s === 413) return new NodeError("anthropic.request_too_large", `The request is too large for the Anthropic API${said} Shorten the prompt.`, { retryable: false, details });
  return new NodeError("anthropic.bad_request", `The Anthropic API refused the request (${s})${said}`, { retryable: false, details });
}

/** Sends one Messages request; resolves with the parsed body or throws a `NodeError`. */
export async function callMessages(call: MessagesCall): Promise<MessagesResponse> {
  const headers: Record<string, string> = {
    "x-api-key": call.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (call.betas && call.betas.length > 0) headers["anthropic-beta"] = call.betas.join(",");
  let res: Response;
  try {
    res = await call.fetch(`${call.baseUrl}/messages`, { method: "POST", headers, body: JSON.stringify(call.body), signal: call.signal });
  } catch (err) {
    if (call.signal.aborted) throw err;
    const reason = err instanceof Error ? redact(err.message, call.apiKey) : "network error";
    throw new NodeError("node.unavailable", `Could not reach the Anthropic API (${reason}). The request will be retried.`, { retryable: true, cause: err });
  }
  if (!res.ok) throw await httpError(res, call.apiKey);
  try {
    const body = (await res.json()) as MessagesResponse;
    if (!Array.isArray(body.content) || typeof body.usage !== "object") throw new Error("missing content or usage");
    return body;
  } catch (err) {
    if (call.signal.aborted) throw err;
    throw new NodeError("anthropic.invalid_response", "The Anthropic API sent a response Briarflow could not read. The request will be retried.", {
      retryable: true,
      details: { status: res.status },
    });
  }
}
