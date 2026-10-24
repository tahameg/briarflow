import type { MediaRef } from "@briarflow/core";
import { describeNodePack, runNode } from "@briarflow/testing";
import { describe, expect, it } from "vitest";
import { answerText, decodeBase64, openaiPack, redact } from "../../src/index.js";

const KEY = "sk-openai-test-0123456789";
const PNG_B64 = "iVBORw0KGgo="; // the PNG signature

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(...responses: (() => Response)[]) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error("no response configured");
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const textAnswer = (text: string, extra: Record<string, unknown> = {}) =>
  json({
    model: "gpt-5-mini-2026-01-01",
    status: "completed",
    output: [{ type: "reasoning" }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 9, output_tokens: 4 },
    ...extra,
  });

function nodeOf(type: string, fetchFn: typeof fetch) {
  const pack = openaiPack({ fetch: fetchFn });
  const def = pack.nodes.find((n) => n.type === type);
  if (!def) throw new Error(type);
  return { def, packs: [pack] };
}

describeNodePack(openaiPack({ fetch: fakeFetch(textAnswer("hi")).fn }), {
  samples: {
    "openai.text": [
      { inputs: { prompt: "Hello" }, vault: { OPENAI_KEY: KEY }, settings: { defaultKey: "OPENAI_KEY" }, check: (r) => expect(r.outputs["text"]).toBe("hi") },
      { name: "no key", inputs: { prompt: "Hello" }, errorCode: "openai.no_key" },
    ],
    "openai.image": [{ inputs: { prompt: "A cat" }, errorCode: "openai.no_key" }],
  },
});

