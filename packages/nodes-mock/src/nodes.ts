/**
 * Mock nodes (docs/specs/node-api.md §10). Deterministic, offline, no secrets.
 */
import {
  cfg,
  defineNode,
  NodeError,
  t,
  type ExecContext,
  type MediaRef,
  type TypeDecl,
  type TypeRef,
  type UnknownValue,
} from "@briarflow/core";
import { firstChars, mockGltf, mockHash, mockSvg, silentWav, sleep } from "./util.js";

const encoder = new TextEncoder();

/** `mock.llm`: a fake chat model. */
export const mockLlm = defineNode({
  type: "mock.llm",
  canFail: true,
  title: "Mock LLM",
  category: "AI",
  icon: "bot",
  color: "pink",
  description: "A fake language model for tests: answers deterministically from the prompt, system text and seed.",
  inputs: {
    prompt: { type: t.text({ multiline: true }), widget: "textarea" },
    system: { type: t.optional(t.text({ multiline: true })), default: null },
    seed: { type: t.int(), default: 0 },
    delayMs: { type: t.int({ min: 0 }), default: 0, description: "Simulated latency." },
  },
  outputs: { text: t.text() },
  async run({ inputs, ctx }) {
    const { prompt, system, seed, delayMs } = inputs;
    const half = Math.floor(delayMs / 2);
    if (half > 0) await sleep(half, ctx.signal);
    ctx.progress(0.5, "Thinking");
    if (delayMs - half > 0) await sleep(delayMs - half, ctx.signal);
    ctx.signal.throwIfAborted();
    const hash = await mockHash({ system, prompt, seed });
    ctx.progress(1);
    return { text: `Mock reply ${hash.slice(0, 8)}: ${firstChars(prompt, 200)}` };
  },
});

type Filler = (type: TypeRef, path: string, field: string) => Promise<unknown>;

async function mockMedia(kind: string, prompt: string, seed: number, path: string, ctx: ExecContext): Promise<MediaRef> {
  const hex = await mockHash({ prompt, seed, path, media: kind });
  if (kind === "model3d") return ctx.media.put(encoder.encode(mockGltf(hex)), { mime: "model/gltf+json", filename: "mock.gltf" });
  if (kind === "audio") return ctx.media.put(silentWav(), { mime: "audio/wav", filename: "mock.wav" });
  if (kind === "video") {
    throw new NodeError(
      "mock.unsupported_type",
      `mock.structured cannot invent video values (field ${path}). Make the field optional (it will be null) or use another type.`,
    );
  }
  return ctx.media.put(encoder.encode(mockSvg(prompt, 64, 64, hex)), {
    mime: "image/svg+xml",
    filename: "mock.svg",
    meta: { width: 64, height: 64 },
  });
}

function filler(prompt: string, seed: number, resolve: (id: string) => TypeDecl | undefined, ctx: ExecContext): Filler {
  const fill: Filler = async (type, path, field) => {
    ctx.signal.throwIfAborted();
    const hex = await mockHash({ prompt, seed, path });
    const n = parseInt(hex.slice(0, 8), 16);
    switch (type.kind) {
      case "optional":
        // An optional video cannot be invented, so it is left empty (node-api.md §10).
        if (type.of.kind === "primitive" && type.of.name === "video") return null;
        return fill(type.of, path, field);
      case "var":
        return null;
      case "list": {
        let count = type.minItems ?? 2;
        if (type.maxItems !== undefined) count = Math.min(count, type.maxItems);
        const items: unknown[] = [];
        for (let i = 0; i < count; i++) items.push(await fill(type.of, `${path}[${i}]`, field));
        return items;
      }
      case "named": {
        const decl = resolve(type.id);
        if (!decl) throw new NodeError("mock.unknown_type", `mock.structured cannot find type ${type.id} (at ${path}).`);
        if (decl.kind === "enum") {
          const members = decl.members;
          if (members.length === 0) throw new NodeError("mock.unknown_type", `Enum ${decl.name} has no members (at ${path}).`);
          return members[n % members.length]?.value ?? null;
        }
        const out: Record<string, unknown> = {};
        for (const f of decl.fields) out[f.name] = await fill(f.type, `${path}.${f.name}`, f.name);
        return out;
      }
      case "primitive": {
        const c = (type.constraints ?? {}) as { min?: number; max?: number; minLength?: number; maxLength?: number };
        switch (type.name) {
          case "text": {
            let s = `${field} ${hex.slice(0, 4)}`;
            if (c.minLength !== undefined) while (Array.from(s).length < c.minLength) s += hex;
            if (c.maxLength !== undefined) s = firstChars(s, c.maxLength);
            return s;
          }
          case "int":
          case "float": {
            let lo = c.min ?? (c.max !== undefined ? Math.min(0, c.max - 99) : 0);
            let hi = c.max ?? lo + 99;
            if (type.name === "int") {
              lo = Math.ceil(lo);
              hi = Math.floor(hi);
              return hi <= lo ? lo : lo + (n % (hi - lo + 1));
            }
            const steps = Math.floor((hi - lo) * 100);
            return steps <= 0 ? lo : Math.min(hi, lo + (n % (steps + 1)) / 100);
          }
          case "boolean":
            return n % 2 === 0;
          default:
            return mockMedia(type.name, prompt, seed, path, ctx);
        }
      }
    }
  };
  return fill;
}

