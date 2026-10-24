/**
 * Test-only node pack `tk` for runtime internal tests.
 */
import { defineNode, definePack, NodeError, t, type AnyNodeDefinition } from "@briarflow/core";

export const probe = {
  running: 0,
  maxRunning: 0,
  startOrder: [] as string[],
  reasons: [] as unknown[],
  runCalls: 0,
  reset() {
    this.running = 0;
    this.maxRunning = 0;
    this.startOrder = [];
    this.reasons = [];
    this.runCalls = 0;
  },
};

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

const nodes = [
  defineNode({
    type: "tk.text",
    inputs: { value: { type: t.text(), default: "a" } },
    outputs: { value: t.text() },
    run: ({ inputs }) => {
      probe.runCalls += 1;
      return { value: inputs.value };
    },
  }),
  defineNode({
    type: "tk.num",
    inputs: { n: { type: t.int(), default: 1 } },
    outputs: { value: t.int() },
    run: ({ inputs }) => ({ value: inputs.n }),
  }),
  defineNode({
    type: "tk.positive",
    inputs: { value: t.int({ min: 0 }) },
    outputs: { value: t.int() },
    run: ({ inputs }) => ({ value: inputs.value }),
  }),
  defineNode({
    type: "tk.fail",
    inputs: { x: { type: t.optional(t.text()), default: null } },
    outputs: { value: t.text() },
    run(): { value: string } {
      throw new NodeError("tk.boom", "boom", { details: { why: "test" } });
    },
  }),
  defineNode({
    type: "tk.throwPlain",
    retry: 3,
    outputs: { value: t.text() },
    run(): { value: string } {
      throw new Error("plain failure");
    },
  }),
  defineNode({
    type: "tk.flaky",
    cache: false,
    retry: { maxAttempts: 3, initialDelayMs: 10, jitter: false },
    inputs: { failures: { type: t.int(), default: 2 } },
    outputs: { attempt: t.int() },
    run: ({ inputs, ctx }) => {
      if (ctx.attempt <= inputs.failures) throw new NodeError("node.unavailable", `down ${ctx.attempt}`);
      return { attempt: ctx.attempt };
    },
  }),
  defineNode({
    type: "tk.rateLimited",
    cache: false,
    retry: { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 20, jitter: false },
    outputs: { value: t.text() },
    run: ({ ctx }) => {
      if (ctx.attempt === 1) throw new NodeError("node.rate_limited", "slow down", { details: { retryAfterMs: 1000 } });
      return { value: "ok" };
    },
  }),
  defineNode({
    type: "tk.hang",
    cache: false,
    timeoutMs: 30,
    retry: { maxAttempts: 2, initialDelayMs: 5, jitter: false },
    outputs: { value: t.text() },
    run: async ({ ctx }) => {
      await abortable(10_000, ctx.signal).catch((err: unknown) => {
        probe.reasons.push(ctx.signal.reason);
        throw err;
      });
      return { value: "never" };
    },
  }),
  defineNode({
    type: "tk.ignore",
    cache: false,
    inputs: { ms: { type: t.int(), default: 200 } },
    outputs: { value: t.text() },
    run: async ({ inputs }) => {
      await new Promise((r) => setTimeout(r, inputs.ms));
      return { value: "late" };
    },
  }),
  defineNode({
    type: "tk.wait",
    cache: false,
    inputs: { ms: { type: t.int(), default: 30 }, value: { type: t.optional(t.text()), default: null } },
    outputs: { value: t.optional(t.text()) },
    run: async ({ inputs, ctx }) => {
      probe.startOrder.push(ctx.nodeId);
      probe.running += 1;
      probe.maxRunning = Math.max(probe.maxRunning, probe.running);
      try {
        await abortable(inputs.ms, ctx.signal);
      } finally {
        probe.running -= 1;
      }
      return { value: inputs.value };
    },
  }),
  defineNode({
    type: "tk.limited",
    cache: false,
    concurrency: 1,
    inputs: { ms: { type: t.int(), default: 20 } },
    outputs: { done: t.boolean() },
    run: async ({ inputs, ctx }) => {
      probe.running += 1;
      probe.maxRunning = Math.max(probe.maxRunning, probe.running);
      try {
        await abortable(inputs.ms, ctx.signal);
      } finally {
        probe.running -= 1;
      }
      return { done: true };
    },
  }),
  defineNode({
    type: "tk.badOut",
    cache: false,
    retry: 2,
    inputs: { mode: t.text() },
    outputs: { value: t.int({ min: 0 }), note: t.optional(t.text()) },
    run: ({ inputs }) => {
      probe.runCalls += 1;
      if (inputs.mode === "missing") return {} as { value: number };
      if (inputs.mode === "extra") return { value: 1, other: 2 } as { value: number };
      if (inputs.mode === "constraint") return { value: -1 };
      if (inputs.mode === "notObject") return 5 as unknown as { value: number };
      return { value: 1 };
    },
  }),
  defineNode({
    type: "tk.secret",
    secrets: ["API_KEY"],
    outputs: { value: t.text() },
    run: async ({ ctx }) => ({ value: await ctx.secrets.get("API_KEY") }),
  }),
  defineNode({
    type: "tk.undeclaredSecret",
    outputs: { value: t.text() },
    run: async ({ ctx }) => ({ value: await ctx.secrets.get("OTHER") }),
  }),
  defineNode({
    type: "tk.fetcher",
    cache: false,
    retry: { maxAttempts: 2, initialDelayMs: 1, jitter: false },
    outputs: { status: t.int() },
    run: async ({ ctx }) => {
      const res = await ctx.fetch("https://example.test/x");
      return { status: res.status };
    },
  }),
  defineNode({
    type: "tk.readState",
    inputs: { global: t.text(), variable: t.text() },
    outputs: { value: t.text() },
    run: ({ inputs, ctx }) => {
      probe.runCalls += 1;
      return { value: `${String(ctx.globals.get(inputs.global))}|${JSON.stringify(ctx.variables.get(inputs.variable))}` };
    },
  }),
  defineNode({
    type: "tk.progress",
    cache: false,
    outputs: { value: t.text() },
    run: async ({ ctx }) => {
      for (let i = 1; i <= 10; i++) ctx.progress(i / 10, `step ${i}`);
      await new Promise((r) => setTimeout(r, 250));
      ctx.progress(Number.NaN);
      ctx.progress(7, "x".repeat(300));
      return { value: "done" };
    },
  }),
  defineNode({
    type: "tk.media",
    inputs: { image: t.image() },
    outputs: { uri: t.text() },
    run: ({ inputs }) => {
      probe.runCalls += 1;
      return { uri: inputs.image.mediaId };
    },
  }),
  defineNode({
    type: "tk.addOne",
    inputs: { value: t.int() },
    outputs: { value: t.int() },
    run: ({ inputs }) => ({ value: inputs.value + 1 }),
  }),
  defineNode({
    type: "tk.log",
    outputs: { value: t.text() },
    run: ({ ctx }) => {
      ctx.log.info("hello", { a: 1 });
      return { value: ctx.runId };
    },
  }),
];

export const tkPack = definePack({ name: "tk", version: "1.0.0", nodes: nodes as unknown as AnyNodeDefinition[] });
