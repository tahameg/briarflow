/**
 * The image nodes. Every node reads its image inputs (PNG / JPEG), works on RGBA pixels and
 * stores the result as a new image (PNG by default) with its width and height in `meta`.
 */
import { cfg, defineNode, NodeError, t, variant, type ExecContext, type MediaRef } from "@briarflow/core";
import { blank, copyPixels, encodeGray, luma, readPixels, storeImage, storePixels, type OutputFormat, type Pixels } from "./pixels.js";

const common = { pure: true, category: "Image", icon: "image", color: "lavender" } as const;

const outputConfig = {
  format: cfg.choice(["png", "jpeg"], { default: "png", title: "Format", description: "png keeps transparency; jpeg is smaller and drops it." }),
  quality: cfg.int({ min: 1, max: 100, default: 90, title: "JPEG quality" }),
};

interface OutputConfig {
  format: OutputFormat;
  quality: number;
}

const save = (ctx: ExecContext, p: Pixels, config: OutputConfig, name: string) => storePixels(ctx, p, config.format, config.quality, name);

const byte = { type: t.int({ min: 0, max: 255 }) };
const channel = (title: string) => ({ type: t.image(), title, description: `${title} channel: a gray image (from Split channels); its brightness is used.` });

/** All channel images must have one size; returns it. */
function sameSize(images: readonly Pixels[], names: readonly string[]): { width: number; height: number } {
  const [first] = images;
  if (!first) throw new NodeError("image.invalid_size", "No channel images.");
  images.forEach((p, i) => {
    if (p.width !== first.width || p.height !== first.height) {
      throw new NodeError("image.size_mismatch", `The channel images must have one size: ${names[0]} is ${first.width}×${first.height}, ${names[i]} is ${p.width}×${p.height}. Resize them first.`);
    }
  });
  return { width: first.width, height: first.height };
}

async function compose(refs: readonly MediaRef[], names: readonly string[], config: OutputConfig, ctx: ExecContext) {
  const channels = await Promise.all(refs.map((r) => readPixels(r, ctx)));
  const { width, height } = sameSize(channels, names);
  const out = blank(width, height);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 4; c++) out.data[i * 4 + c] = c < channels.length ? luma(channels[c]!, i) : 255;
  }
  return { image: await save(ctx, out, config, "image") };
}

/** `image.make`: an image from channel images, or filled with one color. */
export const imageMake = defineNode({
  ...common,
  type: "image.make",
  title: "Make image",
  description: "Builds an image from red, green, blue (and alpha) channel images, or fills a new image with one color.",
  variants: {
    title: "From",
    options: {
      rgba: variant({
        title: "RGBA channels",
        description: "Red, green, blue and alpha channel images of one size.",
        config: outputConfig,
        inputs: { red: channel("Red"), green: channel("Green"), blue: channel("Blue"), alpha: channel("Alpha") },
        outputs: { image: t.image() },
        run: ({ inputs, config, ctx }) => compose([inputs.red, inputs.green, inputs.blue, inputs.alpha], ["red", "green", "blue", "alpha"], config, ctx),
      }),
      rgb: variant({
        title: "RGB channels",
        description: "Red, green and blue channel images of one size; the image is opaque.",
        config: outputConfig,
        inputs: { red: channel("Red"), green: channel("Green"), blue: channel("Blue") },
        outputs: { image: t.image() },
        run: ({ inputs, config, ctx }) => compose([inputs.red, inputs.green, inputs.blue], ["red", "green", "blue"], config, ctx),
      }),
      color: variant({
        title: "One color",
        description: "A new image filled with one RGBA color (0–255 each).",
        config: outputConfig,
        inputs: {
          width: { type: t.int({ min: 1 }), default: 1024 },
          height: { type: t.int({ min: 1 }), default: 1024 },
          red: { ...byte, default: 0 },
          green: { ...byte, default: 0 },
          blue: { ...byte, default: 0 },
          alpha: { ...byte, default: 255 },
        },
        outputs: { image: t.image() },
        run: async ({ inputs, config, ctx }) => {
          const out = blank(inputs.width, inputs.height);
          const rgba = [inputs.red, inputs.green, inputs.blue, inputs.alpha];
          for (let i = 0; i < out.data.length; i++) out.data[i] = rgba[i % 4]!;
          return { image: await save(ctx, out, config, "color") };
        },
      }),
    },
  },
});

const CHANNEL_NAMES = ["red", "green", "blue", "alpha"] as const;

async function split(ref: MediaRef, count: 3 | 4, ctx: ExecContext) {
  const p = await readPixels(ref, ctx);
  const n = p.width * p.height;
  const out: Record<string, MediaRef> = {};
  for (let c = 0; c < count; c++) {
    const values = new Uint8Array(n);
    for (let i = 0; i < n; i++) values[i] = p.data[i * 4 + c]!;
    const name = CHANNEL_NAMES[c]!;
    out[name] = await storeImage(ctx, encodeGray(p.width, p.height, values), "image/png", p.width, p.height, name);
  }
  return out;
}

