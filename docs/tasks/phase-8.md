# Phase 8 (part 1) — Provider packs: `@briarflow/nodes-anthropic`, `@briarflow/nodes-openai`

Owner: backend-developer (both packages). Tester: conformance via `describeNodePack` +
provider-specific suites with a fake fetch. Lead reviews; packaging (Dockerfile, compose,
README) is part 2 and not covered here. Written by backend-developer, 2026-10-21 (the lead is
on `@briarflow/server`; this breakdown follows the phase-5 format and is open for review).

Specs: `docs/specs/node-api.md` (§1 definitions, §6 ExecContext/errors, §7 packs, §8 naming),
`docs/specs/types.md` §9 (JSON Schema export), `docs/guides/writing-nodes.md` §7 (API-node
checklist).

## 1. Goal

Two shared (portable) node packs that call the providers' HTTP APIs with plain `fetch`:

- no SDK dependencies, no `node:*`, no Node globals (`Buffer`, `process`) in `src/`;
- only dependency: `@briarflow/core`;
- every request takes `ctx.signal`; HTTP failures become `NodeError`s with stable codes;
  429 / 5xx / 529 / network errors are retryable and carry `details.retryAfterMs` when the
  provider says how long to wait;
- secrets are read with `ctx.secrets.get` and never logged or echoed in error messages.

**Exit check:** `npm run typecheck` and `npm test` green with no network access (tests use a
fake fetch injected through the pack options). An optional live test runs only when the
provider key is set in the environment.

## 2. Package layout (same for both packs)

| Path | Contents |
|---|---|
| `package.json` | `@briarflow/nodes-anthropic` / `@briarflow/nodes-openai`; deps `@briarflow/core` only |
| `src/index.ts` | public surface (§3) |
| `src/http.ts` | request helper: headers, signal, error mapping (§4.2), `retry-after` parsing, secret redaction |
| `src/schema.ts` | structured output: type lookup scope from `ctx.resolveType`, provider-safe JSON Schema (§4.3) |
| `src/types.ts` | pack types |
| `src/<node>.ts` | one file per node |
| `test/internal/*.test.ts` | unit tests with a fake fetch; `live.test.ts` env-gated |

`http.ts` / `schema.ts` are kept nearly identical in both packages (packs do not depend on each
other); a shared provider-helper package can come later if a third pack appears.

## 3. Public API

```ts
/** Options of a provider pack. All optional. */
export interface AnthropicPackOptions {        // OpenAIPackOptions is the same shape
  /** Replaces `ctx.fetch` for API calls (tests, proxies, custom agents). */
  fetch?: typeof fetch;
  /** API base URL without trailing slash. Default "https://api.anthropic.com/v1" / "https://api.openai.com/v1". */
  baseUrl?: string;
}

export function anthropicPack(options?: AnthropicPackOptions): NodePack;   // name "anthropic", version "0.1.0"
export function openaiPack(options?: OpenAIPackOptions): NodePack;         // name "openai", version "0.1.0"

export const ANTHROPIC_MODELS: readonly string[];  // known ids, for docs/UIs; config accepts any id
export const OPENAI_DEFAULT_MODELS: { chat: string; image: string };
```

Usage: `createBriar({ packs: [stdPack, anthropicPack(), openaiPack()] })`.

### 3.1 `anthropic` pack — secret `ANTHROPIC_API_KEY`

Pack types: `anthropic.Usage` struct `{ inputTokens: int, outputTokens: int }`.

Config shared by both nodes:

| Config | Kind | Default | Notes |
|---|---|---|---|
| `model` | `cfg.text` | `"claude-sonnet-5-5"` | known: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1` |
| `effort` | `cfg.choice(["default","low","medium","high","xhigh","max"])` | `"default"` | `output_config.effort`; `default` sends nothing (model default) |
| `refusalFallback` | `cfg.boolean` | `true` | on models that support it (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, `claude-opus-5`, `claude-fable-5`) sends `fallbacks: "default"` + beta `server-side-fallback-2026-07-01`, so a safety decline is retried on a fallback model inside the same call; output `model` says which model answered |

| Node | Inputs | Outputs |
|---|---|---|
| `anthropic.message` "Claude message" | `prompt: text` (multiline), `system: text?` (null), `maxTokens: int` (1–128000, 16000), `temperature: float?` (0–1, null) | `text: text`, `usage: anthropic.Usage`, `stopReason: text`, `model: text` |
| `anthropic.structured` "Claude structured output" | config `typeId: cfg.typeId({kind:"struct"})`; `prompt`, `system`, `maxTokens` as above | `value: <struct>`, `usage: anthropic.Usage`, `model: text` |

- `temperature` is sent only when not null. Current models reject custom sampling
  (Opus 5.5: any value; Sonnet/Haiku 5.5: non-default values) — the API's 400 is reported as
  `anthropic.bad_request` with its message. Thinking is never configured explicitly (all
  current models run adaptive thinking by default); only `effort` is exposed.
- `anthropic.structured` uses **JSON outputs** (`output_config.format: { type: "json_schema", schema }`)
  rather than forced tool use: forced `tool_choice` returns 400 on Opus 5.5 / Sonnet 5.5 /
  Fable 5.1. The answer's text block is parsed as JSON and checked with core `normalizeValue`
  against the struct type (constraints included).
- `stop_reason: "refusal"` → `node.content_refused` (details: `category`). For
  `anthropic.message`, `max_tokens` is a normal stop (`stopReason: "max_tokens"`); for
  `anthropic.structured` it is `anthropic.output_truncated` ("raise maxTokens").

### 3.2 `openai` pack — secret `OPENAI_API_KEY`

Pack types: `openai.Usage` struct `{ inputTokens: int, outputTokens: int }`,
`openai.ImageQuality` enum `auto, low, medium, high, xhigh, max`,
`openai.ImageBackground` enum `auto, opaque, transparent`.

| Node | Config | Inputs | Outputs |
|---|---|---|---|
| `openai.chat` "GPT chat" | `model` text (`"gpt-6.1-sol"`), `reasoningEffort` choice (`default, none, minimal, low, medium, high, xhigh`; `default`) | `prompt: text`, `instructions: text?`, `maxOutputTokens: int` (1–128000, 16000), `temperature: float?` (0–2, null) | `text: text`, `usage: openai.Usage`, `finishReason: text` (`"completed"` or the `incomplete_details.reason`), `model: text` |
| `openai.structured` "GPT structured output" | `typeId: cfg.typeId({kind:"struct"})`, `model`, `reasoningEffort` | `prompt`, `instructions`, `maxOutputTokens` | `value: <struct>`, `usage`, `model` |
| `openai.image` "GPT image" | `model` text (`"gpt-image-2.5-flare"`) | `prompt: text` (≤ 32000), `size: text` (`auto` or `WxH`, default `"1024x1024"`), `quality: openai.ImageQuality` (`auto`), `background: openai.ImageBackground` (`auto`) | `image: image` (png) |

- Text nodes use the **Responses API** (`POST /responses`, `store: false`); structured output
  uses `text.format: { type: "json_schema", name, schema, strict: true }`.
- A `refusal` content part, or `incomplete_details.reason === "content_filter"` →
  `node.content_refused`. `max_output_tokens` → `finishReason` for chat,
  `openai.output_truncated` for structured. `status: "failed"` → `openai.request_failed`
  (retryable when the error code is `server_error`).
- `openai.image` posts `POST /images/generations` (`n: 1`, `output_format: "png"`), decodes
  `data[0].b64_json`, stores it with `ctx.media.put(bytes, { mime: "image/png", filename:
  "openai.png", meta: { width, height, revisedPrompt? } })` (size read from the PNG header),
  returns the `MediaRef`. `revised_prompt` is kept in `meta` when present.

### 3.3 Node settings and the cache decision

| Node | `cache` | `retry` | `timeoutMs` | Why |
|---|---|---|---|---|
| `anthropic.message`, `openai.chat` | `true` | 2 | 300 000 | Model output is not bit-for-bit deterministic, but in a pipeline the same prompt + config should reuse the paid answer (like `mock.llm`); a user who wants a fresh answer changes an input or clears the cache. |
| `anthropic.structured`, `openai.structured` | `true` | 2 | 300 000 | Same, and schema-constrained output varies even less. |
| `openai.image` | `false` | 2 | 300 000 | High-variance creative output with no seed: re-running is how users ask for another image, so a cached image would be surprising. Store the result in a variable to reuse it. |

All nodes: category `"AI"`, color `"pink"`, icon `bot` (text/structured) or `image` (image);
`cacheVersion` `"1"`.

## 4. Behaviour

### 4.1 Requests

- Anthropic: `POST {baseUrl}/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`,
  `content-type: application/json` (+ `anthropic-beta` for the refusal fallback). Non-streaming.
- OpenAI: `Authorization: Bearer <key>`, `content-type: application/json`.
- `fetch` is `options.fetch ?? ctx.fetch`, always called with `signal: ctx.signal`.
- Progress: `0.1 "Calling <provider>"` before the request, `0.9 "Reading response"` after it.
- Log: one `debug` line per request with model and sizes only (never prompt text or keys).

### 4.2 HTTP errors → `NodeError`

| Response | Code | Retryable |
|---|---|---|
| network error (`fetch` rejects, signal not aborted) | `node.unavailable` | yes |
| 429 (OpenAI `insufficient_quota`: `openai.quota_exceeded`, not retryable) | `node.rate_limited` | yes |
| 408, 409, 5xx, 529 | `node.unavailable` | yes |
| 401, 403 | `<pack>.unauthorized` ("check <SECRET>") | no |
| 404 | `<pack>.not_found` (usually an unknown model id) | no |
| 413 | `<pack>.request_too_large` | no |
| 400 / 422 / other | `<pack>.bad_request` (provider message) | no |
| 2xx with unparsable body | `<pack>.invalid_response` | yes |

`details`: `{ status, type?, retryAfterMs? }`. `retryAfterMs` comes from `retry-after-ms`,
else `retry-after` (seconds or HTTP date). Provider error messages are included after
redaction: the API key and any `sk-…` token are replaced with `[redacted]`.

### 4.3 Structured output schema

1. `ctx.resolveType(config.typeId)` must be a struct, else `<pack>.unknown_type`.
2. `toJsonSchema({kind:"named", id}, scope, { strict: true })` with a `TypeScope` adapter over
   `ctx.resolveType` (`getType` only); the root `$ref` is inlined so the root is an object.
3. Media fields anywhere in the type → `<pack>.unsupported_type` (a model cannot produce stored
   media).
4. Keywords providers reject are removed and turned into a description hint
   (`minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `pattern`), along
   with `$schema`, `default`, `x-*`. Recursive types are passed through (the provider may
   reject them with `bad_request`).
