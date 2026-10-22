import { BriarError } from "@briarflow/core";
import type { BriarErrorOptions } from "@briarflow/core";

/** Options of {@link BriarClientError}. */
export interface BriarClientErrorOptions extends BriarErrorOptions {
  /** HTTP status of the response, when there was one. */
  status?: number;
}

/**
 * Base class of every error thrown by `@briarflow/client`. For HTTP errors `code`, `message`
 * and `details` are the server's error body (`{ error: { code, message, details } }`) and
 * `status` is the HTTP status.
 *
 * @example
 * ```ts
 * try { await client.contexts.get("ctx_x"); }
 * catch (err) { if (err instanceof BriarClientError && err.code === "context.not_found") … }
 * ```
 */
export class BriarClientError extends BriarError {
  /** HTTP status, or `undefined` for network / protocol errors. */
  readonly status: number | undefined;

  constructor(code: string, message: string, options: BriarClientErrorOptions = {}) {
    super(code, message, options);
    this.status = options.status;
  }
}

/** The request never got a response (DNS, refused connection, CORS, …). Code `client.network`. */
export class NetworkError extends BriarClientError {
  constructor(message: string, options: BriarClientErrorOptions = {}) {
    super("client.network", message, options);
  }
}

/** A 2xx response whose body is not what the API promises. Code `client.invalid_response`. */
export class InvalidResponseError extends BriarClientError {
  constructor(message: string, options: BriarClientErrorOptions = {}) {
    super("client.invalid_response", message, options);
  }
}

/** 404: `context.not_found`, `flow.not_found`, `run.not_found`, `media.not_found`, `route.not_found`. */
export class NotFoundError extends BriarClientError {}

/** 401 `auth.unauthorized` or 403 `auth.forbidden`. */
export class AuthError extends BriarClientError {}

/** 400 / 413 / 415: the request itself was malformed (`request.*`, `store.invalid_cursor`, `media.*`). */
export class InvalidRequestError extends BriarClientError {}

/**
 * 409 `store.revision_conflict`: the context changed since `baseRevision`. Reload and retry.
 * `expected` / `actual` come from the server's `details`.
 */
export class RevisionConflictError extends BriarClientError {
  /** The revision the client sent. */
  readonly expected: number | undefined;
  /** The server's current revision. */
  readonly actual: number | undefined;

  constructor(message: string, options: BriarClientErrorOptions = {}) {
    super("store.revision_conflict", message, options);
    const d = (options.details ?? {}) as { expected?: unknown; actual?: unknown };
    this.expected = typeof d.expected === "number" ? d.expected : undefined;
    this.actual = typeof d.actual === "number" ? d.actual : undefined;
  }
}

/**
 * 409 other than a revision conflict (`context.exists`, `store.flow_id_conflict`).
 */
export class ConflictError extends BriarClientError {}

/**
 * 422 from a command batch: the server rejected command `commandIndex` (`op`). `code` is the
 * command / type / edge code, e.g. `edge.type_mismatch`.
 */
export class CommandError extends BriarClientError {
  /** Index of the rejected command in the batch. */
  readonly commandIndex: number | undefined;
  /** `op` of the rejected command. */
  readonly op: string | undefined;

  constructor(code: string, message: string, options: BriarClientErrorOptions = {}) {
    super(code, message, options);
    const d = (options.details ?? {}) as { commandIndex?: unknown; op?: unknown };
    this.commandIndex = typeof d.commandIndex === "number" ? d.commandIndex : undefined;
    this.op = typeof d.op === "string" ? d.op : undefined;
  }
}

/** 422 `run.invalid_inputs` / `run.invalid_flow`: the run was not created. `details.diagnostics` explains why. */
export class RunRejectedError extends BriarClientError {}

/** 5xx: the server failed (`internal`). */
export class ServerError extends BriarClientError {}

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

function readErrorBody(body: unknown): ErrorBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return undefined;
  const { code, message, details } = err as { code?: unknown; message?: unknown; details?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Maps a non-2xx response (status + parsed JSON body, if any) to the matching error class.
 * `where` describes the request (`"POST /contexts/ctx_1/commands"`) for bodies without a message.
 */
export function errorFromResponse(status: number, body: unknown, where: string): BriarClientError {
  const parsed = readErrorBody(body);
  const code = parsed?.code ?? (status >= 500 ? "internal" : "client.http_error");
  const message = parsed?.message ?? `${where} failed with HTTP ${status}. The server sent no Briarflow error body.`;
  const options: BriarClientErrorOptions = { status };
  if (parsed?.details !== undefined) options.details = parsed.details;

  if (status === 409 && code === "store.revision_conflict") return new RevisionConflictError(message, options);
  if (status === 409) return new ConflictError(code, message, options);
  if (status === 404) return new NotFoundError(code, message, options);
  if (status === 401 || status === 403) return new AuthError(code, message, options);
  if (status === 422 && code.startsWith("run.")) return new RunRejectedError(code, message, options);
  if (status === 422) return new CommandError(code, message, options);
  if (status === 400 || status === 413 || status === 415) return new InvalidRequestError(code, message, options);
  if (status >= 500) return new ServerError(code, message, options);
  return new BriarClientError(code, message, options);
}
