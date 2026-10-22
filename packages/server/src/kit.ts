/**
 * What every route module needs: the facade, options, the error wrapper, the authorize step
 * and path-id checks (docs/tasks/phase-5.md §4.2).
 */
import { BriarError, isValidId, type Logger } from "@briarflow/core";
import type { Briar } from "briarflow";
import type { Context, Env, Hono } from "hono";
import { checkAuthorized, type AuthorizeAction, type AuthorizeHook, type AuthorizeResource } from "./authorize.js";
import { briarError } from "./errors.js";

/** Resolved options shared by the routes. @internal */
export interface RouteKit<E extends Env> {
  app: Hono<E>;
  briar: Briar;
  /** e.g. "/api/v1" or "". */
  base: string;
  maxBodyBytes: number;
  maxUploadBytes: number;
  pingIntervalMs: number;
  logger: Logger;
  /** Wraps a handler so every error becomes the standard error response. */
  handle(fn: (c: Context<E>) => Promise<Response>): (c: Context<E>) => Promise<Response>;
  authorize(c: Context<E>, action: AuthorizeAction, resource: AuthorizeResource): Promise<void>;
}

/** @internal */
export function createRouteKit<E extends Env>(input: {
  app: Hono<E>;
  briar: Briar;
  base: string;
  maxBodyBytes: number;
  maxUploadBytes: number;
  pingIntervalMs: number;
  logger: Logger;
  authorize: AuthorizeHook<E> | undefined;
}): RouteKit<E> {
  const { authorize: hook, ...rest } = input;
  return {
    ...rest,
    handle: (fn) => async (c) => {
      try {
        return await fn(c);
      } catch (err) {
        return briarError(c, err);
      }
    },
    authorize: (c, action, resource) => checkAuthorized(hook, c, action, resource, input.logger),
  };
}

type PathIdKind = "context" | "flow" | "run" | "media";

const RUN_ID = /^run_[A-Za-z0-9_-]{1,60}$/;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Checks a path id; malformed → `400 request.invalid_id` (`details: { param, value }`). */
export function checkPathId(kind: PathIdKind, param: string, raw: string | undefined): string {
  const value = raw ?? "";
  const ok =
    kind === "run" ? RUN_ID.test(value) : kind === "media" ? MEDIA_ID.test(value) : isValidId(kind, value);
  if (!ok) {
    const hint =
      kind === "media" ? "Media ids use letters, digits, '_' and '-' (1–128 characters)." : `${kind === "context" ? "Context" : kind === "flow" ? "Flow" : "Run"} ids look like "${kind === "context" ? "ctx" : kind}_…".`;
    throw new BriarError("request.invalid_id", `"${value}" is not a valid ${kind} id in the path. ${hint}`, {
      details: { param, value },
    });
  }
  return value;
}

/** `{base}/path` → e.g. `/api/v1/contexts`. */
export function joinPath(base: string, path: string): string {
  return `${base}${path}`;
}
