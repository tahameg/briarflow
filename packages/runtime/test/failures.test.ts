/**
 * runtime.md §4–§5, phase-3.md §4.3–§4.4: failure + skip, cancellation + grace, node and run
 * timeouts, retries and backoff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent, SerializedError } from "@briarflow/core";
import { ir } from "@briarflow/testing";
import { collect, doc, e, FLOW_ID, makeEngine, n, ofNode, probe, started, trace, waitFor } from "./support.js";

beforeEach(() => probe.reset());
afterEach(() => vi.useRealTimers());

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

function failed(events: RunEvent[], nodeId: string): SerializedError | undefined {
  return (events.find((x) => x.type === "node.failed" && x.nodeId === nodeId) as Ev<"node.failed"> | undefined)?.error;
}

function retrying(events: RunEvent[], nodeId: string): Ev<"node.retrying">[] {
  return events.filter((x): x is Ev<"node.retrying"> => x.type === "node.retrying" && x.nodeId === nodeId);
}

const run1 = (engine: ReturnType<typeof makeEngine>["engine"], d: ReturnType<typeof doc>, extra: object = {}) =>
  engine.run({ context: d, flowId: FLOW_ID, useCache: false, ...extra });

describe("failure and skip", () => {
  const failDoc = () =>
    doc({
      nodes: [
        n("n_f", "probe.throw", { values: { kind: "nodeError" } }),
        n("n_d1", "probe.echo"),
        n("n_d2", "probe.echo"),
        n("n_d0", "probe.echo"),
        n("n_w", "probe.wait"),
      ],
      edges: [e("n_f.value", "n_d1.value"), e("n_d1.value", "n_d2.value"), e("n_f.value", "n_d0.value")],
    });

  it("skips every transitive dependent immediately, in (depth, id) order; independent branches finish", async () => {
    const { engine } = makeEngine();
    const run = run1(engine, failDoc());
    await waitFor(run, (x) => x.type === "node.skipped" && x.nodeId === "n_d2");
    expect(run.status).toBe("running"); // n_w is still waiting
    probe.release("n_w", "fine");
    const result = await run.result;
    const events = await collect(run);
    const fail = events.find((x) => x.type === "node.failed")!;
    const skips = events.filter((x): x is Ev<"node.skipped"> => x.type === "node.skipped");
    expect(skips.map((x) => [x.nodeId, x.reason, x.cause])).toEqual([
      ["n_d0", "upstream_failed", "n_f"],
      ["n_d1", "upstream_failed", "n_f"],
      ["n_d2", "upstream_failed", "n_f"],
    ]);
    expect(skips.map((x) => x.seq)).toEqual([fail.seq + 1, fail.seq + 2, fail.seq + 3]);
    expect(ofNode(events, "n_w").at(-1)?.type).toBe("node.completed");
    expect(probe.started).not.toContain("n_d1");
    expect(result.status).toBe("failed");
    expect(result.outputs).toBeUndefined();
    expect(result.variables).toBeUndefined();
    expect(result.globalWrites).toBeUndefined();
    expect(result.error).toEqual({
      code: "run.node_failed",
      message: "Node Throw failed: Probe says no",
      nodeId: "n_f",
      cause: { code: "probe.bad", message: "Probe says no", details: { why: "test" }, nodeId: "n_f", retryable: false },
    });
  });

  it("uses the node's title when set", async () => {
    const { engine } = makeEngine();
    const d = doc({ nodes: [n("n_f", "probe.throw", { title: "Make it fail", values: { kind: "nodeError" } })] });
    expect((await run1(engine, d).result).error?.message).toBe("Node Make it fail failed: Probe says no");
  });

  it("the run error names the first failed node (lowest seq)", async () => {
    const { engine } = makeEngine();
    const d = doc({
      nodes: [n("n_a", "probe.throw", { values: { kind: "nodeError" } }), n("n_b", "mock.fail", { values: { message: "second" } })],
    });
    const run = run1(engine, d);
    const result = await run.result;
    const events = await collect(run);
    const fails = events.filter((x): x is Ev<"node.failed"> => x.type === "node.failed");
    expect(fails).toHaveLength(2);
    expect(result.error?.nodeId).toBe(fails[0]!.nodeId);
    expect(result.error?.cause).toEqual(fails[0]!.error);
  });

  it("non-NodeError exceptions become node.failed with the original message and are not retried", async () => {
    for (const [kind, message] of [
      ["plain", "plain failure"],
      ["typeError", "not from fetch"],
      ["string", "a string"],
    ] as const) {
      probe.reset();
      const { engine } = makeEngine();
      const run = run1(engine, doc({ nodes: [n("n_t", "probe.throw", { values: { kind } })] }));
      await run.result;
      const events = await collect(run);
      expect(failed(events, "n_t")).toMatchObject({ code: "node.failed", message, nodeId: "n_t", retryable: false });
      expect(probe.calls.get("n_t")).toBe(1);
      expect(retrying(events, "n_t")).toEqual([]);
    }
  });

  it("a failure in a downstream output makes nodes feeding nothing else still run", async () => {
    const { engine } = makeEngine();
    const d = doc({
      outputs: [{ name: "out", type: ir.text() }],
      nodes: [n("n_f", "mock.fail"), n("n_ok", "probe.echo", { values: { value: "ran" } })],
      edges: [e("n_f.value", "n_out.out")],
    });
    const run = run1(engine, d);
    const result = await run.result;
    const events = await collect(run);
    expect(ofNode(events, "n_out").map((x) => x.type)).toEqual(["node.skipped"]);
    expect(ofNode(events, "n_ok").at(-1)?.type).toBe("node.completed");
    expect(result.error).toMatchObject({ code: "run.node_failed", nodeId: "n_f", message: "Node Fail failed: Mock failure" });
  });
});

describe("retries", () => {
  it("retryable NodeError: retried up to maxAttempts with node.retrying before each wait", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_r", "probe.retry", { values: { failures: 3 } })] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.calls.get("n_r")).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(probe.calls.get("n_r")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.calls.get("n_r")).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(probe.calls.get("n_r")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe.calls.get("n_r")).toBe(3);
    await vi.advanceTimersByTimeAsync(250); // capped at maxDelayMs
    expect(probe.calls.get("n_r")).toBe(4);
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    const events = await collect(run);
    const r = retrying(events, "n_r");
    expect(r.map((x) => [x.attempt, x.nextAttempt, x.delayMs])).toEqual([
      [1, 2, 100],
      [2, 3, 200],
      [3, 4, 250],
    ]);
    expect(r[0]!.error).toMatchObject({ code: "node.rate_limited", message: "slow down 1", retryable: true, nodeId: "n_r" });
    expect(ofNode(events, "n_r").map((x) => (x.type === "node.started" ? `started:${x.attempt}` : x.type))).toEqual([
      "started:1",
      "node.retrying",
      "started:2",
      "node.retrying",
      "started:3",
      "node.retrying",
      "started:4",
      "node.completed",
    ]);
    const done = ofNode(events, "n_r").at(-1) as Ev<"node.completed">;
    expect(done.outputs).toEqual({ attempt: 4 });
  });

  it("gives up after maxAttempts and fails with the last error", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_r", "probe.retry", { values: { failures: 10 } })] }));
    await vi.advanceTimersByTimeAsync(5000);
    const result = await run.result;
    const events = await collect(run);
    expect(probe.calls.get("n_r")).toBe(4);
    expect(retrying(events, "n_r")).toHaveLength(3);
    expect(failed(events, "n_r")).toMatchObject({ code: "node.rate_limited", message: "slow down 4" });
    expect(result.error?.code).toBe("run.node_failed");
  });

  it("details.retryAfterMs raises the delay, capped at maxDelayMs × 3", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const a = run1(engine, doc({ nodes: [n("n_r", "probe.retry", { values: { failures: 1, retryAfterMs: 400 } })] }));
    const b = run1(engine, doc({ nodes: [n("n_s", "probe.retry", { values: { failures: 1, retryAfterMs: 5000 } })] }));
    const c = run1(engine, doc({ nodes: [n("n_t", "probe.retry", { values: { failures: 1, retryAfterMs: 10 } })] }));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a.result, b.result, c.result]);
    expect(retrying(await collect(a), "n_r")[0]?.delayMs).toBe(400);
    expect(retrying(await collect(b), "n_s")[0]?.delayMs).toBe(750);
    expect(retrying(await collect(c), "n_t")[0]?.delayMs).toBe(100);
  });

  it("default policy with jitter: 500 × 2^(k-1) × (0.5 + random/2), rounded", async () => {
    vi.useFakeTimers();
    for (const [random, expected] of [
      [0.5, [375, 750, 1500]],
      [0, [250, 500, 1000]],
      [0.333, [333, 667, 1333]],
    ] as const) {
      const { engine } = makeEngine({ random: () => random });
      const run = run1(engine, doc({ nodes: [n("n_j", "probe.jitter")] }));
      await vi.advanceTimersByTimeAsync(10_000);
      await run.result;
      const delays = retrying(await collect(run), "n_j").map((x) => x.delayMs);
      expect(delays).toEqual(expected);
    }
  });

  it("mock.flaky (retry: 3) succeeds after its failures", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const d = doc({ outputs: [{ name: "out", type: ir.text() }], nodes: [n("n_f", "mock.flaky", { values: { failures: 2 } })], edges: [e("n_f.value", "n_out.out")] });
    const run = run1(engine, d);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run.result;
    expect(result.outputs).toEqual({ out: "ok" });
    expect(retrying(await collect(run), "n_f").map((x) => x.error.code)).toEqual(["node.unavailable", "node.unavailable"]);
  });

  it("the concurrency slot is released during the retry wait", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ concurrency: 1 });
    const run = run1(engine, doc({ nodes: [n("n_r", "probe.retry", { values: { failures: 1 } }), n("n_w", "probe.wait")] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.started).toEqual(["n_r", "n_w"]); // n_w got the slot while n_r waits
    await vi.advanceTimersByTimeAsync(500);
    expect(probe.calls.get("n_r")).toBe(1); // attempt 2 needs the slot n_w holds
    probe.release("n_w");
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.calls.get("n_r")).toBe(2);
    expect((await run.result).status).toBe("succeeded");
  });

  it("never retries node.invalid_input / node.invalid_output / node.missing_secret even with retry > 0", async () => {
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_b", "probe.badOut", { values: { mode: "constraint" } }), n("n_s", "probe.secret")] }));
    await run.result;
    const events = await collect(run);
    expect(events.some((x) => x.type === "node.retrying")).toBe(false);
    expect(failed(events, "n_b")?.code).toBe("node.invalid_output");
    expect(failed(events, "n_s")?.code).toBe("node.missing_secret");
  });
});

describe("node timeout", () => {
  it("an attempt that exceeds timeoutMs fails with node.timeout at once and is retried", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_s", "probe.slow")] }));
    await vi.advanceTimersByTimeAsync(49);
    expect(retrying(await collectNow(run), "n_s")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const r = retrying(await collectNow(run), "n_s");
    expect(r).toHaveLength(1);
    expect(r[0]!.error).toMatchObject({ code: "node.timeout", retryable: true, nodeId: "n_s" });
    await vi.advanceTimersByTimeAsync(10);
    const result = await run.result;
    expect(result.status).toBe("succeeded");
    const done = ofNode(await collect(run), "n_s").at(-1) as Ev<"node.completed">;
    expect(done.outputs).toEqual({ attempt: 2 });
  });

  it("the attempt signal aborts with NodeError node.timeout and the spec message", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_s", "probe.slow", { values: { slowAttempts: 2, ignoreSignal: false } })] }));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run.result;
    expect(probe.abortReasons).toHaveLength(2);
    expect(probe.abortReasons[0]).toMatchObject({ code: "node.timeout", message: "Node Slow did not finish within 50 ms." });
    const events = await collect(run);
    expect(failed(events, "n_s")?.code).toBe("node.timeout");
    expect(result.error?.cause?.code).toBe("node.timeout");
  });

  it("a late result of a timed-out attempt is discarded", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_s", "probe.slow", { values: { slowAttempts: 2 } })] }));
    await vi.advanceTimersByTimeAsync(55);
    probe.release("n_s#1"); // attempt 1 settles late
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run.result;
    expect(result.status).toBe("failed");
    const events = await collect(run);
    expect(ofNode(events, "n_s").filter((x) => x.type === "node.completed")).toEqual([]);
    expect(failed(events, "n_s")?.code).toBe("node.timeout");
  });
});

describe("cancellation", () => {
  const cancelDoc = (ignoreSignal = false) =>
    doc({
      nodes: [n("n_w", "probe.wait", { values: { ignoreSignal } }), n("n_after", "probe.echo"), n("n_late", "probe.echo")],
      edges: [e("n_w.value", "n_after.value"), e("n_after.value", "n_late.value")],
    });

  it("cancel(reason): running nodes end node.cancelled, not-started ones are skipped; result cancelled", async () => {
    const { engine } = makeEngine();
    const run = run1(engine, cancelDoc());
    await started(run, "n_w");
    run.cancel("User pressed stop");
    const result = await run.result;
    expect(run.status).toBe("cancelled");
    expect(result.status).toBe("cancelled");
    expect(result.error).toEqual({ code: "run.cancelled", message: "User pressed stop" });
    expect(result.outputs).toBeUndefined();
    const events = await collect(run);
    expect(failed(events, "n_w")).toMatchObject({ code: "node.cancelled", nodeId: "n_w" });
    const skips = events.filter((x): x is Ev<"node.skipped"> => x.type === "node.skipped");
    expect(skips.map((x) => [x.nodeId, x.reason])).toEqual([
      ["n_after", "cancelled"],
      ["n_late", "cancelled"],
    ]);
    expect(probe.abortReasons).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("default message; cancel twice keeps the first reason", async () => {
    const { engine } = makeEngine();
    const run = run1(engine, cancelDoc());
    await started(run, "n_w");
    run.cancel();
    run.cancel("second");
    expect((await run.result).error).toEqual({ code: "run.cancelled", message: "The run was cancelled." });
  });

  it("aborting options.signal cancels the run", async () => {
    const { engine } = makeEngine();
    const controller = new AbortController();
    const run = run1(engine, cancelDoc(), { signal: controller.signal });
    await started(run, "n_w");
    controller.abort();
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("run.cancelled");
  });

  it("a node that ignores the signal is ended after cancelGraceMs; its late result is discarded", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ cancelGraceMs: 1000 });
    const run = run1(engine, cancelDoc(true));
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    await vi.advanceTimersByTimeAsync(999);
    expect(run.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    probe.release("n_w", "too late");
    await vi.advanceTimersByTimeAsync(0);
    const events = await collect(run);
    expect(failed(events, "n_w")?.code).toBe("node.cancelled");
    expect(ofNode(events, "n_w").filter((x) => x.type === "node.completed")).toEqual([]);
  });

  it("a node that returns a value after cancel still ends node.cancelled", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ cancelGraceMs: 1000 });
    const run = run1(engine, cancelDoc(true));
    await vi.advanceTimersByTimeAsync(0);
    run.cancel();
    probe.release("n_w", "value");
    await vi.advanceTimersByTimeAsync(0);
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    expect(failed(await collect(run), "n_w")?.code).toBe("node.cancelled");
  });

  it("cancel during a retry wait ends the node with node.cancelled at once (not skipped)", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_r", "probe.retry", { values: { failures: 5 } })] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(retrying(await collectNow(run), "n_r")).toHaveLength(1);
    run.cancel();
    await vi.advanceTimersByTimeAsync(0);
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    const events = await collect(run);
    expect(ofNode(events, "n_r").map((x) => x.type)).toEqual(["node.started", "node.retrying", "node.failed"]);
    expect(failed(events, "n_r")?.code).toBe("node.cancelled");
    expect(probe.calls.get("n_r")).toBe(1);
  });

  it("cancel while queued: only run.completed, startedAt === finishedAt", async () => {
    const { engine } = makeEngine({ maxConcurrentRuns: 1 });
    const first = run1(engine, cancelDoc());
    const queued = run1(engine, cancelDoc());
    await started(first, "n_w");
    expect(queued.status).toBe("queued");
    queued.cancel("not needed");
    const result = await queued.result;
    expect(queued.status).toBe("cancelled");
    expect(result.error).toEqual({ code: "run.cancelled", message: "not needed" });
    expect(result.startedAt).toBe(result.finishedAt);
    const events = await collect(queued);
    expect(trace(events)).toEqual(["run.completed"]);
    expect(events[0]!.seq).toBe(0);
    probe.release("n_w");
    expect((await first.result).status).toBe("succeeded");
  });

  it("an already-aborted signal cancels before the run starts", async () => {
    const { engine } = makeEngine();
    const controller = new AbortController();
    controller.abort();
    const run = run1(engine, cancelDoc(), { signal: controller.signal });
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    expect(trace(await collect(run))).toEqual(["run.completed"]);
  });
});

describe("run timeout", () => {
  it("ends failed with run.timeout and the spec message; nodes are cancelled", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine();
    const run = run1(engine, doc({ nodes: [n("n_w", "probe.wait"), n("n_after", "probe.echo")], edges: [e("n_w.value", "n_after.value")] }), { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(run.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1);
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({ code: "run.timeout", message: "The run took longer than 100 ms and was stopped." });
    const events = await collect(run);
    expect(failed(events, "n_w")?.code).toBe("node.cancelled");
    expect(events.find((x) => x.type === "node.skipped")).toMatchObject({ nodeId: "n_after", reason: "cancelled" });
  });

  it("the timer starts when the run leaves queued", async () => {
    vi.useFakeTimers();
    const { engine } = makeEngine({ maxConcurrentRuns: 1 });
    const first = run1(engine, doc({ nodes: [n("n_w", "probe.wait")] }));
    const second = run1(engine, doc({ nodes: [n("n_e", "probe.echo")] }), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(500);
    expect(second.status).toBe("queued");
    probe.release("n_w");
    await vi.advanceTimersByTimeAsync(0);
    await first.result;
    expect((await second.result).status).toBe("succeeded");
  });
});

/** Events emitted so far (does not wait for the run to finish). */
async function collectNow(run: { events(): AsyncIterable<RunEvent> }): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  const it = run.events()[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([it.next(), Promise.resolve("pending" as const).then((x) => x)]);
    if (next === "pending" || next.done) break;
    out.push(next.value);
  }
  await it.return?.();
  return out;
}
