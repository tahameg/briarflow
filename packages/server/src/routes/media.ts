/**
 * Media: upload, links, entries and download (rest-api.md §3 "Media", media.md §6).
 */
import { BriarError, MediaError } from "@briarflow/core";
import type { Env } from "hono";
import { contentLength, isObject, limitUpload, mediaTooLarge, readJson } from "../body.js";
import { invalidBody, invalidQuery } from "../errors.js";
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
      const entry = await briar.media.upload(body, {
        mime,
        maxBytes: kit.maxUploadBytes,
        ...(filename === undefined || filename === "" ? {} : { filename }),
      });
      c.header("Location", `${base}/media/${entry.id}`);
      return c.json(entry, 201);
    }),
  );

  app.post(
    `${base}/media/links`,
    kit.handle(async (c) => {
      await kit.authorize(c, "media.upload", {});
      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      if (!isObject(body)) throw invalidBody([{ path: "", problem: 'must be a JSON object like { "url": "https://…", "mime": "image/png" }' }]);
      const problems: { path: string; problem: string }[] = [];
      if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url)) problems.push({ path: "url", problem: "must be an http(s) URL" });
      if (typeof body.mime !== "string" || body.mime === "") problems.push({ path: "mime", problem: "must be a mime type like image/png" });
      if (body.filename !== undefined && typeof body.filename !== "string") problems.push({ path: "filename", problem: "must be a string" });
      if (problems.length > 0) throw invalidBody(problems);
      const entry = await briar.media.link(body.url as string, {
        mime: body.mime as string,
        ...(typeof body.filename === "string" && body.filename !== "" ? { filename: body.filename } : {}),
      });
      c.header("Location", `${base}/media/${entry.id}`);
      return c.json(entry, 201);
    }),
  );

  app.get(
    `${base}/media/:mediaId/entry`,
    kit.handle(async (c) => {
      const mediaId = checkPathId("media", "mediaId", c.req.param("mediaId"));
      await kit.authorize(c, "media.read", { mediaId });
      const entry = await briar.media.entry(mediaId);
      if (!entry) throw mediaNotFound(mediaId);
      c.header("Cache-Control", "private, max-age=31536000, immutable");
      return c.json(entry);
    }),
  );

  app.get(
    `${base}/media/:mediaId`,
    kit.handle(async (c) => {
      const mediaId = checkPathId("media", "mediaId", c.req.param("mediaId"));
      await kit.authorize(c, "media.read", { mediaId });
      const entry = await briar.media.entry(mediaId);
      if (!entry) throw mediaNotFound(mediaId);
      // Entries never change, so the id is a strong validator.
      const etag = `"${entry.hash ?? entry.id}"`;
      const headers = new Headers({
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
      });
      if (matchesEtag(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
      const opened = await briar.media.open(entry.id, { signal: c.req.raw.signal });
      if ("url" in opened) {
        headers.set("Location", opened.url);
        headers.delete("ETag");
        return new Response(null, { status: 302, headers });
      }
      headers.set("Content-Type", entry.mime);
      if (entry.bytes !== undefined) headers.set("Content-Length", String(entry.bytes));
      const filename = entry.meta?.filename;
      if (typeof filename === "string" && filename !== "") headers.set("Content-Disposition", contentDisposition(filename));
      if (entry.mime === "image/svg+xml") headers.set("Content-Security-Policy", "sandbox");
      return new Response(opened.body, { status: 200, headers });
    }),
  );
}
