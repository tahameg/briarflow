/**
 * runtime.md §7, phase-3.md §4.6: ordering guarantees, seq, at, replay, progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, ofNode, probe, started, waitFor } from "./support.js";

beforeEach(() => probe.reset());
afterEach(() => vi.useRealTimers());

/** Checks guarantees 1–6 of runtime.md §7 on a complete event list. */
function checkOrdering(events: readonly RunEvent[], deps: Record<string, string[]> = {}): void {
  // 1. seq gap-free from 0
  events.forEach((ev, i) => expect(ev.seq).toBe(i));
  // 2. run.started first (unless cancelled while queued), run.completed last, once
  expect(events.at(-1)?.type).toBe("run.completed");
  expect(events.filter((ev) => ev.type === "run.completed")).toHaveLength(1);
  if (events.length > 1) expect(events[0]?.type).toBe("run.started");
  // 5. at non-decreasing ISO
  for (let i = 1; i < events.length; i++) expect(events[i]!.at >= events[i - 1]!.at).toBe(true);
  // 3 + 6. per node structure
  const nodeIds = new Set(events.filter((ev) => "nodeId" in ev).map((ev) => (ev as { nodeId: string }).nodeId));
  for (const id of nodeIds) {
    const own = ofNode(events, id);
    if (own[0]?.type === "node.skipped") {
      expect(own, `node ${id}`).toHaveLength(1);
      continue;
    }
    expect(own[0]).toMatchObject({ type: "node.started", attempt: 1 });
    const terminal = own.filter((ev) => ev.type === "node.completed" || ev.type === "node.failed");
    expect(terminal, `terminal events of ${id}`).toHaveLength(1);
    expect(own.at(-1)).toBe(terminal[0]);
    let attempt = 1;
    for (let i = 1; i < own.length - 1; i++) {
      const ev = own[i]!;
      if (ev.type === "node.retrying") {
        expect(ev.attempt).toBe(attempt);
        expect(ev.nextAttempt).toBe(attempt + 1);
        expect(own[i + 1]).toMatchObject({ type: "node.started", attempt: attempt + 1 });
        attempt += 1;
        i += 1;
      } else {
        expect(ev.type).toBe("node.progress");
      }
    }
  }
  // 4. a node starts after all its dependencies completed
  for (const [nodeId, ds] of Object.entries(deps)) {
    const start = events.find((ev) => ev.type === "node.started" && ev.nodeId === nodeId);
    if (!start) continue;
    for (const d of ds) {
      const done = events.find((ev) => ev.type === "node.completed" && ev.nodeId === d);
      expect(done, `${d} completed before ${nodeId} started`).toBeDefined();
      expect(done!.seq).toBeLessThan(start.seq);
    }
  }
}

const diamond = () =>
  doc({
    inputs: [{ name: "t", type: ir.text() }],
    outputs: [{ name: "out", type: ir.text() }],
    nodes: [
      n("n_a", "probe.echo"),
      n("n_b", "probe.echo"),
      n("n_c", "probe.echo"),
      n("n_join", "text.template", { config: { template: "{{b}}+{{c}}" } }),
    ],
    edges: [
      e("n_in.t", "n_a.value"),
      e("n_a.value", "n_b.value"),
      e("n_a.value", "n_c.value"),
      e("n_b.value", "n_join.b"),
      e("n_c.value", "n_join.c"),
      e("n_join.text", "n_out.out"),
    ],
  });

