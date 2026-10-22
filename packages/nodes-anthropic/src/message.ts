/**
 * `anthropic.message`: system + prompt → text.
 */
import { defineNode, t } from "@briarflow/core";
import { modelConfig, nodeSettings, promptInputs, sendClaude, textOf, usageOf, Usage, type AnthropicPackOptions } from "./shared.js";

/** Builds the `anthropic.message` node for a pack instance. */
export function claudeMessage(options: AnthropicPackOptions) {
  return defineNode({
    type: "anthropic.message",
    title: "Claude message",
    description: "Sends a prompt (and optional system text) to Claude and returns the reply text.",
    ...nodeSettings,
    config: modelConfig,
    inputs: {
      ...promptInputs,
      temperature: {
        type: t.optional(t.float({ min: 0, max: 1 })),
        default: null,
        description: "Sampling temperature. Leave empty: current models reject custom values.",
      },
    },
    outputs: { text: t.text(), usage: t.ref(Usage), stopReason: t.text(), model: t.text() },
    async run({ inputs, config, ctx }) {
      const res = await sendClaude(ctx, options, {
        config,
        prompt: inputs.prompt,
        system: inputs.system,
        maxTokens: inputs.maxTokens,
        ...(inputs.temperature !== null ? { extra: { temperature: inputs.temperature } } : {}),
      });
      ctx.progress(1);
      return { text: textOf(res), usage: usageOf(res), stopReason: res.stop_reason ?? "end_turn", model: res.model };
    },
  });
}
