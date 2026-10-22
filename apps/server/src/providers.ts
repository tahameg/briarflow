/**
 * Optional provider packs, enabled when their API key is set. Keys are read again at run time
 * through `envSecrets()`; here they only decide whether the pack is offered at all.
 */
import type { NodePack } from "@briarflow/core";
import { anthropicPack } from "@briarflow/nodes-anthropic";
import type { ServerConfig } from "./config.js";

/** Packs of the providers whose keys are configured. */
export function loadProviderPacks(config: ServerConfig): NodePack[] {
  const packs: NodePack[] = [];
  if (config.providerKeys.anthropic) packs.push(anthropicPack());
  return packs;
}
