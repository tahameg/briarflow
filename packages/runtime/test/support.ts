/**
 * Shared helpers for the public runtime suites: a controllable probe pack (`probe`), document
 * builders and event helpers. Deterministic: sequential ids, stepping clock, random 0.5.
 */
import {
  createCatalog,
  createSequentialIdGenerator,
  defineNode,
  definePack,
  NodeError,
  t,
  type AnyNodeDefinition,
  type ContextDocument,
  type Edge,
  type FieldDecl,
  type FlowVariable,
  type GlobalVariable,
  type NodeInstance,
  type NodePack,
  type Run,
  type RunEvent,
  type TypeDecl,
} from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { createEngine, type EngineOptions } from "@briarflow/runtime";
import { context, flow, memoryMediaStore, node as fixtureNode, edge as fixtureEdge } from "@briarflow/testing";

// ---------------------------------------------------------------------------------------------
// Gates: nodes wait until the test releases them.
// ---------------------------------------------------------------------------------------------

interface Gate {
  promise: Promise<string>;
  release(value?: string): void;
  fail(error: unknown): void;
}

function makeGate(): Gate {
  let release!: (v: string) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    release = res;
    fail = rej;
  });
  promise.catch(() => {});
  return { promise, release: (v = "released") => release(v), fail };
}

/** Global observation state of the probe pack. Call `reset()` in `beforeEach`. */
export const probe = {
  gates: new Map<string, Gate>(),
  /** Node ids (or keys) in the order their `run` started. */
  started: [] as string[],
  /** Calls per node id. */
  calls: new Map<string, number>(),
  running: 0,
  maxRunning: 0,
  /** Abort reasons seen by gated nodes. */
  abortReasons: [] as unknown[],
  /** Extra info captured from contexts. */
  seen: [] as Record<string, unknown>[],
  reset(): void {
    this.gates.clear();
    this.started = [];
    this.calls.clear();
    this.running = 0;
    this.maxRunning = 0;
    this.abortReasons = [];
    this.seen = [];
  },
  gate(key: string): Gate {
    let g = this.gates.get(key);
    if (!g) {
      g = makeGate();
      this.gates.set(key, g);
    }
    return g;
  },
  release(key: string, value?: string): void {
    this.gate(key).release(value);
  },
};

function enter(nodeId: string): void {
  probe.started.push(nodeId);
  probe.calls.set(nodeId, (probe.calls.get(nodeId) ?? 0) + 1);
  probe.running += 1;
  probe.maxRunning = Math.max(probe.maxRunning, probe.running);
}

function leave(): void {
  probe.running -= 1;
}

async function waitGate(key: string, signal: AbortSignal, honourSignal: boolean): Promise<string> {
  const gate = probe.gate(key);
  if (!honourSignal) return gate.promise;
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      probe.abortReasons.push(signal.reason);
      reject(signal.reason);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    gate.promise.then(resolve, reject);
  });
}

