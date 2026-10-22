import { createSequentialIdGenerator, type RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { createBriar, type Briar } from "briarflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnauthorizedError, briarError, createBriarApp, errorStatus } from "../../src/index.js";
import { BriarError } from "@briarflow/core";

const BASE = "http://test/api/v1";

const PORTRAIT_COMMANDS = [
  { op: "type.defineEnum", scope: { kind: "global" }, id: "ty_style", name: "ArtStyle", members: ["anime", "pixel"] },
  {
    op: "type.defineStruct",
    scope: { kind: "global" },
    id: "ty_char",
    name: "Character",
    fields: [
      { name: "name", type: "text" },
      { name: "style", type: "ArtStyle" },
    ],
  },
  { op: "flow.create", id: "flow_p", name: "Portrait", inputNodeId: "n_in", outputNodeId: "n_out" },
  { op: "flow.input.add", flowId: "flow_p", name: "character", type: "Character" },
  { op: "flow.output.add", flowId: "flow_p", name: "description", type: "text" },
  { op: "flow.output.add", flowId: "flow_p", name: "image", type: "image" },
  { op: "node.add", flowId: "flow_p", id: "n_brk", type: "briar.struct.break", position: { x: 200, y: 0 }, config: { typeId: "ty_char" } },
  { op: "node.add", flowId: "flow_p", id: "n_tpl", type: "text.template", position: { x: 420, y: 0 }, config: { template: "Portrait of {name} in {style} style" } },
  { op: "node.add", flowId: "flow_p", id: "n_llm", type: "mock.llm", position: { x: 640, y: 0 } },
  { op: "node.add", flowId: "flow_p", id: "n_img", type: "mock.image", position: { x: 860, y: 0 } },
  { op: "edge.connect", flowId: "flow_p", id: "e_1", from: { node: "n_in", port: "character" }, to: { node: "n_brk", port: "value" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_2", from: { node: "n_brk", port: "name" }, to: { node: "n_tpl", port: "name" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_3", from: { node: "n_brk", port: "style" }, to: { node: "n_tpl", port: "style" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_4", from: { node: "n_tpl", port: "text" }, to: { node: "n_llm", port: "prompt" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_5", from: { node: "n_llm", port: "text" }, to: { node: "n_img", port: "prompt" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_6", from: { node: "n_llm", port: "text" }, to: { node: "n_out", port: "description" } },
  { op: "edge.connect", flowId: "flow_p", id: "e_7", from: { node: "n_img", port: "image" }, to: { node: "n_out", port: "image" } },
];

const CHARACTER = { name: "Ada", style: "pixel" };

let briar: Briar;

beforeEach(() => {
  briar = createBriar({ packs: [mockPack], idGenerator: createSequentialIdGenerator(), clock: () => new Date("2026-10-21T12:00:00.000Z") });
});

afterEach(async () => {
  await briar.close();
});

type App = ReturnType<typeof createBriarApp>;

function json(app: App, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return Promise.resolve(app.request(`${BASE}${path}`, init));
}

async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  return body.error;
}

async function createPortrait(app: App): Promise<void> {
  const created = await json(app, "POST", "/contexts", { name: "Portraits", id: "ctx_portraits" });
  expect(created.status).toBe(201);
  const applied = await json(app, "POST", "/contexts/ctx_portraits/commands", { baseRevision: 0, commands: PORTRAIT_COMMANDS });
  expect(applied.status).toBe(200);
}

async function applyOk(app: App, contextId: string, body: unknown): Promise<void> {
  const res = await json(app, "POST", `/contexts/${contextId}/commands`, body);
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Parses an SSE body into events (ignores comments). */
async function readEvents(res: Response): Promise<{ events: RunEvent[]; ids: string[]; raw: string }> {
  const raw = await res.text();
  const events: RunEvent[] = [];
  const ids: string[] = [];
  for (const frame of raw.split("\n\n")) {
    const data = frame.split("\n").find((l) => l.startsWith("data: "));
    const id = frame.split("\n").find((l) => l.startsWith("id: "));
    if (data) events.push(JSON.parse(data.slice(6)) as RunEvent);
    if (id) ids.push(id.slice(4));
  }
  return { events, ids, raw };
}

describe("contexts", () => {
  it("creates, lists, reads, edits and deletes a context", async () => {
    const app = createBriarApp(briar);
    const created = await json(app, "POST", "/contexts", { name: "Marketing", id: "ctx_m" });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe("/api/v1/contexts/ctx_m");
    expect(((await created.json()) as { revision: number }).revision).toBe(0);

    const dup = await json(app, "POST", "/contexts", { name: "Again", id: "ctx_m" });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe("context.exists");

    const list = await json(app, "GET", "/contexts?limit=1");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);

    const got = await json(app, "GET", "/contexts/ctx_m");
    expect(got.status).toBe(200);
    expect(got.headers.get("etag")).toBe('"0"');

    const applied = await json(app, "POST", "/contexts/ctx_m/commands", { baseRevision: 0, commands: [{ op: "flow.create", name: "Echo", id: "flow_e" }] });
    expect(applied.status).toBe(200);
    const body = (await applied.json()) as Record<string, unknown>;
    expect(body.revision).toBe(1);
    expect(body.changed).toBe(true);
    expect(body).not.toHaveProperty("doc");

    const stale = await json(app, "POST", "/contexts/ctx_m/commands", { baseRevision: 0, commands: [{ op: "flow.create", name: "Other" }] });
    expect(stale.status).toBe(409);
    expect(await errorOf(stale)).toMatchObject({ code: "store.revision_conflict", details: { expected: 0, actual: 1 } });

    const rejected = await json(app, "POST", "/contexts/ctx_m/commands", {
      baseRevision: 1,
      commands: [{ op: "flow.create", name: "Fine" }, { op: "flow.delete", flowId: "flow_missing" }],
    });
    expect(rejected.status).toBe(422);
    expect((await errorOf(rejected)).details).toMatchObject({ commandIndex: 1, op: "flow.delete" });

    const diagnostics = await json(app, "GET", "/contexts/ctx_m/diagnostics");
    expect(diagnostics.status).toBe(200);
    expect(await diagnostics.json()).toMatchObject({ revision: 1 });

    const deleted = await json(app, "DELETE", "/contexts/ctx_m");
    expect(deleted.status).toBe(204);
    expect((await json(app, "GET", "/contexts/ctx_m")).status).toBe(404);
  });

  it("validates ids, bodies and queries", async () => {
    const app = createBriarApp(briar, { maxBodyBytes: 100 });
    const badId = await json(app, "GET", "/contexts/flow_x");
    expect(badId.status).toBe(400);
    expect(await errorOf(badId)).toMatchObject({ code: "request.invalid_id", details: { param: "contextId", value: "flow_x" } });

    const badJson = await json(app, "POST", "/contexts", "{nope");
    expect((await errorOf(badJson)).code).toBe("request.invalid_json");
    const empty = await json(app, "POST", "/contexts", "");
    expect((await errorOf(empty)).code).toBe("request.invalid_json");

    const badName = await json(app, "POST", "/contexts", { name: "  " });
    expect(badName.status).toBe(400);
    expect(await errorOf(badName)).toMatchObject({ code: "request.invalid_body", details: [{ path: "name" }] });

    const tooLarge = await json(app, "POST", "/contexts", { name: "x".repeat(200) });
    expect(tooLarge.status).toBe(413);
    expect((await errorOf(tooLarge)).code).toBe("request.too_large");

    const badLimit = await json(app, "GET", "/contexts?limit=0");
    expect(badLimit.status).toBe(400);
    expect((await errorOf(badLimit)).code).toBe("request.invalid_query");

    await json(app, "POST", "/contexts", { name: "A", id: "ctx_a" });
    const noCommands = await json(app, "POST", "/contexts/ctx_a/commands", { baseRevision: 0, commands: [] });
    expect(await errorOf(noCommands)).toMatchObject({ code: "request.invalid_body", details: [{ path: "commands" }] });
  });

  it("answers unknown routes with route.not_found", async () => {
    const app = createBriarApp(briar);
    const res = await json(app, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "route.not_found", message: "No route for GET /api/v1/nope. See docs/specs/rest-api.md." });
  });
});

describe("runs", () => {
  it("runs the portrait flow with wait, serves its info, events and image", async () => {
    const app = createBriarApp(briar);
    await createPortrait(app);

    const info = await json(app, "GET", "/flows/flow_p");
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ contextId: "ctx_portraits", revision: 1 });

    const res = await json(app, "POST", "/flows/flow_p/runs?wait=true", { inputs: { character: CHARACTER } });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { runId: string; status: string; outputs: { description: string; image: { uri: string; mime: string } } };
    expect(result.status).toBe("succeeded");
    expect(result.outputs.image.mime).toBe("image/svg+xml");

    const run = await json(app, "GET", `/runs/${result.runId}`);
    expect(await run.json()).toMatchObject({ runId: result.runId, flowId: "flow_p", contextId: "ctx_portraits", status: "succeeded" });

    const events = await app.request(`${BASE}/runs/${result.runId}/events`);
    expect(events.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(events.headers.get("cache-control")).toBe("no-cache");
    expect(events.headers.get("x-accel-buffering")).toBe("no");
    const { events: all, ids } = await readEvents(events);
    expect(all[0]?.type).toBe("run.started");
    expect(all.at(-1)?.type).toBe("run.completed");
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i));
    expect(ids).toEqual(all.map((e) => String(e.seq)));

    const resumed = await readEvents(await app.request(`${BASE}/runs/${result.runId}/events?after=2`, { headers: { "Last-Event-ID": "4" } }));
    expect(resumed.events[0]?.seq).toBe(5);
    const nothing = await readEvents(await app.request(`${BASE}/runs/${result.runId}/events?after=${all.length - 1}`));
    expect(nothing.raw).toBe("");

    const mediaId = result.outputs.image.uri.replace("briar-media://", "");
    const image = await app.request(`${BASE}/media/${mediaId}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml");
    expect(image.headers.get("content-security-policy")).toBe("sandbox");
    expect(image.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(image.headers.get("content-disposition")).toBe('inline; filename="mock.svg"');
    expect(await image.text()).toContain("<svg");
    const etag = image.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const notModified = await app.request(`${BASE}/media/${mediaId}`, { headers: { "If-None-Match": etag as string } });
    expect(notModified.status).toBe(304);
  });

  it("answers 202 without wait, streams live events and pings, and cancels", async () => {
    const app = createBriarApp(briar, { pingIntervalMs: 20 });
    await json(app, "POST", "/contexts", { name: "Slow", id: "ctx_slow" });
    await applyOk(app, "ctx_slow", {
      baseRevision: 0,
      commands: [
        { op: "flow.create", id: "flow_slow", name: "Slow", inputNodeId: "n_in", outputNodeId: "n_out" },
        { op: "flow.input.add", flowId: "flow_slow", name: "v", type: "text" },
        { op: "flow.output.add", flowId: "flow_slow", name: "v", type: "text" },
        { op: "node.add", flowId: "flow_slow", id: "n_d", type: "mock.delay", position: { x: 0, y: 0 }, values: { ms: 5000 } },
        { op: "edge.connect", flowId: "flow_slow", from: { node: "n_in", port: "v" }, to: { node: "n_d", port: "value" } },
        { op: "edge.connect", flowId: "flow_slow", from: { node: "n_d", port: "value" }, to: { node: "n_out", port: "v" } },
      ],
    });
    const started = await json(app, "POST", "/flows/flow_slow/runs?wait=true&waitMs=30", { inputs: { v: "x" } });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string; status: string };
    expect(started.headers.get("location")).toBe(`/api/v1/runs/${runId}`);

    const stream = await app.request(`${BASE}/runs/${runId}/events`);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("event: run.started");
    expect(text).toContain(": ping");

    const cancel = await json(app, "POST", `/runs/${runId}/cancel`, { reason: "stop" });
    expect(cancel.status).toBe(202);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("event: run.completed");
    const again = await app.request(`${BASE}/runs/${runId}/cancel`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ runId, status: "cancelled" });
  });

  it("does not cancel the run when the event stream is dropped", async () => {
    const app = createBriarApp(briar);
    await json(app, "POST", "/contexts", { name: "Slow", id: "ctx_slow" });
    await applyOk(app, "ctx_slow", {
      baseRevision: 0,
      commands: [
        { op: "flow.create", id: "flow_slow", name: "Slow", inputNodeId: "n_in", outputNodeId: "n_out" },
        { op: "flow.input.add", flowId: "flow_slow", name: "v", type: "int" },
        { op: "flow.output.add", flowId: "flow_slow", name: "v", type: "int" },
        { op: "node.add", flowId: "flow_slow", id: "n_d", type: "mock.delay", position: { x: 0, y: 0 }, values: { ms: 50 } },
        { op: "edge.connect", flowId: "flow_slow", from: { node: "n_in", port: "v" }, to: { node: "n_d", port: "value" } },
        { op: "edge.connect", flowId: "flow_slow", from: { node: "n_d", port: "value" }, to: { node: "n_out", port: "v" } },
      ],
    });
    const started = (await (await json(app, "POST", "/flows/flow_slow/runs", { inputs: { v: 1 } })).json()) as { runId: string };
    const controller = new AbortController();
    const stream = await app.request(`${BASE}/runs/${started.runId}/events`, { signal: controller.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    controller.abort();
    const run = briar.runs.get(started.runId);
    expect((await run?.result)?.status).toBe("succeeded");
  });

  it("maps invalid inputs to 422 and unknown ids to 404", async () => {
    const app = createBriarApp(briar);
    await createPortrait(app);
    const invalid = await json(app, "POST", "/flows/flow_p/runs", { inputs: { character: { name: 1 } } });
    expect(invalid.status).toBe(422);
    expect((await errorOf(invalid)).code).toBe("run.invalid_inputs");
    expect((await errorOf(await json(app, "GET", "/flows/flow_nope"))).code).toBe("flow.not_found");
    expect((await errorOf(await json(app, "GET", "/runs/run_nope"))).code).toBe("run.not_found");
    const badAfter = await app.request(`${BASE}/runs/run_nope/events?after=x`);
    expect(badAfter.status).toBe(404);
    const badWait = await json(app, "POST", "/flows/flow_p/runs?wait=true&waitMs=0", { inputs: { character: CHARACTER } });
    expect((await errorOf(badWait)).code).toBe("request.invalid_query");
  });
});

describe("node types", () => {
  it("serves the catalog with an ETag and answers 304", async () => {
    const app = createBriarApp(briar);
    const res = await app.request(`${BASE}/node-types`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: { name: string }[]; nodes: { type: string }[] };
    expect(body.packs.map((p) => p.name)).toContain("mock");
    const etag = res.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await app.request(`${BASE}/node-types`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });
});

describe("media", () => {
  it("uploads with mime and filename, enforces limits and content type", async () => {
    const app = createBriarApp(briar, { maxUploadBytes: 8 });
    const up = await app.request(`${BASE}/media?filename=${encodeURIComponent("é \"x\".txt")}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "hello",
    });
    expect(up.status).toBe(201);
    const ref = (await up.json()) as { uri: string; mime: string; bytes: number };
    expect(ref).toMatchObject({ mime: "text/plain", bytes: 5 });
    const id = ref.uri.replace("briar-media://", "");
    expect(up.headers.get("location")).toBe(`/api/v1/media/${id}`);
    const down = await app.request(`${BASE}/media/${id}`);
    expect(await down.text()).toBe("hello");
    expect(down.headers.get("content-length")).toBe("5");
    expect(down.headers.get("content-disposition")).toBe(`inline; filename="_ \\"x\\".txt"; filename*=UTF-8''%C3%A9%20%22x%22.txt`);

    const noType = await app.request(`${BASE}/media`, { method: "POST", body: new Uint8Array([1, 2]) });
    expect(noType.status).toBe(415);
    expect((await errorOf(noType)).code).toBe("media.invalid_mime");

    const big = await app.request(`${BASE}/media`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "123456789" });
    expect(big.status).toBe(413);
    expect(await errorOf(big)).toMatchObject({ code: "media.too_large", details: { maxBytes: 8 } });

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    const bigStream = await app.request(`${BASE}/media`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: streamed,
      duplex: "half",
    } as RequestInit);
    expect(bigStream.status).toBe(413);

    expect((await app.request(`${BASE}/media/m_missing`)).status).toBe(404);
    expect((await app.request(`${BASE}/media/bad%20id`)).status).toBe(400);
  });
});