const grayOut = (title: string) => ({ type: t.image(), title, description: `${title} channel as a gray image.` });

/** `image.split`: one gray image per channel. */
export const imageSplit = defineNode({
  ...common,
  type: "image.split",
  title: "Split channels",
  description: "Splits an image into one gray image per channel. Make image puts them back together.",
  variants: {
    title: "Channels",
    options: {
      rgba: variant({
        title: "RGBA",
        inputs: { image: t.image() },
        outputs: { red: grayOut("Red"), green: grayOut("Green"), blue: grayOut("Blue"), alpha: grayOut("Alpha") },
        run: async ({ inputs, ctx }) => {
          const o = await split(inputs.image, 4, ctx);
          return { red: o["red"]!, green: o["green"]!, blue: o["blue"]!, alpha: o["alpha"]! };
        },
      }),
      rgb: variant({
        title: "RGB",
        inputs: { image: t.image() },
        outputs: { red: grayOut("Red"), green: grayOut("Green"), blue: grayOut("Blue") },
        run: async ({ inputs, ctx }) => {
          const o = await split(inputs.image, 3, ctx);
          return { red: o["red"]!, green: o["green"]!, blue: o["blue"]! };
        },
      }),
    },
  },
});

/**
 * Resamples `p` to `width × height`: an area average when shrinking (no aliasing), bilinear when
 * growing. Separable: rows first, then columns.
 */
export function resample(p: Pixels, width: number, height: number): Pixels {
  const pass = (src: Float32Array, sw: number, sh: number, dw: number, horizontal: boolean): Float32Array => {
    const outW = horizontal ? dw : sw;
    const outH = horizontal ? sh : dw;
    const dst = new Float32Array(outW * outH * 4);
    const srcLen = horizontal ? sw : sh;
    const lines = horizontal ? sh : sw;
    const scale = srcLen / dw;
    for (let d = 0; d < dw; d++) {
      // Source taps and weights for output position d.
      const taps: number[] = [];
      const weights: number[] = [];
      if (scale > 1) {
        const a = d * scale;
        const b = a + scale;
        for (let s = Math.floor(a); s < Math.min(srcLen, Math.ceil(b)); s++) {
          taps.push(s);
          weights.push((Math.min(b, s + 1) - Math.max(a, s)) / scale);
        }
      } else {
        const x = Math.max(0, Math.min(srcLen - 1, (d + 0.5) * scale - 0.5));
        const x0 = Math.floor(x);
        const x1 = Math.min(srcLen - 1, x0 + 1);
        taps.push(x0, x1);
        weights.push(1 - (x - x0), x - x0);
      }
      for (let l = 0; l < lines; l++) {
        const o = (horizontal ? l * outW + d : d * outW + l) * 4;
        let r = 0;
        let g = 0;
        let b = 0;
        let alpha = 0;
        for (let k = 0; k < taps.length; k++) {
          const s = (horizontal ? l * sw + taps[k]! : taps[k]! * sw + l) * 4;
          // Color weighted by alpha, so transparent pixels do not darken edges.
          const a = src[s + 3]! * weights[k]!;
          r += src[s]! * a;
          g += src[s + 1]! * a;
          b += src[s + 2]! * a;
          alpha += a;
        }
        if (alpha > 0) {
          dst[o] = r / alpha;
          dst[o + 1] = g / alpha;
          dst[o + 2] = b / alpha;
        }
        dst[o + 3] = alpha;
      }
    }
    return dst;
  };
  const src = Float32Array.from(p.data);
  const rows = pass(src, p.width, p.height, width, true);
  const both = pass(rows, width, p.height, height, false);
  const out = blank(width, height);
  out.data.set(both);
  return out;
}

/** Copies the `w × h` region at `x, y` of `p`. */
export function cropPixels(p: Pixels, x: number, y: number, w: number, h: number): Pixels {
  if (x < 0 || y < 0 || x + w > p.width || y + h > p.height) {
    throw new NodeError("image.invalid_size", `The crop ${w}×${h} at ${x},${y} does not fit inside the ${p.width}×${p.height} image.`);
  }
  const out = blank(w, h);
  for (let row = 0; row < h; row++) out.data.set(p.data.subarray(((y + row) * p.width + x) * 4, ((y + row) * p.width + x + w) * 4), row * w * 4);
  return out;
}