describe("event ordering", () => {
  it("a successful run satisfies every ordering guarantee", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } });
    const events = await collect(run);
    checkOrdering(events, { n_a: ["n_in"], n_b: ["n_a"], n_c: ["n_a"], n_join: ["n_b", "n_c"], n_out: ["n_join"] });
    expect((await run.result).outputs).toEqual({ out: "x+x" });
    expect(events[0]).toMatchObject({ type: "run.started", flowId: FLOW_ID, contextId: "ctx_test", runId: "run_1", seq: 0 });
    // Every node runs, including built-ins.
    for (const id of ["n_in", "n_a", "n_b", "n_c", "n_join", "n_out"]) {
      expect(ofNode(events, id).map((ev) => ev.type)).toEqual(["node.started", "node.completed"]);
    }
  });

  it("node.completed carries outputs, cached flag and durationMs >= 0", async () => {
    const { engine } = makeEngine();
    const events = await collect(engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } }));
    const a = events.find((ev) => ev.type === "node.completed" && ev.nodeId === "n_a") as Extract<RunEvent, { type: "node.completed" }>;
    expect(a.outputs).toEqual({ value: "x" });
    expect(a.cached).toBe(false);
    expect(Number.isFinite(a.durationMs) && a.durationMs >= 0).toBe(true);
    const input = events.find((ev) => ev.type === "node.completed" && ev.nodeId === "n_in") as Extract<RunEvent, { type: "node.completed" }>;
    expect(input.outputs).toEqual({ t: "x" });
    const output = events.find((ev) => ev.type === "node.completed" && ev.nodeId === "n_out") as Extract<RunEvent, { type: "node.completed" }>;
    expect(output.outputs).toEqual({ out: "x+x" });
  });

  it("at comes from the injected clock and is non-decreasing even if the clock goes back", async () => {
    let calls = 0;
    const times = ["2026-10-21T10:00:05.000Z", "2026-10-21T10:00:01.000Z"];
    const { engine } = makeEngine({ clock: () => new Date(times[calls++ % 2]!) });
    const events = await collect(engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } }));
    for (const ev of events) expect(ev.at).toBe("2026-10-21T10:00:05.000Z");
  });

  it("failed and skipped runs also satisfy the guarantees", async () => {
    const { engine } = makeEngine();
    const d = doc({
      outputs: [{ name: "out", type: ir.text() }],
      nodes: [n("n_f", "probe.throw", { values: { kind: "nodeError" } }), n("n_after", "probe.echo")],
      edges: [e("n_f.value", "n_after.value"), e("n_after.value", "n_out.out")],
    });
    checkOrdering(await collect(engine.run({ context: d, flowId: FLOW_ID })));
  });
});

describe("events() replay", () => {
  it("after the run: full history, then ends; after: n skips seq <= n", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } });
    await run.result;
    const all = await collect(run);
    expect(all.length).toBeGreaterThan(5);
    expect(await collect(run, 3)).toEqual(all.slice(4));
    expect(await collect(run, -1)).toEqual(all);
    expect(await collect(run, all.length - 1)).toEqual([]);
    expect(await collect(run, 1000)).toEqual([]);
  });

  it("replays then follows live events; independent consumers see the same stream", async () => {
    const { engine } = makeEngine();
    const d = doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_w", "probe.wait")], edges: [e("n_w.value", "n_out.out")] });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    const early = collect(run);
    await started(run, "n_w");
    const mid = collect(run);
    const resumed = collect(run, 1);
    probe.release("n_w");
    const [a, b, c] = await Promise.all([early, mid, resumed]);
    expect(b).toEqual(a);
    expect(c).toEqual(a.slice(2));
    expect(a.at(-1)?.type).toBe("run.completed");
  });

  it("breaking out of for-await releases the consumer without affecting the run", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } });
    let seen = 0;
    for await (const ev of run.events()) {
      seen += 1;
      if (ev.type === "run.started") break;
    }
    expect(seen).toBe(1);
    expect((await run.result).status).toBe("succeeded");
    expect((await collect(run)).at(-1)?.type).toBe("run.completed");
  });

  it("a slow consumer does not block the run", async () => {
    const { engine } = makeEngine();
    const run = engine.run({ context: diamond(), flowId: FLOW_ID, inputs: { t: "x" } });
    const iterator = run.events()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("run.started");
    const result = await run.result; // not waiting for the consumer
    expect(result.status).toBe("succeeded");
    const rest: RunEvent[] = [];
    for (let r = await iterator.next(); !r.done; r = await iterator.next()) rest.push(r.value);
    expect(rest.at(-1)?.type).toBe("run.completed");
  });
});

