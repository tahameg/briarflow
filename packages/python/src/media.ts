import { MEDIA_URI_SCHEME, NodeError, isMediaRef, mediaIdFromUri } from "@briarflow/core";
import type { MediaEntry, MediaRef, NodeMedia, TypeDecl, TypeRef } from "@briarflow/core";

/** Max decoded size of one `$media` output item (python-protocol.md §1.3). */
export const MAX_MEDIA_OUT_BYTES = 100 * 1024 * 1024;

const MEDIA_NAMES = new Set(["image", "video", "audio", "model3d", "file"]);

export type TypeLookup = ReadonlyMap<string, TypeDecl>;

type Visitor = (value: unknown, path: string) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds `value` following its Briarflow type, replacing every value at a media position
 * with what `visit` returns. Values that do not match the type are passed through unchanged
 * (the engine and the worker validate types).
 */
async function mapMedia(value: unknown, type: TypeRef, types: TypeLookup, path: string, visit: Visitor, depth = 0): Promise<unknown> {
  if (value === null || value === undefined || depth > 64) return value;
  switch (type.kind) {
    case "primitive":
      return MEDIA_NAMES.has(type.name) ? visit(value, path) : value;
    case "optional":
      return mapMedia(value, type.of, types, path, visit, depth + 1);
    case "list":
      if (!Array.isArray(value)) return value;
      return Promise.all(value.map((item, i) => mapMedia(item, type.of, types, `${path}[${i}]`, visit, depth + 1)));
    case "named": {
      const decl = types.get(type.id);
      if (decl?.kind !== "struct" || !isRecord(value)) return value;
      const out: Record<string, unknown> = { ...value };
      for (const field of decl.fields) {
        if (field.name in value) {
          out[field.name] = await mapMedia(value[field.name], field.type, types, `${path}.${field.name}`, visit, depth + 1);
        }
      }
      return out;
    }
    default:
      return value;
  }
}

/**
 * Replaces every media value inside `values` with what workers receive (python-protocol.md
 * §1.3): `{ uri, mime, bytes?, hash?, meta?, url }`, built by `describe` from the media's entry.
 */
export async function attachMediaUrls(
  values: Readonly<Record<string, unknown>>,
  ports: readonly { name: string; type: TypeRef }[],
  types: TypeLookup,
  describe: (ref: MediaRef) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const port of ports) {
    if (!(port.name in values)) continue;
    out[port.name] = await mapMedia(values[port.name], port.type, types, `inputs.${port.name}`, async (value) => (isMediaRef(value) ? describe(value) : value));
  }
  return out;
}

/**
 * What a worker gets for one media value. Its `url`: a public one when the media has it (a
 * link, or a blob store's `resolveUrl`, which lets remote workers fetch it), else `urlFor`.
 */
export async function workerMedia(ref: MediaRef, media: NodeMedia, urlFor: (ref: MediaRef, entry: MediaEntry) => Promise<string>): Promise<Record<string, unknown>> {
  const entry = await media.entry(ref);
  const publicUrl = await media.url(ref);
  return {
    uri: MEDIA_URI_SCHEME + entry.id,
    mime: entry.mime,
    ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    ...(entry.meta === undefined ? {} : { meta: entry.meta }),
    url: publicUrl ?? (await urlFor(ref, entry)),
  };
}

/**
 * Turns worker outputs at media positions back into media values: `{"$media": {mime, base64,
 * filename?, meta?}}` is put into `media`; a passed-through `{ uri: "briar-media://<id>" }`
 * becomes `{ mediaId }`, and an http(s) `uri` becomes a link entry.
 */
export async function storeMediaOutputs(
  outputs: Record<string, unknown>,
  ports: readonly { name: string; type: TypeRef }[],
  types: TypeLookup,
  media: NodeMedia,
  nodeType: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...outputs };
  for (const port of ports) {
    if (!(port.name in outputs)) continue;
    out[port.name] = await mapMedia(outputs[port.name], port.type, types, `outputs.${port.name}`, async (value, path) => {
      if (!isRecord(value) || isMediaRef(value)) return value;
      if (!("$media" in value)) {
        const uri = value.uri;
        if (typeof uri !== "string") return value;
        const id = uri.startsWith(MEDIA_URI_SCHEME) ? mediaIdFromUri(uri) : undefined;
        if (id !== undefined) return { mediaId: id };
        if (/^https?:\/\//i.test(uri) && typeof value.mime === "string") {
          return media.link(uri, { mime: value.mime, ...(isRecord(value.meta) ? { meta: value.meta } : {}) });
        }
        throw new NodeError("python.protocol_error", `${nodeType}: ${path} has media with uri ${JSON.stringify(uri)}, which is neither briar-media:// nor http(s).`, {
          details: { path },
        });
      }
      const item = value.$media;
      if (!isRecord(item) || typeof item.mime !== "string" || typeof item.base64 !== "string") {
        throw new NodeError(
          "python.protocol_error",
          `${nodeType}: ${path} has a malformed "$media" value; it needs string "mime" and "base64" fields.`,
          { details: { path } },
        );
      }
      const padding = item.base64.endsWith("==") ? 2 : item.base64.endsWith("=") ? 1 : 0;
      if (Math.floor((item.base64.length * 3) / 4) - padding > MAX_MEDIA_OUT_BYTES) {
        throw new NodeError(
          "python.media_too_large",
          `${nodeType}: ${path} is larger than ${MAX_MEDIA_OUT_BYTES} bytes. Return smaller media from the Python node.`,
          { details: { path, maxBytes: MAX_MEDIA_OUT_BYTES } },
        );
      }
      const bytes = new Uint8Array(Buffer.from(item.base64, "base64"));
      return media.put(bytes, {
        mime: item.mime,
        ...(typeof item.filename === "string" ? { filename: item.filename } : {}),
        ...(isRecord(item.meta) ? { meta: item.meta } : {}),
      });
    });
  }
  return out;
}
