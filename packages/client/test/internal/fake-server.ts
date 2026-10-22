/**
 * Tiny in-process HTTP server speaking the REST + SSE format of docs/specs/rest-api.md for the
 * run endpoints. Tests drive runs by hand (`emit`, `complete`) and can drop SSE connections.
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RunEvent, RunResult, RunStatus, TerminalRunStatus } from "@briarflow/core";

type EventInput = { type: Exclude<RunEvent["type"], "run.completed"> } & Record<string, unknown>;

interface FakeRun {
  id: string;
  flowId: string;
  contextId: string;
  status: RunStatus;
  events: RunEvent[];
  result?: RunResult;
  listeners: Set<() => void>;
}

export interface EventsRequest {
  runId: string;
  after: string | null;
  lastEventId: string | null;
}

export interface FakeServer {
  baseUrl: string;
  runs: Map<string, FakeRun>;
  eventRequests: EventsRequest[];
  cancelRequests: { runId: string; body: unknown }[];
  /** Number of SSE connections to cut after writing this many events (per connection). */
  dropAfterEvents: number[];
  /** Respond to the next N event requests with this status. */
  failEventRequests: { status: number; count: number };
  /** When true, cancel completes the run with status "cancelled". */
  autoCompleteOnCancel: boolean;
  createRun(flowId?: string, status?: RunStatus): FakeRun;
  emit(runId: string, event: EventInput): void;
  complete(runId: string, status?: TerminalRunStatus): RunResult;
  evict(runId: string): void;
  openConnections(): number;
  close(): Promise<void>;
}

const AT = "2026-10-21T10:00:00.000Z";

export async function startFakeServer(): Promise<FakeServer> {
  let nextRun = 1;
  let connections = 0;
  const sockets = new Set<import("node:net").Socket>();
  const state: FakeServer = {
    baseUrl: "",
    runs: new Map(),
    eventRequests: [],
    cancelRequests: [],
    dropAfterEvents: [],
    failEventRequests: { status: 0, count: 0 },
    autoCompleteOnCancel: true,
    createRun(flowId = "flow_p", status = "running") {
      const run: FakeRun = { id: `run_${nextRun++}`, flowId, contextId: "ctx_1", status, events: [], listeners: new Set() };
      state.runs.set(run.id, run);
      if (status === "running") state.emit(run.id, { type: "run.started", flowId, contextId: "ctx_1" });
      return run;
    },
    emit(runId, input) {
      const run = state.runs.get(runId)!;
      const ev = { ...input, runId, seq: run.events.length, at: AT } as unknown as RunEvent;
      run.events.push(ev);
      if (run.status === "queued") run.status = "running";
      for (const l of run.listeners) l();
    },
    complete(runId, status = "succeeded") {
      const run = state.runs.get(runId)!;
      const result: RunResult = {
        runId,
        flowId: run.flowId,
        contextId: run.contextId,
        contextRevision: 13,
        status,
        startedAt: AT,
        finishedAt: AT,
        ...(status === "succeeded" ? { outputs: { prompt: "hi" } } : { error: { code: status === "cancelled" ? "run.cancelled" : "run.node_failed", message: "x" } }),
      };
      run.result = result;
      run.status = status;
      const ev: RunEvent = { type: "run.completed", runId, seq: run.events.length, at: AT, result };
      run.events.push(ev);
      for (const l of run.listeners) l();
      return result;
    },
    evict(runId) {
      state.runs.delete(runId);
    },
    openConnections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  };
  const notFound = (res: ServerResponse, code: string, what: string) => send(res, 404, { error: { code, message: `${what} not found.` } });
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    return text ? JSON.parse(text) : undefined;
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse, run: FakeRun, url: URL) => {
    const header = req.headers["last-event-id"];
    const lastEventId = typeof header === "string" ? header : null;
    const afterQ = url.searchParams.get("after");
    state.eventRequests.push({ runId: run.id, after: afterQ, lastEventId });
    const after = Number(lastEventId ?? afterQ ?? -1);
    const dropAfter = state.dropAfterEvents.shift();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    res.write(": ping\n\n");
    connections++;
    let sent = 0;
    let cursor = after + 1;
    const done = () => {
      run.listeners.delete(flush);
      connections--;
    };
    const flush = () => {
      while (cursor < run.events.length) {
        const ev = run.events[cursor++]!;
        const frame = `id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
        // split frames to exercise the parser across chunks
        const mid = Math.floor(frame.length / 2);
        res.write(frame.slice(0, mid));
        res.write(frame.slice(mid));
        sent++;
        if (ev.type === "run.completed") {
          done();
          res.end();
          return;
        }
        if (dropAfter !== undefined && sent >= dropAfter) {
          done();
          // abrupt drop (no chunked terminator) once the frames are flushed
          res.write("", () => res.socket?.destroy());
          return;
        }
      }
    };
    run.listeners.add(flush);
    req.on("close", () => {
      if (run.listeners.has(flush)) done();
    });
    flush();
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.replace(/^\/api\/v1\//, "").split("/");
      const method = req.method ?? "GET";
      if (parts[0] === "flows" && parts[2] === "runs" && method === "POST") {
        const body = (await readBody(req)) as { inputs?: Record<string, unknown> };
        if (body.inputs?.["bad"]) {
          send(res, 422, { error: { code: "run.invalid_inputs", message: "Input \"bad\" is not declared.", details: { diagnostics: [] } } });
          return;
        }
        const run = state.createRun(parts[1]!);
        if (url.searchParams.get("wait") === "true") {
          send(res, 200, state.complete(run.id));
          return;
        }
        res.setHeader("location", `/api/v1/runs/${run.id}`);
        send(res, 202, { runId: run.id, status: run.status });
        return;
      }
      if (parts[0] === "runs") {
        const run = state.runs.get(parts[1] ?? "");
        if (!run) return notFound(res, "run.not_found", `Run "${parts[1]}"`);
        if (parts[2] === "events" && method === "GET") {
          if (state.failEventRequests.count > 0) {
            state.failEventRequests.count--;
            state.eventRequests.push({ runId: run.id, after: url.searchParams.get("after"), lastEventId: null });
            send(res, state.failEventRequests.status, { error: { code: "internal", message: "boom" } });
            return;
          }
          return handleEvents(req, res, run, url);
        }
        if (parts[2] === "cancel" && method === "POST") {
          state.cancelRequests.push({ runId: run.id, body: await readBody(req) });
          if (run.result) return send(res, 200, { runId: run.id, status: run.status });
          send(res, 202, { runId: run.id, status: run.status });
          if (state.autoCompleteOnCancel) {
            setTimeout(() => {
              state.emit(run.id, { type: "node.skipped", nodeId: "n_out", reason: "cancelled" });
              state.complete(run.id, "cancelled");
            }, 5);
          }
          return;
        }
        if (parts.length === 2 && method === "GET") {
          return send(res, 200, { runId: run.id, flowId: run.flowId, contextId: run.contextId, status: run.status, ...(run.result ? { result: run.result } : {}) });
        }
      }
      send(res, 404, { error: { code: "route.not_found", message: "No route." } });
    })();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}/api/v1`;
  return state;
}
