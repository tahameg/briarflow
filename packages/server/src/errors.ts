/**
 * Error → HTTP mapping (docs/tasks/phase-5.md §4.1, rest-api.md §1).
 */
import { CommandError } from "@briarflow/authoring";
import { BriarError, isBriarError, noopLogger, serializeError, type BriarErrorOptions, type Logger, type SerializedError } from "@briarflow/core";
import type { Context } from "hono";

/**
 * Throw from `authorize` (or a custom route) to answer 401 `auth.unauthorized`.
 *
 * @example
 * ```ts
 * createBriarApp(briar, {
 *   authorize: ({ request }) => {
 *     if (!request.headers.get("authorization")) throw new UnauthorizedError();
 *     return true;
 *   },
 * });
 * ```
 */
export class UnauthorizedError extends BriarError {
  constructor(message = "Sign in to use this API.", options: BriarErrorOptions = {}) {
    super("auth.unauthorized", message, options);
  }
}

const BAD_REQUEST_CODES = new Set(["store.invalid_cursor", "store.invalid_query", "document.invalid_id", "document.invalid_name"]);
const CONFLICT_CODES = new Set(["store.revision_conflict", "store.flow_id_conflict", "context.exists", "secret.exists"]);
const TOO_LARGE_CODES = new Set(["media.too_large", "request.too_large"]);
const UNPROCESSABLE_CODES = new Set(["run.invalid_inputs", "run.invalid_flow", "secret.invalid", "settings.invalid", "settings.unknown"]);

/** True for authoring's `CommandError`, also across duplicated package copies. */
function isCommandError(err: unknown): boolean {
  return err instanceof CommandError || (err instanceof Error && err.name === "CommandError");
}

/**
 * HTTP status for an error (phase-5.md §4.1). Exported for custom routes and tests.
 *
 * @example
 * ```ts
 * errorStatus(new BriarError("flow.not_found", "…")); // 404
 * errorStatus(new Error("boom"));                      // 500
 * ```
 */
export function errorStatus(err: unknown): number {
  if (!isBriarError(err)) return 500;
  if (isCommandError(err)) return 422;
  const code = err.code;
  if (code === "request.too_large") return 413;
  if (code.startsWith("request.") || BAD_REQUEST_CODES.has(code)) return 400;
  if (code === "auth.unauthorized") return 401;
  if (code === "auth.forbidden") return 403;
  if (code.endsWith(".not_found")) return 404;
  if (CONFLICT_CODES.has(code)) return 409;
  if (TOO_LARGE_CODES.has(code)) return 413;
  if (code === "media.invalid_mime") return 415;
  if (UNPROCESSABLE_CODES.has(code)) return 422;
  if (code === "briar.closed") return 503;
  return 500;
}

const INTERNAL_MESSAGE = "Something went wrong on the server. Try again; if it keeps happening, check the server log.";

/** Logger used by {@link briarError} for a request (set by `createBriarApp`'s middleware). */
const requestLoggers = new WeakMap<Request, Logger>();

/** @internal */
export function setRequestLogger(request: Request, logger: Logger): void {
  requestLoggers.set(request, logger);
}

/** The REST error body for an error, and its status. Never leaks non-Briar messages. @internal */
export function errorBody(err: unknown): { status: number; body: { error: SerializedError } } {
  const status = errorStatus(err);
  if (status === 500 && !(isBriarError(err) && err.code === "store.corrupt")) {
    return { status, body: { error: { code: "internal", message: INTERNAL_MESSAGE } } };
  }
  const serialized = serializeError(err);
  const error: SerializedError = { code: serialized.code, message: serialized.message };
  if (serialized.details !== undefined) error.details = serialized.details;
  return { status, body: { error } };
}

/**
 * Answers with the standard error body and the status of {@link errorStatus}. Non-Briar
 * errors (and Briar errors mapped to 500 other than `store.corrupt`) become
 * `500 { code: "internal", message: "Something went wrong on the server. …" }`; the original
 * is logged, never sent.
 *
 * @example
 * ```ts
 * app.post("/api/v1/portraits", async (c) => {
 *   try { … } catch (err) { return briarError(c, err); }
 * });
 * ```
 */
export function briarError(c: Context, err: unknown): Response {
  const { status, body } = errorBody(err);
  if (status === 500) {
    const logger = requestLoggers.get(c.req.raw) ?? noopLogger;
    logger.error("http.internal_error", { method: c.req.method, path: new URL(c.req.url).pathname, error: serializeError(err) });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** `400 request.invalid_body` with `details: [{ path, problem }]`. @internal */
export function invalidBody(problems: { path: string; problem: string }[]): BriarError {
  const text = problems.map((p) => (p.path === "" ? p.problem : `"${p.path}" ${p.problem}`)).join("; ");
  return new BriarError("request.invalid_body", `The request body is invalid: ${text}.`, { details: problems });
}

/** `400 request.invalid_query`. @internal */
export function invalidQuery(param: string, value: string, problem: string): BriarError {
  return new BriarError("request.invalid_query", `Query parameter "${param}" ${problem} (got "${value}").`, {
    details: { param, value },
  });
}
