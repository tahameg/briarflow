/**
 * `openai.text`: prompt (+ instructions) → text, through the Responses API.
 */
import { cfg, defineNode, defineStruct, NodeError, t, variant, type ExecContext } from "@briarflow/core";
import { callOpenAI } from "./http.js";
import { connection, nodeSettings, OPENAI_TEXT_MODELS, type OpenAIPackOptions } from "./shared.js";

/** `openai.Usage`: token counts of one call. */
export const Usage = defineStruct("Usage", {
  inputTokens: t.int({ min: 0 }),
  outputTokens: t.int({ min: 0 }),
});

/** The parts of a Responses API answer the node reads. */
export interface ResponsesAnswer {
  model: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: readonly { type: string; content?: readonly { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Output text of an answer; a refusal fails with `node.content_refused`. */
export function answerText(res: ResponsesAnswer): string {
  let text = "";
  for (const item of res.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
      if (part.type === "refusal") {
        throw new NodeError("node.content_refused", `The model (${res.model}) declined: ${part.refusal ?? "no reason given"}. Rephrase the prompt.`, { retryable: false });
      }
    }
  }
  return text;
}

/** Ports every text variant has. */
const textInputs = {
  prompt: { type: t.text({ multiline: true }), widget: "textarea" },
  instructions: { type: t.optional(t.text({ multiline: true })), default: null, widget: "textarea", description: "System-level instructions." },
  maxTokens: { type: t.optional(t.int({ min: 16, max: 128_000 })), default: null, description: "Upper bound on output tokens. Empty: the model's limit." },
} as const;
const temperature = {
  temperature: { type: t.optional(t.float({ min: 0, max: 2 })), default: null, description: "Sampling temperature (0–2). Empty: the model's default." },
} as const;
const textOutputs = { text: t.text(), usage: t.ref(Usage), model: t.text(), complete: t.boolean() };
const reasoningConfig = {
  reasoning: cfg.choice(["default", "minimal", "low", "medium", "high"], {
    default: "default",
    title: "Reasoning effort",
    description: "How long the model thinks before answering. 'default' leaves it to the model.",
  }),
};

/** Reasoning models take a reasoning effort and no temperature; the others take a temperature. */
const REASONING_MODELS: readonly string[] = ["gpt-5", "gpt-5-mini", "gpt-5-nano"];
const CHAT_MODELS: readonly string[] = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"];

interface TextCall {
  model: string;
  prompt: string;
  instructions: string | null;
  maxTokens: number | null;
  temperature?: number | null;
  reasoning?: string;
}

/** Builds the `openai.text` node for a pack instance: one variant per model. */
export function openaiText(options: OpenAIPackOptions) {
  const respond = async (call: TextCall, ctx: ExecContext) => {
    const { apiKey, baseUrl } = await connection(ctx, "textKey");
    const body: Record<string, unknown> = {
      model: call.model,
      input: call.prompt,
      ...(call.instructions ? { instructions: call.instructions } : {}),
      ...(call.maxTokens !== null ? { max_output_tokens: call.maxTokens } : {}),
      ...(call.temperature !== undefined && call.temperature !== null ? { temperature: call.temperature } : {}),
      ...(call.reasoning !== undefined && call.reasoning !== "default" ? { reasoning: { effort: call.reasoning } } : {}),
      store: false,
    };
    ctx.progress(0.1, "Calling OpenAI");
    ctx.log.debug("openai.request", { model: call.model, promptChars: call.prompt.length });
    const res = await callOpenAI<ResponsesAnswer>({ fetch: options.fetch ?? ctx.fetch, baseUrl, path: "/responses", apiKey, body, signal: ctx.signal });
    ctx.progress(1);
    return {
      text: answerText(res),
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      model: res.model ?? call.model,
      complete: res.status !== "incomplete",
    };
  };
  const reasoningModel = (model: string) =>
    variant({
      description: `${model}: a reasoning model. Set how hard it thinks with Reasoning effort.`,
      config: reasoningConfig,
      inputs: textInputs,
      outputs: textOutputs,
      run: ({ inputs, config, ctx }) => respond({ model, ...inputs, reasoning: config.reasoning }, ctx),
    });
  const chatModel = (model: string) =>
    variant({
      description: `${model}: a non-reasoning model with a sampling temperature.`,
      inputs: { ...textInputs, ...temperature },
      outputs: textOutputs,
      run: ({ inputs, ctx }) => respond({ model, ...inputs }, ctx),
    });
  return defineNode({
    type: "openai.text",
    title: "OpenAI text",
    description: "Sends a prompt (and optional instructions) to an OpenAI model and returns the reply text. Pick the model on the node: its inputs follow the model.",
    ...nodeSettings,
    variants: {
      title: "Model",
      default: "gpt-5-mini",
      options: {
        ...Object.fromEntries(REASONING_MODELS.map((m) => [m, reasoningModel(m)])),
        ...Object.fromEntries(CHAT_MODELS.map((m) => [m, chatModel(m)])),
        other: variant({
          title: "Other model",
          description: "Any model id the Responses API accepts. Leave settings a model does not support empty.",
          config: {
            model: cfg.text({ title: "Model id", description: `e.g. ${OPENAI_TEXT_MODELS.join(", ")}` }),
            ...reasoningConfig,
          },
          inputs: { ...textInputs, ...temperature },
          outputs: textOutputs,
          run: ({ inputs, config, ctx }) => respond({ model: config.model, ...inputs, reasoning: config.reasoning }, ctx),
        }),
      },
    },
  });
}
