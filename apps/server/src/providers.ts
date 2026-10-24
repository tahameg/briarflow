/**
 * Provider packs. Anthropic is enabled when its env key is set (read again at run time
 * through `envSecrets()`). OpenAI is always offered: its keys are vault secrets picked in
 * Settings → OpenAI.
 */
import type { NodePack } from "@briarflow/core";
import { anthropicPack } from "@briarflow/nodes-anthropic";
import { openaiPack } from "@briarflow/nodes-openai";
import type { ServerConfig } from "./config.js";

/** Packs of the providers the server offers. */
export function loadProviderPacks(config: ServerConfig): NodePack[] {
  const packs: NodePack[] = [openaiPack()];
  if (config.providerKeys.anthropic) packs.push(anthropicPack());
  return packs;
}
