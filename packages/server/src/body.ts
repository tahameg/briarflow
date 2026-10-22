/**
 * Request bodies: JSON with a byte limit, and a counting wrapper for media uploads
 * (docs/tasks/phase-5.md §4.2, §4.5).
 */
import { BriarError, MediaError } from "@briarflow/core";

function tooLarge(maxBytes: number): BriarError {
  return new BriarError("request.too_large", `The request body is larger than the limit of ${maxBytes} bytes. Send less data per request.`, {
    details: { maxBytes },
  });
}

function mediaTooLarge(maxBytes: number): MediaError {
  return new MediaError("media.too_large", `The upload is larger than the limit of ${maxBytes} bytes.`, { details: { maxBytes } });
}

/** `Content-Length` as a number, or `undefined` when absent or malformed. */
export function contentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** Reads the whole body as text, failing with `request.too_large` above `maxBytes`. */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  const length = contentLength(request);
  if (length !== undefined && length > maxBytes) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge(maxBytes);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Reads and parses a JSON body. Empty or unparsable → `request.invalid_json`, unless
 * `optional` (then an empty body is `{}`).
 */
export async function readJson(request: Request, maxBytes: number, options: { optional?: boolean } = {}): Promise<unknown> {
  const text = await readText(request, maxBytes);
  if (text.trim() === "") {
    if (options.optional) return {};
    throw new BriarError("request.invalid_json", "The request body is empty. Send a JSON object.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new BriarError("request.invalid_json", `The request body is not valid JSON (${reason}).`);
  }
}

/** True for a plain JSON object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wraps an upload stream so it errors with `media.too_large` once more than `maxBytes` passed.
 * The store reading it then discards its partial write.
 */
export function limitUpload(body: ReadableStream<Uint8Array> | null, maxBytes: number): ReadableStream<Uint8Array> {
  if (!body) return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        controller.error(mediaTooLarge(maxBytes));
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** @internal */
export { mediaTooLarge };
