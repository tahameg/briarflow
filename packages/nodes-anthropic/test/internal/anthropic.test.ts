import { NodeError, createCatalog } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { context, describeNodePack, expectBriarRejection, field, ir, runNode, struct } from "@briarflow/testing";
import { describe, expect, it } from "vitest";
import { anthropicPack, redact, retryAfterMs, structuredSchema } from "../../src/index.js";

const KEY = "sk-ant-test-0123456789";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records requests and answers with the given responses in order. */
function fakeFetch(...responses: (() => Response)[]) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (!next) throw new Error("no response configured");
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const reply = (content: unknown[], extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ model: "claude-sonnet-5-5", stop_reason: "end_turn", content, usage: { input_tokens: 12, output_tokens: 7 }, ...extra }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const failure = (status: number, type: string, message: string, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), { status, headers: { "content-type": "application/json", ...headers } });

const CHAR_CONTEXT = context({
  types: [
    struct("ty_char", "Character", [
      field("name", ir.text({ maxLength: 40 })),
      field("age", ir.int({ min: 0, max: 200 })),
      field("title", ir.optional(ir.text())),
    ]),
    struct("ty_pic", "Picture", [field("image", ir.image())]),
  ],
});

function nodeOf(type: string, fetchFn: typeof fetch) {
  const pack = anthropicPack({ fetch: fetchFn });
  const def = pack.nodes.find((n) => n.type === type);
  if (!def) throw new Error(type);
  return def;
}
const packs = [anthropicPack()];

describeNodePack(anthropicPack({ fetch: fakeFetch(reply([{ type: "text", text: "hi" }])).fn }), {
  samples: {
    "anthropic.message": [{ inputs: { prompt: "Hello" }, secrets: { ANTHROPIC_API_KEY: KEY }, check: (r) => expect(r.outputs["text"]).toBe("hi") }],
    "anthropic.structured": [{ inputs: { prompt: "x" }, config: { typeId: "ty_char" }, context: CHAR_CONTEXT, secrets: {}, errorCode: "node.missing_secret" }],
  },
});

