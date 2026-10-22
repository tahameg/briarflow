import { NodeError } from "@briarflow/core";
import type { MediaRef, MediaStore, TypeDecl, TypeRef } from "@briarflow/core";

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

/** Adds a fetchable `url` to every MediaRef inside `values` (one entry per port). */
export async function attachMediaUrls(
  values: Readonly<Record<string, unknown>>,
  ports: readonly { name: string; type: TypeRef }[],
  types: TypeLookup,
  urlFor: (ref: MediaRef) => Promise<string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const port of ports) {
    if (!(port.name in values)) continue;
    out[port.name] = await mapMedia(values[port.name], port.type, types, `inputs.${port.name}`, async (value) => {
      if (!isRecord(value) || typeof value.uri !== "string" || typeof value.mime !== "string") return value;
      const { url: _ignored, ...ref } = value;
      void _ignored;
      return { ...ref, url: await urlFor(ref as unknown as MediaRef) };
    });
  }
  return out;
}

/**
 * Replaces every `{"$media": {mime, base64, filename?, meta?}}` at a media position of the
 * outputs with a MediaRef stored in `media`. Pass-through MediaRefs lose a stray `url`.
 */
export async function storeMediaOutputs(
  outputs: Record<string, unknown>,
  ports: readonly { name: string; type: TypeRef }[],
  types: TypeLookup,
  media: MediaStore,
  nodeType: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...outputs };
  for (const port of ports) {
    if (!(port.name in outputs)) continue;
    out[port.name] = await mapMedia(outputs[port.name], port.type, types, `outputs.${port.name}`, async (value, path) => {
      if (!isRecord(value)) return value;
      if (!("$media" in value)) {
        if ("url" in value && typeof value.uri === "string") {
          const { url: _ignored, ...ref } = value;
          void _ignored;
          return ref;
        }
        return value;
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
