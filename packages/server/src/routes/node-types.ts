/**
 * `GET /node-types` with a body-hash ETag (rest-api.md §3 "Node types").
 */
import { canonicalJson, sha256Hex } from "@briarflow/core";
import type { Env } from "hono";
import type { RouteKit } from "../kit.js";

/** True when an `If-None-Match` header matches `etag` (also `*` and weak forms). */
export function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag);
}

export function registerNodeTypeRoutes<E extends Env>(kit: RouteKit<E>): void {
  const { app, briar, base } = kit;
  // The catalog is immutable: compute the body and its ETag once, on first use.
  let cached: Promise<{ json: string; etag: string }> | undefined;
  const catalog = (): Promise<{ json: string; etag: string }> => {
    cached ??= (async () => {
      const body = briar.nodeTypes();
      const json = JSON.stringify(body);
      return { json, etag: `"${await sha256Hex(canonicalJson(body))}"` };
    })();
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };

  app.get(
    `${base}/node-types`,
    kit.handle(async (c) => {
      await kit.authorize(c, "nodeTypes.read", {});
      const { json, etag } = await catalog();
      if (matchesEtag(c.req.header("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(json, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", ETag: etag } });
    }),
  );
}
