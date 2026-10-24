/**
 * The `authorize` hook (docs/specs/rest-api.md §5, docs/tasks/phase-5.md §4.2).
 */
import { BriarError, serializeError, type Logger } from "@briarflow/core";
import type { Context, Env } from "hono";

/** What a request wants to do. One per built-in route. */
export type AuthorizeAction =
  | "contexts.list"
  | "contexts.create"
  | "contexts.read"
  | "contexts.delete"
  | "contexts.edit"
  | "flows.read"
  | "flows.run"
  | "runs.read"
  | "runs.cancel"
  | "nodeTypes.read"
  | "media.upload"
  | "media.read"
  | "secrets.list"
  | "secrets.write"
  | "settings.read"
  | "settings.write";

/** Resolved ids of the resource a request targets. */
export interface AuthorizeResource {
  contextId?: string;
  flowId?: string;
  runId?: string;
  mediaId?: string;
}

/**
 * Argument of the `authorize` hook.
 *
 * @example
 * ```ts
 * const authorize = ({ action, resource, c }: AuthorizeRequest) =>
 *   action.endsWith(".read") || c.get("user")?.canEdit(resource.contextId);
 * ```
 */
export interface AuthorizeRequest<E extends Env = Env> {
  action: AuthorizeAction;
  /** Resolved ids: flowId → contextId (locateFlow), runId → flowId + contextId (registry). */
  resource: AuthorizeResource;
  /** The standard Fetch Request (headers, url). */
  request: Request;
  /** Escape hatch, e.g. `c.get("user")` set by your middleware. */
  c: Context<E>;
}

/** The hook's signature. */
export type AuthorizeHook<E extends Env = Env> = (req: AuthorizeRequest<E>) => boolean | Promise<boolean>;

/**
 * Runs the hook: `false` → `auth.forbidden`; `UnauthorizedError` / `auth.forbidden` thrown →
 * passed through; anything else thrown → logged and answered as 500.
 */
export async function checkAuthorized<E extends Env>(
  hook: AuthorizeHook<E> | undefined,
  c: Context<E>,
  action: AuthorizeAction,
  resource: AuthorizeResource,
  logger: Logger,
): Promise<void> {
  if (!hook) return;
  let allowed: boolean;
  try {
    allowed = await hook({ action, resource, request: c.req.raw, c });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (err instanceof Error && (code === "auth.unauthorized" || code === "auth.forbidden")) throw err;
    logger.error("http.authorize_failed", { action, error: serializeError(err) });
    throw new Error("The authorize hook threw.");
  }
  if (allowed !== true) {
    throw new BriarError("auth.forbidden", `You are not allowed to ${action}.`, { details: { action } });
  }
}