describe("openai.text", () => {
  it("calls the Responses API with the key from the job setting and returns text and usage", async () => {
    const f = fakeFetch(textAnswer("Hello there"));
    const { def, packs } = nodeOf("openai.text", f.fn);
    const r = await runNode(def, { prompt: "Say hi", instructions: "Be brief", maxTokens: 100 }, {
      packs,
      variant: "gpt-5",
      config: { reasoning: "low" },
      vault: { TEXT: KEY, OTHER: "sk-other-key-000000" },
      settings: { textKey: "TEXT", defaultKey: "OTHER" },
    });
    expect(r.outputs).toEqual({ text: "Hello there", usage: { inputTokens: 9, outputTokens: 4 }, model: "gpt-5-mini-2026-01-01", complete: true });
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(f.calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(f.calls[0]!.body).toEqual({ model: "gpt-5", input: "Say hi", instructions: "Be brief", max_output_tokens: 100, reasoning: { effort: "low" }, store: false });
  });

  it("reasoning models take an effort, the others a temperature, Other model any id", async () => {
    const f = fakeFetch(textAnswer("a"));
    const { def, packs } = nodeOf("openai.text", f.fn);
    const options = { packs, vault: { K: KEY }, settings: { defaultKey: "K" } };
    expect(Object.keys(def.inputs)).not.toContain("temperature");
    await runNode(def, { prompt: "x", temperature: 0.3 }, { ...options, variant: "gpt-4o" });
    expect(f.calls[0]!.body).toMatchObject({ model: "gpt-4o", temperature: 0.3 });
    expect(f.calls[0]!.body).not.toHaveProperty("reasoning");
    await runNode(def, { prompt: "x" }, { ...options, variant: "other", config: { model: "o3", reasoning: "high" } });
    expect(f.calls[1]!.body).toMatchObject({ model: "o3", reasoning: { effort: "high" } });
  });

  it("falls back to the default key and a custom base URL", async () => {
    const f = fakeFetch(textAnswer("a"));
    const { def, packs } = nodeOf("openai.text", f.fn);
    await runNode(def, { prompt: "x" }, { packs, vault: { DEF: KEY }, settings: { defaultKey: "DEF", baseUrl: "https://proxy.example/v1/" } });
    expect(f.calls[0]!.url).toBe("https://proxy.example/v1/responses");
    expect(f.calls[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("maps errors and never shows the key", async () => {
    const { def, packs } = nodeOf("openai.text", fakeFetch(json({ error: { message: `bad key ${KEY}`, type: "invalid_request_error" } }, 401)).fn);
    const err = (await runNode(def, { prompt: "x" }, { packs, vault: { K: KEY }, settings: { defaultKey: "K" } }).catch((e: unknown) => e)) as { code: string; message: string };
    expect(err.code).toBe("openai.unauthorized");
    expect(err.message).not.toContain(KEY);
    const quota = nodeOf("openai.text", fakeFetch(json({ error: { code: "insufficient_quota", message: "no money" } }, 429)).fn);
    const quotaErr = (await runNode(quota.def, { prompt: "x" }, { packs: quota.packs, vault: { K: KEY }, settings: { defaultKey: "K" } }).catch((e: unknown) => e)) as { code: string };
    expect(quotaErr.code).toBe("openai.quota_exceeded");
    const limited = nodeOf("openai.text", fakeFetch(json({ error: { message: "slow down" } }, 429, { "retry-after": "2" })).fn);
    expect(await runNode(limited.def, { prompt: "x" }, { packs: limited.packs, vault: { K: KEY }, settings: { defaultKey: "K" } }).catch((e: unknown) => e)).toMatchObject({ code: "node.rate_limited", retryable: true });
  });

  it("reads refusals and incomplete answers", () => {
    expect(() => answerText({ model: "m", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).toThrow(/declined/);
    expect(answerText({ model: "m", output: [{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }] })).toBe("ab");
  });
});

describe("openai.image", () => {
  it("stores the generated image and sends GPT Image options", async () => {
    const f = fakeFetch(json({ data: [{ b64_json: PNG_B64 }] }));
    const { def, packs } = nodeOf("openai.image", f.fn);
    const r = await runNode(def, { prompt: "A cat" }, { packs, config: { size: "1024x1536", quality: "xhigh", format: "webp", compression: 80, background: "transparent", moderation: "low" }, vault: { IMG: KEY }, settings: { imageKey: "IMG" } });
    expect(Object.keys(r.outputs)).toEqual(["image"]);
    expect(await r.media.entry(r.outputs["image"] as MediaRef)).toMatchObject({ mime: "image/webp", meta: { width: 1024, height: 1536 } });
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    expect(f.calls[0]!.body).toEqual({ model: "gpt-image-2.5-flare", prompt: "A cat", n: 1, size: "1024x1536", quality: "xhigh", output_format: "webp", output_compression: 80, background: "transparent", moderation: "low" });
  });

  it("leaves auto settings to the API and reads the picked size back", async () => {
    const f = fakeFetch(json({ data: [{ b64_json: PNG_B64 }], size: "1536x1024" }));
    const { def, packs } = nodeOf("openai.image", f.fn);
    const r = await runNode(def, { prompt: "A cat" }, { packs, variant: "gpt-image-2", config: { compression: 50 }, vault: { K: KEY }, settings: { imageKey: "K" } });
    expect(f.calls[0]!.body).toEqual({ model: "gpt-image-2", prompt: "A cat", n: 1, output_format: "png" });
    expect(await r.media.entry(r.outputs["image"] as MediaRef)).toMatchObject({ mime: "image/png", meta: { width: 1536, height: 1024 } });
  });

  it("sends a custom size and rejects one the models do not take", async () => {
    const f = fakeFetch(json({ data: [{ b64_json: PNG_B64 }] }));
    const { def, packs } = nodeOf("openai.image", f.fn);
    const run = (customSize?: string) =>
      runNode(def, { prompt: "A cat" }, { packs, config: { size: "custom", ...(customSize === undefined ? {} : { customSize }) }, vault: { K: KEY }, settings: { imageKey: "K" } });
    await run("1536x864");
    expect(f.calls[0]!.body["size"]).toBe("1536x864");
    for (const bad of [undefined, "big", "1000x1000", "4096x1024", "3840x960", "512x512"]) {
      expect(await run(bad).catch((e: unknown) => e)).toMatchObject({ code: "openai.invalid_size" });
    }
    expect(f.calls).toHaveLength(1);
  });

  it("each model is a variant; the GPT Image 1.x models are deprecated", () => {
    const { def } = nodeOf("openai.image", fakeFetch().fn);
    expect(def.variant).toBe("gpt-image-2.5-flare");
    expect(def.variants?.options.map((o) => o.name)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"]);
    expect(def.variants?.options.filter((o) => o.deprecated !== undefined).map((o) => o.name)).toEqual(["gpt-image-1.5", "gpt-image-1-mini"]);
    expect(Object.keys(def.config)).toEqual(["size", "customSize", "quality", "format", "compression", "background", "moderation"]);
    const legacy = def.variants?.options.find((o) => o.name === "gpt-image-1.5")?.definition;
    expect(Object.keys(legacy?.config ?? {})).toEqual(["size", "quality", "format", "compression", "background", "moderation"]);
  });
});

describe("helpers", () => {
  it("decodes base64 and redacts keys", () => {
    expect([...decodeBase64(PNG_B64)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(redact(`key ${KEY} and sk-abcdefghijk`, KEY)).toBe("key [redacted] and [redacted]");
  });
});