/** `mock.structured`: fills a struct deterministically from `hash({prompt, seed, path})`. */
export const mockStructured = defineNode({
  type: "mock.structured",
  canFail: true,
  title: "Mock structured output",
  category: "AI",
  icon: "bot",
  color: "pink",
  description: "A fake structured-output model: fills the chosen struct with deterministic values.",
  config: { typeId: cfg.typeId({ kind: "struct", title: "Struct" }) },
  inputs: { prompt: { type: t.text({ multiline: true }), widget: "textarea" }, seed: { type: t.int(), default: 0 } },
  outputs: { value: t.var("S") },
  resolvePorts({ config, scope }) {
    const decl = scope.resolveType(config.typeId);
    if (!decl || decl.kind !== "struct") {
      return { error: { code: "config.unknown_ref", message: `Struct type "${config.typeId}" does not exist in this flow. Pick a struct type.` } };
    }
    return {
      inputs: { prompt: { type: t.text({ multiline: true }), widget: "textarea" }, seed: { type: t.int(), default: 0 } },
      outputs: { value: t.fromRef({ kind: "named", id: decl.id }) },
    };
  },
  async run({ inputs, config, ctx }) {
    // Required by core's ExecContext; guarded for hand-written contexts in plain JS.
    if (typeof ctx.resolveType !== "function") {
      throw new NodeError("mock.no_type_lookup", "mock.structured needs the engine's type lookup (ctx.resolveType). Run it inside a Briarflow engine.");
    }
    const prompt = String(inputs.prompt);
    const seed = Number(inputs.seed ?? 0);
    const resolve = (id: string): TypeDecl | undefined => ctx.resolveType(id);
    const value = await filler(prompt, seed, resolve, ctx)({ kind: "named", id: config.typeId }, "value", "value");
    return { value: value as UnknownValue };
  },
});

/** `mock.image`: a deterministic SVG stored through `ctx.media`. */
export const mockImage = defineNode({
  type: "mock.image",
  canFail: true,
  title: "Mock image",
  category: "Image",
  icon: "image",
  color: "peach",
  description: "A fake image generator: draws a deterministic SVG with the prompt written on it.",
  inputs: {
    prompt: { type: t.text({ multiline: true }), widget: "textarea" },
    width: { type: t.int({ min: 1, max: 4096 }), default: 512 },
    height: { type: t.int({ min: 1, max: 4096 }), default: 512 },
    seed: { type: t.int(), default: 0 },
  },
  outputs: { image: t.image() },
  async run({ inputs, ctx }) {
    const { prompt, width, height, seed } = inputs;
    const hex = await mockHash({ prompt, seed });
    ctx.progress(0.5, "Drawing");
    const svg = mockSvg(prompt, width, height, hex);
    ctx.signal.throwIfAborted();
    const image = await ctx.media.put(encoder.encode(svg), { mime: "image/svg+xml", filename: "mock.svg", meta: { width, height } });
    return { image };
  },
});

/** `mock.model3d`: a minimal glTF cube whose color comes from the hash. */
export const mockModel3d = defineNode({
  type: "mock.model3d",
  canFail: true,
  title: "Mock 3D model",
  category: "3D",
  icon: "box",
  color: "peach",
  description: "A fake 3D generator: a glTF cube colored from the prompt and seed.",
  inputs: { prompt: { type: t.text({ multiline: true }), widget: "textarea" }, seed: { type: t.int(), default: 0 } },
  outputs: { model: t.model3d() },
  async run({ inputs, ctx }) {
    const hex = await mockHash({ prompt: inputs.prompt, seed: inputs.seed });
    ctx.signal.throwIfAborted();
    const model = await ctx.media.put(encoder.encode(mockGltf(hex)), { mime: "model/gltf+json", filename: "mock.gltf" });
    return { model };
  },
});

/** `mock.delay`: passes a value through after `ms`, reporting progress; honours cancellation. */
export const mockDelay = defineNode({
  type: "mock.delay",
  canFail: true,
  title: "Delay",
  category: "Mock",
  icon: "timer",
  color: "yellow",
  description: "Waits, then passes the value through. Reports progress and stops when the run is cancelled.",
  cache: false,
  inputs: { value: t.var("T"), ms: { type: t.int({ min: 0 }), default: 1000 } },
  outputs: { value: t.var("T") },
  async run({ inputs, ctx }) {
    const total = inputs.ms;
    const step = 100;
    let waited = 0;
    while (waited < total) {
      const chunk = Math.min(step, total - waited);
      await sleep(chunk, ctx.signal);
      waited += chunk;
      ctx.progress(waited / total, `${waited} / ${total} ms`);
    }
    ctx.signal.throwIfAborted();
    return { value: inputs.value };
  },
});

/** `mock.flaky`: fails the first `failures` attempts with retryable `node.unavailable`. */
export const mockFlaky = defineNode({
  type: "mock.flaky",
  canFail: true,
  title: "Flaky",
  category: "Mock",
  icon: "zap",
  color: "yellow",
  description: "Fails the first attempts with a retryable error, then succeeds. For retry tests.",
  cache: false,
  retry: 3,
  inputs: { failures: { type: t.int({ min: 0 }), default: 1 }, value: { type: t.text(), default: "ok" } },
  outputs: { value: t.text() },
  run({ inputs, ctx }) {
    if (ctx.attempt <= inputs.failures) {
      throw new NodeError("node.unavailable", `Mock outage on attempt ${ctx.attempt}: this node fails its first ${inputs.failures} attempts.`, {
        retryable: true,
        details: { attempt: ctx.attempt },
      });
    }
    return { value: inputs.value };
  },
});

/** `mock.fail`: always fails with `mock.failed`. */
export const mockFail = defineNode({
  type: "mock.fail",
  canFail: true,
  title: "Fail",
  category: "Mock",
  icon: "x",
  color: "yellow",
  description: "Always fails with the given message. For failure tests.",
  inputs: { message: { type: t.text(), default: "Mock failure" } },
  outputs: { value: t.text() },
  run({ inputs }): { value: string } {
    throw new NodeError("mock.failed", inputs.message);
  },
});