describe("progress events", () => {
  const progressDoc = (values: number[], message = "", nanFirst = false) =>
    doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_p", "probe.progress", { values: { values, message, nanFirst } })], edges: [e("n_p.value", "n_out.out")] });

  it("clamps to [0,1], ignores NaN; first report is immediate; message truncated to 200 chars", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const long = "m".repeat(250);
    const run = engine.run({ context: progressDoc([7], long, true), flowId: FLOW_ID });
    await vi.advanceTimersByTimeAsync(0);
    const now = fractions(await snapshot(run));
    expect(now).toEqual([1]);
    const ev = (await snapshot(run)).find((x) => x.type === "node.progress") as Extract<RunEvent, { type: "node.progress" }>;
    expect(ev.message).toBe("m".repeat(200));
    await vi.advanceTimersByTimeAsync(300);
    probe.release("n_p");
    await vi.advanceTimersByTimeAsync(0);
    await run.result;
    const events = await collect(run);
    expect(events.filter((x) => x.type === "node.progress")).toHaveLength(1);
  });

  it("negative fractions clamp to 0", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = engine.run({ context: progressDoc([-3]), flowId: FLOW_ID });
    await vi.advanceTimersByTimeAsync(0);
    const ev = (await snapshot(run)).find((x) => x.type === "node.progress") as Extract<RunEvent, { type: "node.progress" }>;
    expect(ev.fraction).toBe(0);
    expect(ev.message).toBeUndefined();
    probe.release("n_p");
    await vi.advanceTimersByTimeAsync(0);
    await run.result;
  });

  it("throttles to one event per 100 ms window per node; the latest report in a window wins", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = engine.run({ context: progressDoc([0.1, 0.2, 0.3, 0.4]), flowId: FLOW_ID });
    await vi.advanceTimersByTimeAsync(0);
    let events = await snapshot(run);
    expect(fractions(events)).toEqual([0.1]);
    await vi.advanceTimersByTimeAsync(100);
    events = await snapshot(run);
    expect(fractions(events)).toEqual([0.1, 0.4]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fractions(await snapshot(run))).toEqual([0.1, 0.4]);
    probe.release("n_p");
    await vi.advanceTimersByTimeAsync(0);
    await run.result;
  });

  it("a pending report is dropped at the node's terminal event; nothing follows it", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = engine.run({ context: progressDoc([0.1, 0.5]), flowId: FLOW_ID });
    await vi.advanceTimersByTimeAsync(0);
    probe.release("n_p");
    await vi.advanceTimersByTimeAsync(0);
    await run.result;
    await vi.advanceTimersByTimeAsync(1000);
    const events = await collect(run);
    expect(fractions(events)).toEqual([0.1]);
    const p = ofNode(events, "n_p").map((x) => x.type);
    expect(p).toEqual(["node.started", "node.progress", "node.completed"]);
  });

  it("progress reported after a node timed out is not emitted", async () => {
    const { engine } = makeEngine();
    const d = doc({ nodes: [n("n_l", "probe.lateProgress")] });
    const run = engine.run({ context: d, flowId: FLOW_ID });
    await waitFor(run, (x) => x.type === "node.failed" && x.nodeId === "n_l");
    probe.release("n_l");
    await run.result;
    await new Promise((r) => setTimeout(r, 5));
    expect((await collect(run)).filter((x) => x.type === "node.progress")).toEqual([]);
  });
});

async function snapshot(run: { events(o?: { after?: number }): AsyncIterable<RunEvent> }): Promise<RunEvent[]> {
  // Read what is in the history now without waiting for live events.
  const out: RunEvent[] = [];
  const it = run.events()[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([it.next(), Promise.resolve("pending" as const).then((x) => x)]);
    if (next === "pending") break;
    if (next.done) break;
    out.push(next.value);
  }
  await it.return?.();
  return out;
}

function fractions(events: readonly RunEvent[]): number[] {
  return events.filter((x): x is Extract<RunEvent, { type: "node.progress" }> => x.type === "node.progress").map((x) => x.fraction);
}


