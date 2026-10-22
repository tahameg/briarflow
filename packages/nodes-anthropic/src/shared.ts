/**
 * What both Claude nodes share: config fields, request building, usage and refusal handling.
 */
import { NodeError, cfg, defineStruct, t, type ExecContext } from "@briarflow/core";
import { callMessages, type MessagesResponse } from "./http.js";

/** Options of {@link anthropicPack}. All optional. */
export interface AnthropicPackOptions {
  /** Replaces `ctx.fetch` for API calls (tests, proxies, custom agents). */
  fetch?: typeof fetch;
  /** API base URL without trailing slash. Default "https://api.anthropic.com/v1". */
  baseUrl?: string;
}

/** Secret holding the API key. */
export const ANTHROPIC_SECRET = "ANTHROPIC_API_KEY";

/** Known model ids (for docs and UIs); the `model` config accepts any id. */
export const ANTHROPIC_MODELS: readonly string[] = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-opus-5", "claude-fable-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** `anthropic.Usage`: token counts of one call. */
export const Usage = defineStruct("Usage", {
  inputTokens: t.int({ min: 0 }),
  outputTokens: t.int({ min: 0 }),
});

/** Config fields of every Claude node. */
export const modelConfig = {
  model: cfg.text({ default: "claude-sonnet-5-5", title: "Model", description: `Model id, e.g. ${ANTHROPIC_MODELS.join(", ")}.` }),
  effort: cfg.choice(["default", "low", "medium", "high", "xhigh", "max"], {
    default: "default",
    title: "Effort",
    description: "How much the model thinks. 'default' uses the model's own default.",
  }),
  refusalFallback: cfg.boolean({
    default: true,
    title: "Refusal fallback",
    description: "If the model declines for safety reasons, let the API retry on a fallback model in the same call.",
  }),
};

/** Common inputs: prompt, optional system text, output budget. */
export const promptInputs = {
  prompt: { type: t.text({ multiline: true }), widget: "textarea" },
  system: { type: t.optional(t.text({ multiline: true })), default: null, widget: "textarea" },
  maxTokens: { type: t.int({ min: 1, max: 128_000 }), default: 16_000, description: "Upper bound on output tokens." },
} as const;

/** Node settings shared by both nodes (phase-8.md §3.3). */
export const nodeSettings = {
  category: "AI",
  icon: "bot",
  color: "pink",
  secrets: [ANTHROPIC_SECRET],
  cache: true,
  cacheVersion: "1",
  retry: 2,
  timeoutMs: 300_000,
} as const;

/** One request to send. */
export interface ClaudeRequest {
  config: { model: string; effort: string; refusalFallback: boolean };
  prompt: string;
  system: string | null;
  maxTokens: number;
  /** Extra body fields (temperature, output_config.format, …). */
  extra?: Record<string, unknown>;
  /** Merged into `output_config`. */
  outputConfig?: Record<string, unknown>;
}

/** Sends a request on behalf of a node, with progress, a size-only debug log and the key from secrets. */
export async function sendClaude(ctx: ExecContext, options: AnthropicPackOptions, req: ClaudeRequest): Promise<MessagesResponse> {
  const apiKey = await ctx.secrets.get(ANTHROPIC_SECRET);
  const outputConfig: Record<string, unknown> = { ...req.outputConfig };
  if (req.config.effort !== "default") outputConfig["effort"] = req.config.effort;
  const fallback = req.config.refusalFallback && FALLBACK_MODELS.has(req.config.model);
  const body: Record<string, unknown> = {
    model: req.config.model,
    max_tokens: req.maxTokens,
    messages: [{ role: "user", content: req.prompt }],
    ...(req.system !== null && req.system !== "" ? { system: req.system } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(fallback ? { fallbacks: "default" } : {}),
    ...req.extra,
  };
  ctx.progress(0.1, "Calling Anthropic");
  ctx.log.debug("anthropic.request", { model: req.config.model, promptChars: req.prompt.length, maxTokens: req.maxTokens });
  const res = await callMessages({
    fetch: options.fetch ?? ctx.fetch,
    baseUrl: (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, ""),
    apiKey,
    body,
    signal: ctx.signal,
    ...(fallback ? { betas: [FALLBACK_BETA] } : {}),
  });
  ctx.progress(0.9, "Reading response");
  if (res.stop_reason === "refusal") {
    const category = res.stop_details?.category ?? null;
    throw new NodeError(
      "node.content_refused",
      `Claude (${res.model}) declined this request${category ? ` (category: ${category})` : ""}. Rephrase the prompt or pick another model.`,
      { retryable: false, details: { category } },
    );
  }
  return res;
}

/** All text blocks joined. */
export function textOf(res: MessagesResponse): string {
  return res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}

/** The `anthropic.Usage` value of a response. */
export function usageOf(res: MessagesResponse): { inputTokens: number; outputTokens: number } {
  return { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 };
}
