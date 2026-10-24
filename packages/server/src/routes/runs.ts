/**
 * Flow and run routes (rest-api.md §3 "Flows", "Runs", §4 SSE).
 */
import { BriarError, type RunResult, type RunStatus } from "@briarflow/core";
import type { BriarRun } from "briarflow";
import type { Env } from "hono";
import { isObject, readJson } from "../body.js";
import { invalidBody, invalidQuery } from "../errors.js";
import { checkPathId, type RouteKit } from "../kit.js";
import { eventStream } from "../sse.js";

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 300_000;
const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);

function flowNotFound(flowId: string): BriarError {
  return new BriarError("flow.not_found", `Flow "${flowId}" does not exist in any context. Check the flow id.`, { details: { flowId } });
}

function runNotFound(runId: string): BriarError {
  return new BriarError(
    "run.not_found",
    `Run "${runId}" does not exist. Finished runs are kept only for a while; start a new run if it was evicted.`,
    { details: { runId } },
  );
}

/** Parses an SSE resume point (`Last-Event-ID` or `?after`): an integer ≥ -1. */
function parseAfter(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^-?\d+$/.test(value) || Number(value) < -1 || !Number.isSafeInteger(Number(value))) {
    throw invalidQuery(name, raw, "must be a whole number >= -1 (the last event seq you saw)");
  }
  return Number(value);
}

export function registerRunRoutes<E extends Env>(kit: RouteKit<E>): void {
  const { app, briar, base } = kit;

  const getRun = (runId: string): BriarRun => {
    const run = briar.runs.get(runId);
    if (!run) throw runNotFound(runId);
    return run;
  };

  const locate = async (flowId: string): Promise<string> => {
    const contextId = await briar.flows.locate(flowId);
    if (contextId === undefined) throw flowNotFound(flowId);
    return contextId;
  };

  app.get(
    `${base}/flows/:flowId`,
    kit.handle(async (c) => {
      const flowId = checkPathId("flow", "flowId", c.req.param("flowId"));
      const contextId = await locate(flowId);
      await kit.authorize(c, "flows.read", { flowId, contextId });
      return c.json(await briar.flows.info(flowId));
    }),
  );

  app.post(
    `${base}/flows/:flowId/runs`,
    kit.handle(async (c) => {
      const flowId = checkPathId("flow", "flowId", c.req.param("flowId"));
      const contextId = await locate(flowId);
      await kit.authorize(c, "flows.run", { flowId, contextId });

      const waitRaw = c.req.query("wait");
      const wait = waitRaw === "true" || waitRaw === "1";
      let waitMs = DEFAULT_WAIT_MS;
      const waitMsRaw = c.req.query("waitMs");
      if (waitMsRaw !== undefined) {
        if (!/^\d+$/.test(waitMsRaw) || Number(waitMsRaw) < 1 || Number(waitMsRaw) > MAX_WAIT_MS) {
          throw invalidQuery("waitMs", waitMsRaw, `must be a whole number of milliseconds between 1 and ${MAX_WAIT_MS}`);
        }
        waitMs = Number(waitMsRaw);
      }

      const body = await readJson(c.req.raw, kit.maxBodyBytes);
      if (!isObject(body)) throw invalidBody([{ path: "", problem: 'must be a JSON object like { "inputs": { … } }' }]);
      const problems: { path: string; problem: string }[] = [];
      if (body.inputs !== undefined && !isObject(body.inputs)) problems.push({ path: "inputs", problem: "must be an object of flow input values" });
      if (body.useCache !== undefined && typeof body.useCache !== "boolean") problems.push({ path: "useCache", problem: "must be true or false" });
      if (body.force !== undefined && typeof body.force !== "boolean") problems.push({ path: "force", problem: "must be true or false" });
      if (problems.length > 0) throw invalidBody(problems);

      const run = await briar.run(flowId, (body.inputs as Record<string, unknown> | undefined) ?? {}, {
        throwOnInvalid: true,
        ...(typeof body.useCache === "boolean" ? { useCache: body.useCache } : {}),
        ...(body.force === true ? { force: true } : {}),
      });

      if (wait) {
        const result = await waitForResult(run, waitMs, c.req.raw.signal);
        if (result) return c.json(result, 200);
      }
      c.header("Location", `${base}/runs/${run.id}`);
      return c.json({ runId: run.id, status: run.status }, 202);
    }),
  );

  app.get(
    `${base}/flows/:flowId/last-run`,
    kit.handle(async (c) => {
      const flowId = checkPathId("flow", "flowId", c.req.param("flowId"));
      const contextId = await locate(flowId);
      await kit.authorize(c, "runs.read", { flowId, contextId });
      return c.json({ lastRun: (await briar.runs.last(flowId)) ?? null });
    }),
  );

  app.get(
    `${base}/runs/:runId`,
    kit.handle(async (c) => {
      const runId = checkPathId("run", "runId", c.req.param("runId"));
      const run = getRun(runId);
      await kit.authorize(c, "runs.read", { runId, flowId: run.flowId, contextId: run.contextId });
      return c.json(run.info());
    }),
  );

  app.get(
    `${base}/runs/:runId/events`,
    kit.handle(async (c) => {
      const runId = checkPathId("run", "runId", c.req.param("runId"));
      const run = getRun(runId);
      await kit.authorize(c, "runs.read", { runId, flowId: run.flowId, contextId: run.contextId });
      const fromHeader = parseAfter("Last-Event-ID", c.req.header("last-event-id"));
      const fromQuery = parseAfter("after", c.req.query("after"));
      const after = fromHeader ?? fromQuery;
      const body = eventStream(run.events(after === undefined ? {} : { after }), {
        pingIntervalMs: kit.pingIntervalMs,
        signal: c.req.raw.signal,
        logger: kit.logger,
        runId,
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }),
  );

  app.post(
    `${base}/runs/:runId/cancel`,
    kit.handle(async (c) => {
      const runId = checkPathId("run", "runId", c.req.param("runId"));
      const run = getRun(runId);
      await kit.authorize(c, "runs.cancel", { runId, flowId: run.flowId, contextId: run.contextId });
      const body = await readJson(c.req.raw, kit.maxBodyBytes, { optional: true });
      if (!isObject(body)) throw invalidBody([{ path: "", problem: 'must be a JSON object like { "reason": "…" }' }]);
      if (body.reason !== undefined && typeof body.reason !== "string") throw invalidBody([{ path: "reason", problem: "must be a string" }]);
      if (TERMINAL.has(run.status)) return c.json({ runId, status: run.status }, 200);
      run.cancel(typeof body.reason === "string" ? body.reason : undefined);
      return c.json({ runId, status: run.status }, 202);
    }),
  );
}

/**
 * Waits for the run's result up to `waitMs` or until the request is aborted. `undefined` when
 * not finished in time. Never cancels the run.
 */
async function waitForResult(run: BriarRun, waitMs: number, signal: AbortSignal): Promise<RunResult | undefined> {
  if (signal.aborted) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([run.result, giveUp]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