const nodes = [
  /** Pass-through text, cached. */
  defineNode({
    type: "probe.echo",
    inputs: { value: { type: t.text(), default: "x" } },
    outputs: { value: t.text() },
    run: ({ inputs, node }) => {
      enter(node.id);
      leave();
      return { value: inputs.value };
    },
  }),
  /** Waits for gate `key` (default: its node id), then outputs `value` + suffix. Not cached. */
  defineNode({
    type: "probe.wait",
    cache: false,
    inputs: {
      value: { type: t.text(), default: "" },
      key: { type: t.text(), default: "" },
      ignoreSignal: { type: t.boolean(), default: false },
    },
    outputs: { value: t.text() },
    async run({ inputs, node, ctx }) {
      enter(node.id);
      try {
        const v = await waitGate(inputs.key || node.id, ctx.signal, !inputs.ignoreSignal);
        return { value: inputs.value + v };
      } finally {
        leave();
      }
    },
  }),
  /** Like probe.wait but per-type concurrency 1. */
  defineNode({
    type: "probe.single",
    cache: false,
    concurrency: 1,
    inputs: { key: { type: t.text(), default: "" } },
    outputs: { value: t.text() },
    async run({ inputs, node, ctx }) {
      enter(node.id);
      try {
        return { value: await waitGate(inputs.key || node.id, ctx.signal, true) };
      } finally {
        leave();
      }
    },
  }),
  /** Counts its executions; cached; cacheVersion "1". */
  defineNode({
    type: "probe.count",
    inputs: { value: { type: t.text(), default: "x" }, n: { type: t.int(), default: 0 } },
    outputs: { value: t.text() },
    run: ({ inputs, node }) => {
      enter(node.id);
      leave();
      return { value: `${inputs.value}#${probe.calls.get(node.id)}` };
    },
  }),
  /** Throws according to `kind`. */
  defineNode({
    type: "probe.throw",
    cache: false,
    retry: 2,
    inputs: { kind: { type: t.text(), default: "plain" }, x: { type: t.optional(t.text()), default: null } },
    outputs: { value: t.text() },
    run({ inputs, node }): { value: string } {
      enter(node.id);
      leave();
      switch (inputs.kind) {
        case "nodeError":
          throw new NodeError("probe.bad", "Probe says no", { details: { why: "test" } });
        case "retryable":
          throw new NodeError("probe.flaky", "Probe flaked", { retryable: true });
        case "string":
          throw "a string"; // eslint-disable-line no-throw-literal
        case "typeError":
          throw new TypeError("not from fetch");
        default:
          throw new Error("plain failure");
      }
    },
  }),
  /** Fails the first `failures` attempts with a retryable error (optional retryAfterMs). */
  defineNode({
    type: "probe.retry",
    cache: false,
    retry: { maxAttempts: 4, initialDelayMs: 100, factor: 2, maxDelayMs: 250, jitter: false },
    inputs: { failures: { type: t.int(), default: 1 }, retryAfterMs: { type: t.int(), default: -1 } },
    outputs: { attempt: t.int() },
    run({ inputs, ctx, node }) {
      enter(node.id);
      leave();
      if (ctx.attempt <= inputs.failures) {
        throw new NodeError("node.rate_limited", `slow down ${ctx.attempt}`, {
          retryable: true,
          ...(inputs.retryAfterMs >= 0 ? { details: { retryAfterMs: inputs.retryAfterMs } } : {}),
        });
      }
      return { attempt: ctx.attempt };
    },
  }),
  /** Default backoff with jitter: retry 3 (500 ms × 2^k × jitter). */
  defineNode({
    type: "probe.jitter",
    cache: false,
    retry: 3,
    inputs: { failures: { type: t.int(), default: 3 } },
    outputs: { attempt: t.int() },
    run({ inputs, ctx }) {
      if (ctx.attempt <= inputs.failures) throw new NodeError("node.unavailable", `down ${ctx.attempt}`);
      return { attempt: ctx.attempt };
    },
  }),
  /** Times out (50 ms) on attempts <= `slowAttempts`; retry 1. */
  defineNode({
    type: "probe.slow",
    cache: false,
    timeoutMs: 50,
    retry: { maxAttempts: 2, initialDelayMs: 10, jitter: false },
    inputs: { slowAttempts: { type: t.int(), default: 1 }, ignoreSignal: { type: t.boolean(), default: true } },
    outputs: { attempt: t.int() },
    async run({ inputs, ctx, node }) {
      enter(node.id);
      try {
        if (ctx.attempt <= inputs.slowAttempts) {
          await waitGate(`${node.id}#${ctx.attempt}`, ctx.signal, !inputs.ignoreSignal);
        }
        return { attempt: ctx.attempt };
      } finally {
        leave();
      }
    },
  }),
  /** Returns bad outputs by mode. */
  defineNode({
    type: "probe.badOut",
    cache: false,
    retry: 2,
    inputs: { mode: t.text() },
    outputs: { value: t.int({ min: 0 }), maybe: t.optional(t.text()) },
    run({ inputs, node }) {
      enter(node.id);
      leave();
      switch (inputs.mode) {
        case "missing":
          return {} as { value: number };
        case "wrongType":
          return { value: "seven" as unknown as number };
        case "constraint":
          return { value: -1 };
        case "extra":
          return { value: 1, bogus: true } as unknown as { value: number };
        case "notObject":
          return 42 as unknown as { value: number };
        default:
          return { value: 1 };
      }
    },
  }),
  /** Needs secret API_KEY; optionally asks for an undeclared one. */
  defineNode({
    type: "probe.secret",
    cache: false,
    secrets: ["API_KEY"],
    inputs: { askOther: { type: t.boolean(), default: false } },
    outputs: { value: t.text() },
    async run({ inputs, ctx }) {
      if (inputs.askOther) await ctx.secrets.get("OTHER");
      return { value: `key:${await ctx.secrets.get("API_KEY")}` };
    },
  }),
  /** Reads ctx.globals / ctx.variables by name (empty = skip); cached. */
  defineNode({
    type: "probe.state",
    inputs: { global: { type: t.text(), default: "" }, variable: { type: t.text(), default: "" } },
    outputs: { value: t.text() },
    run({ inputs, ctx, node }) {
      enter(node.id);
      leave();
      const parts: unknown[] = [];
      if (inputs.global) parts.push(ctx.globals.get(inputs.global));
      if (inputs.variable) parts.push(ctx.variables.get(inputs.variable));
      return { value: JSON.stringify(parts) };
    },
  }),
  /** Records its ExecContext; logs; optionally calls ctx.fetch. */
  defineNode({
    type: "probe.ctx",
    cache: false,
    inputs: { url: { type: t.text(), default: "" } },
    outputs: { value: t.text() },
    async run({ inputs, ctx, node, config }) {
      probe.seen.push({
        runId: ctx.runId,
        flowId: ctx.flowId,
        nodeId: ctx.nodeId,
        attempt: ctx.attempt,
        node,
        config,
        signal: ctx.signal,
        resolveType: ctx.resolveType("ty_char"),
        media: ctx.media,
      });
      ctx.log.info("hello from probe", { extra: 1 });
      if (inputs.url) {
        const res = await ctx.fetch(inputs.url);
        return { value: await res.text() };
      }
      return { value: "ok" };
    },
  }),
  /** Reports progress `count` times synchronously (fractions from `values`), then waits for its gate. */
  defineNode({
    type: "probe.progress",
    cache: false,
    inputs: { values: { type: t.list(t.float()), default: [] }, message: { type: t.text(), default: "" }, wait: { type: t.boolean(), default: true }, nanFirst: { type: t.boolean(), default: false } },
    outputs: { value: t.text() },
    async run({ inputs, ctx, node }) {
      if (inputs.nanFirst) ctx.progress(Number.NaN, "nan");
      for (const f of inputs.values) ctx.progress(f, inputs.message || undefined);
      if (inputs.wait) await waitGate(node.id, ctx.signal, true);
      return { value: "done" };
    },
  }),
  /** Emits progress later, when its gate is released (to test "none after terminal"). */
  defineNode({
    type: "probe.lateProgress",
    cache: false,
    timeoutMs: 20,
    outputs: { value: t.text() },
    run({ ctx, node }) {
      void probe.gate(node.id).promise.then(() => ctx.progress(0.9, "late"));
      return new Promise<{ value: string }>(() => {}); // never settles; timeout ends it
    },
  }),
  /** Generic pass-through (unbound generics are unchecked). */
  defineNode({
    type: "probe.any",
    inputs: { value: t.var("T") },
    outputs: { value: t.var("T") },
    run: ({ inputs }) => ({ value: inputs.value }),
  }),
] as unknown as AnyNodeDefinition[];