5. The answer is parsed (`<pack>.invalid_output` if not JSON, retryable) and checked with
   `normalizeValue` (constraints included); a violation is `<pack>.invalid_output`, retryable,
   with the first diagnostic in the message and all of them in `details.diagnostics`.

## 5. Tasks

### Backend developer
1. Both packages per §2–§4, with unit tests in `test/internal/` (fake fetch; requests,
   responses, error mapping, retry-after, signal, redaction, structured validation, media).
2. Env-gated live tests (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`), skipped by default.
3. Request to the lead (REQ-26): add both packages to `SHARED_PACKAGES` in
   `scripts/check-boundaries.mjs` and to `tsconfig.shared.json`.

### Tester
- `describeNodePack(anthropicPack({ fetch }))` / `openaiPack` with samples using a fake fetch.

### Lead
- Review; root config (REQ-26); STATUS.

## 6. Acceptance criteria

1. Both packs pass `describeNodePack` and load in `createCatalog([stdPack, mockPack, anthropicPack(), openaiPack()])` with no namespace conflict.
2. No `node:*`, Node globals or non-core dependencies under either `src/`; both typecheck under the shared (no-Node) program once REQ-26 is done.
3. Every request carries `ctx.signal`; aborting rejects the run promptly.
4. Error mapping per §4.2, including `retryAfterMs` from both header forms.
5. No secret value appears in any thrown error message, details or log line (tested).
6. Structured nodes return values that pass `normalizeValue` for the configured struct, or fail with `<pack>.invalid_output`.
7. `openai.image` returns a `MediaRef` from `ctx.media.put` with `mime: "image/png"` and width/height in `meta`.
8. `npm run typecheck` and `npm test` green offline.
