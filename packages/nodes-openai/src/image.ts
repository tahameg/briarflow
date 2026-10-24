/**
 * `openai.image`: prompt → image, through the Images API. The bytes go to the media store.
 */
import { cfg, defineNode, NodeError, t, variant, type ExecContext } from "@briarflow/core";
import { callOpenAI } from "./http.js";
import { connection, nodeSettings, type OpenAIPackOptions } from "./shared.js";

interface ImagesAnswer {
  data?: readonly { b64_json?: string; url?: string }[];
  /** The size the model picked (`"1024x1536"`), also for `size: "auto"`. */
  size?: string;
}

const MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Base64 → bytes without Node's Buffer (portable). */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Checks a `WIDTHxHEIGHT` size against the GPT Image 2 / 2.5 rules: both edges multiples of
 * 16 and at most 3840 px, aspect ratio between 1:3 and 3:1, 655,360 to 8,294,400 pixels.
 * Returns what is wrong, or `undefined` when the size is fine.
 */
export function flexibleSizeProblem(size: string): string | undefined {
  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!m) return `"${size}" is not a size: write WIDTHxHEIGHT, e.g. 1536x864.`;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w % 16 !== 0 || h % 16 !== 0) return `${size}: width and height must be multiples of 16.`;
  if (w > 3840 || h > 3840) return `${size}: no edge may exceed 3840 px.`;
  if (w > 3 * h || h > 3 * w) return `${size}: the aspect ratio must be between 1:3 and 3:1.`;
  if (w * h < 655_360 || w * h > 8_294_400) return `${size}: the image must have 655,360 to 8,294,400 pixels.`;
  return undefined;
}

const prompt = { prompt: { type: t.text({ multiline: true }), widget: "textarea" } } as const;

const LEGACY_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const FLEXIBLE_SIZES = [...LEGACY_SIZES, "2048x2048", "2048x1152", "1152x2048", "2560x1440", "3840x2160", "custom"] as const;

const commonConfig = {
  format: cfg.choice(["png", "jpeg", "webp"], { default: "png", title: "Format" }),
  compression: cfg.int({ min: 0, max: 100, optional: true, title: "Compression", description: "0–100, jpeg and webp only. Empty: the API default." }),
  background: cfg.choice(["auto", "transparent", "opaque"], { default: "auto", title: "Background", description: "Transparent needs png or webp." }),
  moderation: cfg.choice(["auto", "low"], { default: "auto", title: "Moderation", description: "low filters less strictly." }),
};

const flexibleConfig = (quality: readonly [string, ...string[]]) => ({
  size: cfg.choice(FLEXIBLE_SIZES, { default: "auto", title: "Size", description: "Above 2560x1440 is experimental. custom: set Custom size." }),
  customSize: cfg.text({ optional: true, title: "Custom size", description: "WIDTHxHEIGHT for Size = custom, e.g. 1536x864 (multiples of 16, up to 3840 px)." }),
  quality: cfg.choice(quality, { default: "auto", title: "Quality" }),
  ...commonConfig,
});

const legacyConfig = {
  size: cfg.choice(LEGACY_SIZES, { default: "auto", title: "Size" }),
  quality: cfg.choice(["auto", "low", "medium", "high"], { default: "auto", title: "Quality" }),
  ...commonConfig,
};

interface ImageConfig {
  size: string;
  customSize?: string | undefined;
  quality: string;
  format: string;
  compression?: number | undefined;
  background: string;
  moderation: string;
}

