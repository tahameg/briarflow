/**
 * Decoded images: RGBA pixels, 8 bits per channel. PNG and JPEG are read and written with pure
 * JavaScript codecs; other formats are rejected with `image.unsupported_format`.
 */
import { NodeError, readMedia, type ExecContext, type MediaRef } from "@briarflow/core";
import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";

/** An image in memory: `data` holds `width × height` RGBA pixels, row by row. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Output formats the pack writes. */
export type OutputFormat = "png" | "jpeg";

/** Largest image the pack decodes (pixels): 64 MP, the size of an 8K × 8K image. */
export const MAX_PIXELS = 8192 * 8192;

/** Blank (transparent black) pixels. Throws `image.invalid_size` for sizes it cannot make. */
export function blank(width: number, height: number): Pixels {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new NodeError("image.invalid_size", `An image must be at least 1×1 pixels with whole sizes; got ${width}×${height}.`);
  }
  if (width * height > MAX_PIXELS) throw new NodeError("image.invalid_size", `${width}×${height} is larger than ${MAX_PIXELS.toLocaleString("en")} pixels.`);
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

const isPng = (b: Uint8Array) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** Decodes PNG or JPEG bytes to RGBA. */
export function decodeImage(bytes: Uint8Array, mime = ""): Pixels {
  if (isPng(bytes)) return fromPng(bytes);
  if (isJpeg(bytes)) {
    const out = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_PIXELS / 1e6 });
    return { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data.buffer, out.data.byteOffset, out.data.byteLength) };
  }
  throw new NodeError("image.unsupported_format", `Cannot read ${mime || "this image"}: the image nodes read PNG and JPEG. Make the image as PNG (e.g. Format = png on OpenAI image).`);
}

function fromPng(bytes: Uint8Array): Pixels {
  const png = decodePng(bytes);
  if (png.width * png.height > MAX_PIXELS) throw new NodeError("image.invalid_size", `${png.width}×${png.height} is larger than ${MAX_PIXELS.toLocaleString("en")} pixels.`);
  const n = png.width * png.height;
  const out = new Uint8ClampedArray(n * 4);
  if (png.palette) {
    const rgb = convertIndexedToRgb(png);
    const ch = rgb.length / n;
    for (let i = 0; i < n; i++) {
      out[i * 4] = rgb[i * ch]!;
      out[i * 4 + 1] = rgb[i * ch + 1]!;
      out[i * 4 + 2] = rgb[i * ch + 2]!;
      out[i * 4 + 3] = ch === 4 ? rgb[i * ch + 3]! : 255;
    }
    return { width: png.width, height: png.height, data: out };
  }
  const src = png.data;
  const ch = png.channels;
  // 16-bit samples keep their high byte; 1/2/4-bit gray is scaled up to 0–255.
  const scale = png.depth === 16 ? 1 / 257 : png.depth < 8 ? 255 / (2 ** png.depth - 1) : 1;
  const at = (i: number) => Math.round(src[i]! * scale);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const s = i * ch;
    if (ch >= 3) {
      out[o] = at(s);
      out[o + 1] = at(s + 1);
      out[o + 2] = at(s + 2);
      out[o + 3] = ch === 4 ? at(s + 3) : 255;
    } else {
      const g = at(s);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
      out[o + 3] = ch === 2 ? at(s + 1) : 255;
    }
  }
  return { width: png.width, height: png.height, data: out };
}

/** Is every pixel opaque? */
export function isOpaque(p: Pixels): boolean {
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] !== 255) return false;
  return true;
}

/** Encodes RGBA pixels. PNG drops the alpha channel when every pixel is opaque; JPEG always does. */
export function encodeImage(p: Pixels, format: OutputFormat, quality = 90): { bytes: Uint8Array; mime: string } {
  if (format === "jpeg") {
    const out = jpeg.encode({ width: p.width, height: p.height, data: p.data }, quality);
    return { bytes: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength), mime: "image/jpeg" };
  }
  if (isOpaque(p)) {
    const rgb = new Uint8Array(p.width * p.height * 3);
    for (let i = 0, j = 0; i < p.data.length; i += 4, j += 3) {
      rgb[j] = p.data[i]!;
      rgb[j + 1] = p.data[i + 1]!;
      rgb[j + 2] = p.data[i + 2]!;
    }
    return { bytes: encodePng({ width: p.width, height: p.height, data: rgb, channels: 3, depth: 8 }), mime: "image/png" };
  }
  return { bytes: encodePng({ width: p.width, height: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength), channels: 4, depth: 8 }), mime: "image/png" };
}

/** Encodes one channel (0–255 per pixel) as a gray PNG. */
export function encodeGray(width: number, height: number, values: Uint8Array): Uint8Array {
  return encodePng({ width, height, data: values, channels: 1, depth: 8 });
}

/** Reads and decodes an image input. */
export async function readPixels(ref: MediaRef, ctx: ExecContext): Promise<Pixels> {
  const bytes = await readMedia(ref, { media: ctx.media, fetch: ctx.fetch, signal: ctx.signal });
  return decodeImage(bytes, ref.mime);
}

/** Stores encoded bytes as an image with its size in `meta`. */
export function storeImage(ctx: ExecContext, bytes: Uint8Array, mime: string, width: number, height: number, name: string): Promise<MediaRef> {
  return ctx.media.put(bytes, { mime, filename: `${name}.${mime === "image/jpeg" ? "jpg" : "png"}`, meta: { width, height } });
}

/** Encodes and stores pixels. */
export function storePixels(ctx: ExecContext, p: Pixels, format: OutputFormat, quality: number, name: string): Promise<MediaRef> {
  const { bytes, mime } = encodeImage(p, format, quality);
  return storeImage(ctx, bytes, mime, p.width, p.height, name);
}

/** Brightness (Rec. 601 luma) of pixel `i`, 0–255. Gray images give their gray value. */
export function luma(p: Pixels, i: number): number {
  const o = i * 4;
  return Math.round(0.299 * p.data[o]! + 0.587 * p.data[o + 1]! + 0.114 * p.data[o + 2]!);
}
