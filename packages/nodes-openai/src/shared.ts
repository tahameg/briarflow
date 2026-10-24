/**
 * What the OpenAI nodes share: pack options, settings (which vault key for which job) and
 * key resolution.
 */
import { NodeError, t, type ExecContext } from "@briarflow/core";

/** Options of {@link openaiPack}. All optional. */
export interface OpenAIPackOptions {
  /** Replaces `ctx.fetch` for API calls (tests, proxies). */
  fetch?: typeof fetch;
}

/** Default API base URL. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Known text models (for docs and UIs); the `model` config accepts any id. */
export const OPENAI_TEXT_MODELS: readonly string[] = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"];

/** Known image models. */
export const OPENAI_IMAGE_MODELS: readonly string[] = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"];

const keyType = () => t.optional(t.secret({ kind: "apiKey" }));

/** Pack settings (Settings → OpenAI). A node uses the key for its job (text / images), else the default key. */
export const openaiSettings = {
  defaultKey: { type: keyType(), title: "Default API key", description: "Used by every OpenAI node unless a key below is set." },
  textKey: { type: keyType(), title: "Key for text", description: "Used by OpenAI text nodes. Empty: the default key." },
  imageKey: { type: keyType(), title: "Key for images", description: "Used by OpenAI image nodes. Empty: the default key." },
  baseUrl: { type: t.text(), title: "API base URL", default: OPENAI_BASE_URL, description: "Change it for a proxy or an OpenAI-compatible server." },
};

/** Settings of every OpenAI node. */
export const nodeSettings = {
  category: "AI",
  icon: "sparkles",
  color: "mint",
  canFail: true,
  cache: true,
  cacheVersion: "1",
  retry: 2,
  timeoutMs: 300_000,
} as const;

/** The key and base URL a node calls with. */
export async function connection(ctx: ExecContext, job: "textKey" | "imageKey"): Promise<{ apiKey: string; baseUrl: string }> {
  const ref = ((await ctx.settings.get(job)) as string | null) ?? ((await ctx.settings.get("defaultKey")) as string | null);
  if (!ref) {
    throw new NodeError(
      "openai.no_key",
      `No OpenAI API key is set. Pick one in Settings → OpenAI (${job === "textKey" ? "Key for text" : "Key for images"} or Default API key).`,
      { retryable: false },
    );
  }
  const apiKey = await ctx.secrets.read(ref);
  const base = ((await ctx.settings.get("baseUrl")) as string | null) || OPENAI_BASE_URL;
  return { apiKey, baseUrl: base.replace(/\/+$/, "") };
}