/** Builds the `openai.image` node for a pack instance: one variant per model. */
export function openaiImage(options: OpenAIPackOptions) {
  const generate = async (model: string, text: string, config: ImageConfig, ctx: ExecContext) => {
    let size = config.size;
    if (size === "custom") {
      size = config.customSize?.trim() ?? "";
      const problem = size === "" ? "Size is custom but Custom size is empty: write WIDTHxHEIGHT, e.g. 1536x864." : flexibleSizeProblem(size);
      if (problem) throw new NodeError("openai.invalid_size", problem);
    }
    const { apiKey, baseUrl } = await connection(ctx, "imageKey");
    const body: Record<string, unknown> = {
      model,
      prompt: text,
      n: 1,
      output_format: config.format,
      ...(size !== "auto" ? { size } : {}),
      ...(config.quality !== "auto" ? { quality: config.quality } : {}),
      ...(config.compression !== undefined && config.format !== "png" ? { output_compression: config.compression } : {}),
      ...(config.background !== "auto" ? { background: config.background } : {}),
      ...(config.moderation !== "auto" ? { moderation: config.moderation } : {}),
    };
    ctx.progress(0.1, "Calling OpenAI");
    const res = await callOpenAI<ImagesAnswer>({ fetch: options.fetch ?? ctx.fetch, baseUrl, path: "/images/generations", apiKey, body, signal: ctx.signal });
    const item = res.data?.[0];
    let bytes: Uint8Array;
    if (item?.b64_json) bytes = decodeBase64(item.b64_json);
    else if (item?.url) {
      const download = await (options.fetch ?? ctx.fetch)(item.url, { signal: ctx.signal });
      if (!download.ok) throw new NodeError("node.unavailable", `Could not download the generated image (${download.status}).`, { retryable: true });
      bytes = new Uint8Array(await download.arrayBuffer());
    } else {
      throw new NodeError("openai.invalid_response", "The OpenAI API answered without an image.", { retryable: true });
    }
    ctx.progress(0.9, "Storing image");
    const mime = MIME[config.format] ?? "image/png";
    const [w, h] = (size !== "auto" ? size : (res.size ?? "")).split("x").map(Number);
    const image = await ctx.media.put(bytes, {
      mime,
      filename: `openai.${mime.slice(6)}`,
      ...(w && h ? { meta: { width: w, height: h } } : {}),
    });
    ctx.progress(1);
    return { image };
  };
  const flexible = (model: string, title: string, description: string, quality: readonly [string, ...string[]]) =>
    variant({
      title,
      description,
      config: flexibleConfig(quality),
      inputs: prompt,
      outputs: { image: t.image() },
      run: ({ inputs, config, ctx }) => generate(model, inputs.prompt, config, ctx),
    });
  const legacy = (model: string, title: string) =>
    variant({
      title,
      description: `${title}: shuts down on Dec 1, 2026.`,
      deprecated: "OpenAI shuts this model down on Dec 1, 2026. Switch to GPT Image 2.5 Flare or Sunburst.",
      config: legacyConfig,
      inputs: prompt,
      outputs: { image: t.image() },
      run: ({ inputs, config, ctx }) => generate(model, inputs.prompt, config, ctx),
    });
  const quality25 = ["auto", "low", "medium", "high", "xhigh", "max"] as const;
  return defineNode({
    type: "openai.image",
    title: "OpenAI image",
    description: "Generates an image from a prompt with an OpenAI image model. Pick the model on the node: its settings follow the model.",
    ...nodeSettings,
    variants: {
      title: "Model",
      default: "gpt-image-2.5-flare",
      options: {
        "gpt-image-2.5-flare": flexible("gpt-image-2.5-flare", "GPT Image 2.5 Flare", "Fast, high-quality everyday images. The default choice.", quality25),
        "gpt-image-2.5-sunburst": flexible("gpt-image-2.5-sunburst", "GPT Image 2.5 Sunburst", "Premium images with tighter control across edits.", quality25),
        "gpt-image-2": flexible("gpt-image-2", "GPT Image 2", "The previous generation. Transparent backgrounds are in preview.", ["auto", "low", "medium", "high"]),
        "gpt-image-1.5": legacy("gpt-image-1.5", "GPT Image 1.5"),
        "gpt-image-1-mini": legacy("gpt-image-1-mini", "GPT Image 1 mini"),
      },
    },
  });
}