describe("anthropic.message", () => {
  it("sends a Messages request with headers, system, default model and fallback, and returns text + usage", async () => {
    const f = fakeFetch(reply([{ type: "thinking", thinking: "" }, { type: "text", text: "Hello " }, { type: "text", text: "there" }]));
    const { outputs, progress } = await runNode(nodeOf("anthropic.message", f.fn), { prompt: "Say hi", system: "Be brief" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs });
    expect(outputs).toEqual({ text: "Hello there", usage: { inputTokens: 12, outputTokens: 7 }, stopReason: "end_turn", model: "claude-sonnet-5-5" });
    expect(progress.map((p) => p.fraction)).toEqual([0.1, 0.9, 1]);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" });
    expect(call.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "Be brief",
      messages: [{ role: "user", content: "Say hi" }],
      fallbacks: "default",
    });
  });

  it("sends effort and temperature only when set; no fallback for models without it", async () => {
    const f = fakeFetch(reply([{ type: "text", text: "ok" }]));
    await runNode(nodeOf("anthropic.message", f.fn), { prompt: "p", temperature: 0.2, maxTokens: 50 }, {
      secrets: { ANTHROPIC_API_KEY: KEY },
      packs,
      config: { model: "claude-haiku-5-5", effort: "low" },
    });
    expect(f.calls[0]!.body).toEqual({ model: "claude-haiku-5-5", max_tokens: 50, messages: [{ role: "user", content: "p" }], output_config: { effort: "low" }, temperature: 0.2 });
    expect(f.calls[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("maps a refusal to node.content_refused", async () => {
    const f = fakeFetch(reply([], { stop_reason: "refusal", stop_details: { category: "cyber" } }));
    const err = await expectBriarRejection(runNode(nodeOf("anthropic.message", f.fn), { prompt: "p" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs }), "node.content_refused");
    expect(err.details).toEqual({ category: "cyber" });
  });

  it.each([
    [429, "rate_limit_error", "node.rate_limited", true],
    [529, "overloaded_error", "node.unavailable", true],
    [500, "api_error", "node.unavailable", true],
    [401, "authentication_error", "anthropic.unauthorized", false],
    [404, "not_found_error", "anthropic.not_found", false],
    [413, "request_too_large", "anthropic.request_too_large", false],
    [400, "invalid_request_error", "anthropic.bad_request", false],
  ])("maps HTTP %i to %s", async (status, type, code, retryable) => {
    const f = fakeFetch(failure(status, type, `bad thing with key ${KEY}`, { "retry-after": "3" }));
    const err = await expectBriarRejection(runNode(nodeOf("anthropic.message", f.fn), { prompt: "p" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs }), code, NodeError);
    expect((err as NodeError).retryable).toBe(retryable);
    expect(err.details).toEqual({ status, type, retryAfterMs: 3000 });
    expect(err.message).not.toContain(KEY);
  });

  it("wraps network failures as retryable node.unavailable and passes the abort signal", async () => {
    let seen: AbortSignal | undefined;
    const fn = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const err = await expectBriarRejection(runNode(nodeOf("anthropic.message", fn), { prompt: "p" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs, signal }), "node.unavailable");
    expect((err as NodeError).retryable).toBe(true);
    expect(seen).toBe(signal);
  });

  it("rethrows the abort when the run is cancelled", async () => {
    const ac = new AbortController();
    const fn = (async () => {
      ac.abort(new Error("cancelled"));
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    await expect(runNode(nodeOf("anthropic.message", fn), { prompt: "p" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs, signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("anthropic.structured", () => {
  const run = (f: ReturnType<typeof fakeFetch>, typeId = "ty_char") =>
    runNode(nodeOf("anthropic.structured", f.fn), { prompt: "Invent a knight" }, { secrets: { ANTHROPIC_API_KEY: KEY }, packs, config: { typeId }, context: CHAR_CONTEXT });

  it("sends a JSON-outputs schema and returns the normalized struct", async () => {
    const f = fakeFetch(reply([{ type: "text", text: '{"name":"Aria","age":31,"title":null}' }]));
    const { outputs } = await run(f);
    expect(outputs).toEqual({ value: { name: "Aria", age: 31, title: null }, usage: { inputTokens: 12, outputTokens: 7 }, model: "claude-sonnet-5-5" });
    const format = (f.calls[0]!.body["output_config"] as { format: { type: string; schema: Record<string, unknown> } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.schema).toMatchObject({ type: "object", additionalProperties: false, required: ["name", "age", "title"] });
    expect(JSON.stringify(format.schema)).not.toMatch(/"(maxLength|minimum|maximum|\$schema)"/);
    expect(f.calls[0]!.body["tool_choice"]).toBeUndefined();
  });

  it("rejects answers that break the type (retryable) or are not JSON", async () => {
    const tooOld = await expectBriarRejection(run(fakeFetch(reply([{ type: "text", text: '{"name":"Aria","age":999,"title":null}' }]))), "anthropic.invalid_output");
    expect((tooOld as NodeError).retryable).toBe(true);
    await expectBriarRejection(run(fakeFetch(reply([{ type: "text", text: "Sure! Here it is" }]))), "anthropic.invalid_output");
  });

  it("reports truncation, unknown types and media fields", async () => {
    await expectBriarRejection(run(fakeFetch(reply([{ type: "text", text: '{"na' }], { stop_reason: "max_tokens" }))), "anthropic.output_truncated");
    await expectBriarRejection(run(fakeFetch(reply([])), "ty_pic"), "anthropic.unsupported_type");
    expect(() => structuredSchema("ty_missing", () => undefined)).toThrow(/does not exist/);
  });
});

describe("helpers", () => {
  it("parses retry-after in ms, seconds and HTTP dates", () => {
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:10 GMT" }), () => Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(10_000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });

  it("redacts the key and key-like tokens", () => {
    expect(redact(`key ${KEY} and sk-proj-abcdefghijk`, KEY)).toBe("key [redacted] and [redacted]");
  });

  it("loads next to std and mock without namespace conflicts", () => {
    expect(() => createCatalog([stdPack, mockPack, anthropicPack()])).not.toThrow();
  });
});
