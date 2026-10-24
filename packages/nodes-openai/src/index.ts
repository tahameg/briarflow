/**
 * @briarflow/nodes-openai — OpenAI nodes over plain `fetch` (no SDK, portable): `openai.text`
 * (Responses API) and `openai.image` (Images API). API keys are vault secrets picked in
 * Settings → OpenAI (one per job, or a default).
 *
 * @example
 * ```ts
 * const briar = createBriar({ packs: [openaiPack()], vault });
 * await briar.vault.create({ name: "OPENAI_KEY", kind: "apiKey", value: "sk-…" });
 * await briar.settings.set("openai.defaultKey", "OPENAI_KEY");
 * ```
 */
import { definePack, type NodePack } from "@briarflow/core";
import { openaiImage } from "./image.js";
import { openaiSettings, type OpenAIPackOptions } from "./shared.js";
import { openaiText, Usage } from "./text.js";

export const PACKAGE_NAME = "@briarflow/nodes-openai";

export { OPENAI_BASE_URL, OPENAI_IMAGE_MODELS, OPENAI_TEXT_MODELS } from "./shared.js";
export type { OpenAIPackOptions } from "./shared.js";
export { redact, retryAfterMs } from "./http.js";
export { answerText } from "./text.js";
export { decodeBase64 } from "./image.js";

/**
 * The `openai` pack: `openai.text` and `openai.image`, with key settings.
 *
 * @example
 * ```ts
 * const pack = openaiPack({ fetch: myFetch });
 * ```
 */
export function openaiPack(options: OpenAIPackOptions = {}): NodePack {
  return definePack({
    name: "openai",
    version: "0.1.0",
    title: "OpenAI",
    description: "OpenAI text and image models. Pick the API keys in Settings → OpenAI.",
    types: [Usage],
    settings: openaiSettings,
    nodes: [openaiText(options), openaiImage(options)],
  });
}
