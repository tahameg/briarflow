/**
 * @briarflow/nodes-anthropic — Claude nodes over the Anthropic Messages API, with plain `fetch`
 * (no SDK, portable). Secret: `ANTHROPIC_API_KEY`.
 *
 * @example
 * ```ts
 * // with createBriar / envSecrets from the briarflow facade:
 * const briar = createBriar({ packs: [anthropicPack()], secrets: envSecrets() });
 * ```
 */
import { definePack, type NodePack } from "@briarflow/core";
import { claudeMessage } from "./message.js";
import { Usage, type AnthropicPackOptions } from "./shared.js";
import { claudeStructured } from "./structured.js";

export const PACKAGE_NAME = "@briarflow/nodes-anthropic";

export { ANTHROPIC_MODELS, ANTHROPIC_SECRET } from "./shared.js";
export type { AnthropicPackOptions } from "./shared.js";
export { ANTHROPIC_VERSION, redact, retryAfterMs } from "./http.js";
export { structuredSchema } from "./schema.js";

/**
 * The `anthropic` pack: `anthropic.message` and `anthropic.structured`.
 *
 * @example
 * ```ts
 * const pack = anthropicPack({ baseUrl: "https://my-proxy.example/v1" });
 * ```
 */
export function anthropicPack(options: AnthropicPackOptions = {}): NodePack {
  return definePack({
    name: "anthropic",
    version: "0.1.0",
    title: "Anthropic",
    description: "Claude text and structured output via the Anthropic Messages API.",
    types: [Usage],
    nodes: [claudeMessage(options), claudeStructured(options)],
  });
}