/** `image.resize`. */
export const imageResize = defineNode({
  ...common,
  type: "image.resize",
  title: "Resize image",
  description: "Scales an image. Leave width or height empty to keep the aspect ratio.",
  config: {
    fit: cfg.choice(["contain", "cover", "stretch"], {
      default: "contain",
      title: "Fit",
      description: "With both sizes: contain fits inside them, cover fills them and crops the overflow, stretch ignores the aspect ratio.",
    }),
    ...outputConfig,
  },
  inputs: { image: t.image(), width: t.optional(t.int({ min: 1 })), height: t.optional(t.int({ min: 1 })) },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => {
    const p = await readPixels(inputs.image, ctx);
    const { width: w, height: h } = inputs;
    if (w === null && h === null) throw new NodeError("image.invalid_size", "Set a width, a height or both.");
    const ratio = p.width / p.height;
    let out: Pixels;
    if (w === null || h === null) {
      const width = w ?? Math.max(1, Math.round(h! * ratio));
      const height = h ?? Math.max(1, Math.round(w! / ratio));
      out = resample(p, width, height);
    } else if (config.fit === "stretch") {
      out = resample(p, w, h);
    } else if (config.fit === "contain") {
      const s = Math.min(w / p.width, h / p.height);
      out = resample(p, Math.max(1, Math.round(p.width * s)), Math.max(1, Math.round(p.height * s)));
    } else {
      const s = Math.max(w / p.width, h / p.height);
      const sw = Math.max(w, Math.round(p.width * s));
      const sh = Math.max(h, Math.round(p.height * s));
      out = cropPixels(resample(p, sw, sh), Math.floor((sw - w) / 2), Math.floor((sh - h) / 2), w, h);
    }
    return { image: await save(ctx, out, config, "resized") };
  },
});

/** `image.crop`. */
export const imageCrop = defineNode({
  ...common,
  type: "image.crop",
  title: "Crop image",
  description: "Cuts out a rectangle. x and y are the top-left corner, in pixels.",
  config: outputConfig,
  inputs: {
    image: t.image(),
    x: { type: t.int({ min: 0 }), default: 0 },
    y: { type: t.int({ min: 0 }), default: 0 },
    width: t.int({ min: 1 }),
    height: t.int({ min: 1 }),
  },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => {
    const p = await readPixels(inputs.image, ctx);
    return { image: await save(ctx, cropPixels(p, inputs.x, inputs.y, inputs.width, inputs.height), config, "cropped") };
  },
});

/** Rotates by a quarter turn count or flips. */
export function transformPixels(p: Pixels, op: "rotate90" | "rotate180" | "rotate270" | "flipHorizontal" | "flipVertical"): Pixels {
  const swap = op === "rotate90" || op === "rotate270";
  const out = blank(swap ? p.height : p.width, swap ? p.width : p.height);
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      let tx = x;
      let ty = y;
      if (op === "rotate90") [tx, ty] = [p.height - 1 - y, x];
      else if (op === "rotate180") [tx, ty] = [p.width - 1 - x, p.height - 1 - y];
      else if (op === "rotate270") [tx, ty] = [y, p.width - 1 - x];
      else if (op === "flipHorizontal") tx = p.width - 1 - x;
      else ty = p.height - 1 - y;
      out.data.set(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4), (ty * out.width + tx) * 4);
    }
  }
  return out;
}

/** `image.transform`: rotate or flip. */
export const imageTransform = defineNode({
  ...common,
  type: "image.transform",
  title: "Rotate / flip image",
  description: "Rotates an image by quarter turns (clockwise) or mirrors it.",
  config: {
    op: cfg.choice(["rotate90", "rotate180", "rotate270", "flipHorizontal", "flipVertical"], { default: "rotate90", title: "Operation" }),
    ...outputConfig,
  },
  inputs: { image: t.image() },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => ({ image: await save(ctx, transformPixels(await readPixels(inputs.image, ctx), config.op), config, "transformed") }),
});

/** `image.grayscale`. */
export const imageGrayscale = defineNode({
  ...common,
  type: "image.grayscale",
  title: "Grayscale",
  description: "Turns an image gray by brightness; alpha is kept.",
  config: outputConfig,
  inputs: { image: t.image() },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => {
    const p = copyPixels(await readPixels(inputs.image, ctx));
    for (let i = 0; i < p.width * p.height; i++) {
      const g = luma(p, i);
      p.data[i * 4] = g;
      p.data[i * 4 + 1] = g;
      p.data[i * 4 + 2] = g;
    }
    return { image: await save(ctx, p, config, "grayscale") };
  },
});

/** `image.invert`. */
export const imageInvert = defineNode({
  ...common,
  type: "image.invert",
  title: "Invert colors",
  description: "Inverts red, green and blue (a negative); alpha is kept.",
  config: outputConfig,
  inputs: { image: t.image() },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => {
    const p = copyPixels(await readPixels(inputs.image, ctx));
    for (let i = 0; i < p.data.length; i++) if (i % 4 !== 3) p.data[i] = 255 - p.data[i]!;
    return { image: await save(ctx, p, config, "inverted") };
  },
});

/** `image.convert`: re-encode as PNG or JPEG. */
export const imageConvert = defineNode({
  ...common,
  type: "image.convert",
  title: "Convert image",
  description: "Saves an image as PNG or JPEG.",
  config: outputConfig,
  inputs: { image: t.image() },
  outputs: { image: t.image() },
  run: async ({ inputs, config, ctx }) => ({ image: await save(ctx, await readPixels(inputs.image, ctx), config, "converted") }),
});
