/**
 * Media upload and download (rest-api.md §3 "Media", phase-5.md §4.5).
 */
import { BriarError, MediaError, type MediaRef } from "@briarflow/core";
import type { Env } from "hono";
import { contentLength, limitUpload, mediaTooLarge } from "../body.js";
import { invalidQuery } from "../errors.js";
import { checkPathId, type RouteKit } from "../kit.js";
import { matchesEtag } from "./node-types.js";

const MAX_FILENAME = 255;

function mediaNotFound(mediaId: string): BriarError {
  return new MediaError("media.not_found", `Media "${mediaId}" was not found. It may have been deleted.`, { details: { mediaId } });
}

/** `inline; filename="…"` with a quote-escaped ASCII fallback and `filename*` for non-ASCII. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&");
  if (/^[\x20-\x7e]*$/.test(filename)) return `inline; filename="${ascii}"`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Id part of a `briar-media://<id>` uri. */
function mediaIdOf(ref: MediaRef): string {
  return ref.uri.startsWith("briar-media://") ? ref.uri.slice("briar-media://".length) : ref.uri;
}

export function registerMediaRoutes<E extends Env>(kit: RouteKit<E>): void {
  const { app, briar, base } = kit;

  app.post(
    `${base}/media`,
    kit.handle(async (c) => {
      await kit.authorize(c, "media.upload", {});
      const filename = c.req.query("filename");
      if (filename !== undefined && filename.length > MAX_FILENAME) {
        throw invalidQuery("filename", `${filename.slice(0, 40)}…`, `must be at most ${MAX_FILENAME} characters`);
      }
      const mime = c.req.header("content-type");
      if (mime === undefined || mime.trim() === "") {
        await c.req.raw.body?.cancel().catch(() => {});
        throw new MediaError(
          "media.invalid_mime",
          "The upload has no Content-Type header. Send the media type of the bytes, e.g. Content-Type: image/png.",
        );
      }
      const length = contentLength(c.req.raw);
      if (length !== undefined && length > kit.maxUploadBytes) {
        await c.req.raw.body?.cancel().catch(() => {});
        throw mediaTooLarge(kit.maxUploadBytes);
      }
      const body = limitUpload(c.req.raw.body, kit.maxUploadBytes);
      const ref = await briar.media.put(body, filename === undefined || filename === "" ? { mime } : { mime, filename });
      c.header("Location", `${base}/media/${mediaIdOf(ref)}`);
      return c.json(ref, 201);
    }),
  );

  app.get(
    `${base}/media/:mediaId`,
    kit.handle(async (c) => {
      const mediaId = checkPathId("media", "mediaId", c.req.param("mediaId"));
      const stored = await briar.media.get(mediaId);
      if (!stored) throw mediaNotFound(mediaId);
      try {
        await kit.authorize(c, "media.read", { mediaId });
      } catch (err) {
        await stored.body.cancel().catch(() => {});
        throw err;
      }
      const { ref } = stored;
      const headers = new Headers({
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      if (ref.hash !== undefined) headers.set("ETag", `"${ref.hash}"`);
      if (ref.hash !== undefined && matchesEtag(c.req.header("if-none-match"), `"${ref.hash}"`)) {
        await stored.body.cancel().catch(() => {});
        return new Response(null, { status: 304, headers });
      }
      headers.set("Content-Type", ref.mime);
      if (ref.bytes !== undefined) headers.set("Content-Length", String(ref.bytes));
      const filename = ref.meta?.filename;
      if (typeof filename === "string" && filename !== "") headers.set("Content-Disposition", contentDisposition(filename));
      if (ref.mime === "image/svg+xml") headers.set("Content-Security-Policy", "sandbox");
      return new Response(stored.body, { status: 200, headers });
    }),
  );
}