describe("authorize, CORS and errors", () => {
  it("resolves ids before authorize, then 403 / 401", async () => {
    const seen: unknown[] = [];
    const app = createBriarApp(briar, {
      authorize: ({ action, resource, request }) => {
        seen.push({ action, resource });
        if (request.headers.get("x-user") === "anon") throw new UnauthorizedError();
        return action !== "flows.run";
      },
    });
    await createPortrait(app);
    expect((await json(app, "GET", "/flows/flow_missing")).status).toBe(404);
    const denied = await json(app, "POST", "/flows/flow_p/runs", "not even json");
    expect(denied.status).toBe(403);
    expect(await errorOf(denied)).toMatchObject({ code: "auth.forbidden", message: "You are not allowed to flows.run." });
    expect(seen.at(-1)).toEqual({ action: "flows.run", resource: { flowId: "flow_p", contextId: "ctx_portraits" } });
    const anon = await json(app, "GET", "/contexts", undefined, { "x-user": "anon" });
    expect(anon.status).toBe(401);
    expect((await errorOf(anon)).code).toBe("auth.unauthorized");
  });

  it("hides non-Briar errors behind 500 internal and logs them", async () => {
    const logged: unknown[] = [];
    const logger = { debug() {}, info() {}, warn() {}, error: (m: string, d?: unknown) => logged.push({ m, d }) };
    const app = createBriarApp(briar, {
      logger,
      authorize: () => {
        throw new Error("secret detail");
      },
    });
    const res = await json(app, "GET", "/contexts");
    expect(res.status).toBe(500);
    const error = await errorOf(res);
    expect(error.code).toBe("internal");
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(logged)).toContain("secret detail");
  });

  it("allows the studio dev origin by default and nothing else; cors: false sends nothing", async () => {
    const app = createBriarApp(briar);
    const preflight = (origin: string, a = app) =>
      a.request(`${BASE}/contexts`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    const ok = await preflight("http://localhost:5173");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect((await preflight("http://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    const off = createBriarApp(briar, { cors: false });
    expect((await preflight("http://localhost:5173", off)).headers.get("access-control-allow-origin")).toBeNull();
    const get = await app.request(`${BASE}/contexts`, { headers: { Origin: "http://127.0.0.1:5173" } });
    expect(get.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
  });

  it("mounts at the root with basePath '' and supports custom routes with briarError", async () => {
    const app = createBriarApp(briar, { basePath: "" });
    app.get("/custom/:flowId", async (c) => {
      try {
        return c.json(await briar.flows.info(c.req.param("flowId")));
      } catch (err) {
        return briarError(c, err);
      }
    });
    expect((await app.request("http://test/contexts")).status).toBe(200);
    const custom = await app.request("http://test/custom/flow_x");
    expect(custom.status).toBe(404);
    expect((await errorOf(custom)).code).toBe("flow.not_found");
  });

  it("maps codes to statuses", () => {
    const e = (code: string) => new BriarError(code, "m");
    expect(errorStatus(e("request.invalid_body"))).toBe(400);
    expect(errorStatus(e("request.too_large"))).toBe(413);
    expect(errorStatus(e("store.invalid_cursor"))).toBe(400);
    expect(errorStatus(new UnauthorizedError())).toBe(401);
    expect(errorStatus(e("auth.forbidden"))).toBe(403);
    expect(errorStatus(e("media.not_found"))).toBe(404);
    expect(errorStatus(e("store.flow_id_conflict"))).toBe(409);
    expect(errorStatus(e("media.invalid_mime"))).toBe(415);
    expect(errorStatus(e("run.invalid_flow"))).toBe(422);
    expect(errorStatus(e("briar.closed"))).toBe(503);
    expect(errorStatus(e("store.corrupt"))).toBe(500);
    expect(errorStatus(new Error("x"))).toBe(500);
    const commandLike = new BriarError("edge.type_mismatch", "m");
    commandLike.name = "CommandError";
    expect(errorStatus(commandLike)).toBe(422);
  });
});