export const probePack: NodePack = definePack({ name: "probe", version: "0.0.1", nodes });

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export const FLOW_ID = "flow_t";

/** `n("id", "probe.echo", { values: { value: "a" } })`. */
export function n(id: string, type: string, extra: Omit<NodeInstance, "id" | "type" | "position"> = {}): NodeInstance {
  return fixtureNode(id, type, { x: 0, y: 0 }, extra);
}

let edgeSeq = 0;
/** `e("a.value", "b.value")`. */
export function e(from: string, to: string): Edge {
  edgeSeq += 1;
  return fixtureEdge(`e_${edgeSeq}`, from, to);
}

export interface DocSpec {
  inputs?: FieldDecl[];
  outputs?: FieldDecl[];
  variables?: FlowVariable[];
  nodes?: NodeInstance[];
  edges?: Edge[];
  types?: TypeDecl[];
  globals?: GlobalVariable[];
  localTypes?: TypeDecl[];
  flowName?: string;
}

/** A context `ctx_test` (revision 1) with one flow `flow_t` (input `n_in`, output `n_out`). */
export function doc(spec: DocSpec = {}): ContextDocument {
  return context({
    types: spec.types ?? [],
    globals: spec.globals ?? [],
    flows: [
      flow({
        id: FLOW_ID,
        name: spec.flowName ?? "Test flow",
        types: spec.localTypes ?? [],
        inputs: spec.inputs ?? [],
        outputs: spec.outputs ?? [],
        variables: spec.variables ?? [],
        nodes: spec.nodes ?? [],
        edges: spec.edges ?? [],
      }),
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

export const START = Date.parse("2026-10-21T10:00:00.000Z");

/** Clock advancing 1 ms per call. */
export function stepClock(start = START): () => Date {
  let now = start;
  return () => new Date(now++);
}

export interface TestEngineOptions extends Partial<EngineOptions> {
  packs?: NodePack[];
}

export function makeEngine(options: TestEngineOptions = {}) {
  const { packs, ...rest } = options;
  const media = memoryMediaStore();
  const engine = createEngine({
    catalog: createCatalog(packs ?? [stdPack, mockPack, probePack]),
    media,
    secrets: { get: async () => undefined },
    clock: stepClock(),
    idGenerator: createSequentialIdGenerator(),
    random: () => 0.5,
    ...rest,
  });
  return { engine, media };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export async function collect(run: Run, after?: number): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const ev of run.events(after === undefined ? undefined : { after })) out.push(ev);
  return out;
}

/** Waits until an event matching `match` has been emitted (replays history first). */
export async function waitFor(run: Run, match: (e: RunEvent) => boolean): Promise<RunEvent> {
  for await (const ev of run.events()) if (match(ev)) return ev;
  throw new Error("run completed without a matching event");
}

/** Waits for `node.started` of a node (attempt optional). */
export function started(run: Run, nodeId: string, attempt?: number): Promise<RunEvent> {
  return waitFor(run, (ev) => ev.type === "node.started" && ev.nodeId === nodeId && (attempt === undefined || ev.attempt === attempt));
}

/** Compact `type:nodeId` (or `type`) list. */
export function trace(events: readonly RunEvent[]): string[] {
  return events.map((ev) => ("nodeId" in ev ? `${ev.type}:${ev.nodeId}` : ev.type));
}

/** Events of one node. */
export function ofNode(events: readonly RunEvent[], nodeId: string): RunEvent[] {
  return events.filter((ev) => "nodeId" in ev && ev.nodeId === nodeId);
}

/** Lets pending microtasks and already-due macrotasks run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Text field helper. */
export const text = { kind: "primitive", name: "text" } as const;
export const int = { kind: "primitive", name: "int" } as const;
