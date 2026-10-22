/**
 * `anthropic.structured`: prompt → a value of a struct type, via JSON outputs
 * (`output_config.format`). Forced tool use is not used: Opus 5.5 / Sonnet 5.5 / Fable 5.1
 * reject `tool_choice` `any`/`tool` (phase-8.md §3.1).
 */
import { NodeError, cfg, defineNode, normalizeValue, t, type UnknownValue } from "@briarflow/core";
import { structuredSchema } from "./schema.js";
import { modelConfig, nodeSettings, promptInputs, sendClaude, textOf, usageOf, Usage, type AnthropicPackOptions } from "./shared.js";

// Ports from resolvePorts are not qualified by definePack, so the pack type id is spelled out.
const outputs = (typeId: string) => ({ value: t.fromRef({ kind: "named", id: typeId }), usage: t.fromRef({ kind: "named", id: "anthropic.Usage" }), model: t.text() });

/** Builds the `anthropic.structured` node for a pack instance. */
export function claudeStructured(options: AnthropicPackOptions) {
  return defineNode({
    type: "anthropic.structured",
    canFail: true,
    title: "Claude structured output",
    description: "Asks Claude for a value of a struct type; the answer is checked against the type.",
    ...nodeSettings,
    config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }), ...modelConfig },
    inputs: promptInputs,
    outputs: { value: t.var("S"), usage: t.ref(Usage), model: t.text() },
    resolvePorts({ config, scope }) {
      const decl = scope.resolveType(config.typeId);
      if (!decl || decl.kind !== "struct") {
        return { error: { code: "config.unknown_ref", message: `Struct type "${config.typeId}" does not exist in this flow. Pick a struct type.` } };
      }
      return { inputs: promptInputs, outputs: outputs(decl.id) };
    },
    async run({ inputs, config, ctx }) {
      const { schema, scope, type } = structuredSchema(config.typeId, (id) => ctx.resolveType(id));
      const res = await sendClaude(ctx, options, {
        config,
        prompt: inputs.prompt,
        system: inputs.system,
        maxTokens: inputs.maxTokens,
        outputConfig: { format: { type: "json_schema", schema } },
      });
      if (res.stop_reason === "max_tokens") {
        throw new NodeError("anthropic.output_truncated", `Claude ran out of output tokens (maxTokens ${inputs.maxTokens}) before finishing the value. Raise maxTokens.`, {
          retryable: false,
          details: { maxTokens: inputs.maxTokens },
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(textOf(res));
      } catch {
        throw new NodeError("anthropic.invalid_output", "Claude's answer was not valid JSON. The request will be retried.", { retryable: true });
      }
      const checked = normalizeValue(parsed, type, scope);
      if (!checked.ok) {
        const first = checked.diagnostics[0]?.message ?? "it does not match the type";
        throw new NodeError("anthropic.invalid_output", `Claude's answer does not fit the struct: ${first}`, {
          retryable: true,
          details: { diagnostics: checked.diagnostics },
        });
      }
      ctx.progress(1);
      return { value: checked.value as UnknownValue, usage: usageOf(res), model: res.model };
    },
  });
}
