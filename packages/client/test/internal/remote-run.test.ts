import type { Run, RunEvent } from "@briarflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, RemoteRun, RunRejectedError, createBriarClient } from "../../src/index.js";
import type { BriarClient } from "../../src/index.js";
import { startFakeServer } from "./fake-server.js";
import type { FakeServer } from "./fake-server.js";

let server: FakeServer;
let client: BriarClient;

beforeEach(async () => {
  server = await startFakeServer();
  client = createBriarClient({ baseUrl: server.baseUrl, reconnect: { initialDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 } });
});

afterEach(async () => {
  await server.close();
});

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await tick(5);
  }
}

describe("RemoteRun", () => {
  it("implements Run: tracks status, replays history, streams live events and resolves result", async () => {
    const run = await client.flows.run("flow_p", { topic: "cats" });
    const asRun: Run = run;
    expect(asRun).toBeInstanceOf(RemoteRun);
    expect(run.id).toBe("run_1");
    expect(run.status).toBe("running");
    expect(run.flowId).toBe("flow_p");

    const all = collect(run.events());
    server.emit(run.id, { type: "node.started", nodeId: "n_in", attempt: 1 });
    server.emit(run.id, { type: "node.progress", nodeId: "n_in", fraction: 0.5 });
    server.emit(run.id, { type: "node.completed", nodeId: "n_in", outputs: {}, cached: false, durationMs: 3 });
    await until(() => server.runs.get(run.id)!.events.length === 4);
    const expected = server.complete(run.id);

    const events = await all;
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [0, "run.started"],
      [1, "node.started"],
      [2, "node.progress"],
      [3, "node.completed"],
      [4, "run.completed"],
    ]);
    expect(await run.result).toEqual(expected);
    expect(run.status).toBe("succeeded");
    expect(run.contextId).toBe("ctx_1");

    // a fresh iterable after completion replays from the shared history; `after` filters
    const tail = await collect(run.events({ after: 2 }));
    expect(tail.map((e) => e.seq)).toEqual([3, 4]);
    await until(() => server.openConnections() === 0);
  });

  it("resolves result without anyone iterating events", async () => {
    const run = await client.flows.run("flow_p");
    await until(() => server.openConnections() === 1);
    const expected = server.complete(run.id, "failed");
    expect(await run.result).toEqual(expected);
    expect(run.status).toBe("failed");
  });

  it("reconnects after a dropped connection and resumes with ?after=<last seq>", async () => {
    server.dropAfterEvents = [2, 1];
    const run = await client.flows.run("flow_p");
    const all = collect(run.events());
    server.emit(run.id, { type: "node.started", nodeId: "n_a", attempt: 1 });
    server.emit(run.id, { type: "node.started", nodeId: "n_b", attempt: 1 });
    server.emit(run.id, { type: "node.started", nodeId: "n_c", attempt: 1 });
    await until(() => server.eventRequests.length >= 3);
    server.complete(run.id);
    const events = await all;
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(server.eventRequests.map((r) => r.after)).toEqual([null, "1", "2", ...server.eventRequests.slice(3).map((r) => r.after)]);
    expect((await run.result).status).toBe("succeeded");
  });

  it("retries 5xx with backoff, then recovers", async () => {
    server.failEventRequests = { status: 503, count: 2 };
    const run = await client.flows.run("flow_p");
    await until(() => server.openConnections() === 1);
    server.complete(run.id);
    expect((await run.result).status).toBe("succeeded");
    expect(server.eventRequests.length).toBe(3);
  });

  it("does not reconnect after run.completed", async () => {
    const run = await client.flows.run("flow_p");
    server.complete(run.id);
    await run.result;
    await collect(run.events());
    await tick(50);
    expect(server.eventRequests).toHaveLength(1);
  });

  it("cancel() posts the reason, the run ends cancelled, and is a no-op once terminal", async () => {
    const run = await client.flows.run("flow_p");
    const all = collect(run.events());
    run.cancel("user pressed stop");
    const events = await all;
    expect(events.at(-1)!.type).toBe("run.completed");
    expect(events.some((e) => e.type === "node.skipped")).toBe(true);
    const result = await run.result;
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("run.cancelled");
    expect(run.status).toBe("cancelled");
    expect(server.cancelRequests).toEqual([{ runId: run.id, body: { reason: "user pressed stop" } }]);
    run.cancel();
    await tick();
    expect(server.cancelRequests).toHaveLength(1);
  });

  it("requestCancel() and runs.cancel() return the server status", async () => {
    server.autoCompleteOnCancel = false;
    const run = await client.flows.run("flow_p");
    expect(await run.requestCancel()).toEqual({ runId: run.id, status: "running" });
    server.complete(run.id, "cancelled");
    await run.result;
    expect(await client.runs.cancel(run.id)).toEqual({ runId: run.id, status: "cancelled" });
  });

  it("wait=true returns a finished run; events are fetched lazily", async () => {
    const run = await client.flows.run("flow_p", {}, { wait: true, waitMs: 1000 });
    expect(run.status).toBe("succeeded");
    expect((await run.result).outputs).toEqual({ prompt: "hi" });
    await tick();
    expect(server.eventRequests).toHaveLength(0);
    const events = await collect(run.events());
    expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);
    expect(server.eventRequests).toHaveLength(1);
  });

  it("runs.open attaches to an existing run", async () => {
    const first = await client.flows.run("flow_p");
    const again = await client.runs.open(first.id);
    expect(again.status).toBe("running");
    expect(again.flowId).toBe("flow_p");
    server.complete(first.id);
    expect((await again.result).status).toBe("succeeded");
    await expect(client.runs.get("run_404")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps run.invalid_inputs to RunRejectedError", async () => {
    const err = await client.flows.run("flow_p", { bad: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunRejectedError);
    expect((err as RunRejectedError).details).toEqual({ diagnostics: [] });
  });

  it("when the server is gone: result resolves as client.run_lost, iterators throw", async () => {
    const run = await client.flows.run("flow_p");
    await until(() => server.openConnections() === 1);
    const iter = collect(run.events());
    await server.close();
    const result = await run.result;
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("client.run_lost");
    expect(result.contextRevision).toBe(-1);
    expect(result.flowId).toBe("flow_p");
    expect(run.status).toBe("failed");
    await expect(iter).rejects.toMatchObject({ code: "client.network" });
  });

  it("a 4xx on the event stream is not retried; the result comes from GET /runs/:id", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = createBriarClient({
      baseUrl: server.baseUrl,
      fetch: async (url, init) => {
        if (url.includes("/events")) await gate;
        return fetch(url, init);
      },
    });
    const run = await gated.flows.run("flow_p");
    const expected = server.complete(run.id);
    server.failEventRequests = { status: 404, count: 1 };
    release();
    expect(await run.result).toEqual(expected);
    const events = await collect(run.events());
    expect(events.map((e) => e.type)).toEqual(["run.completed"]);
    expect(server.eventRequests).toHaveLength(1);
  });
});
