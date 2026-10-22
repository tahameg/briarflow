/**
 * The real `@briarflow/client` against a real server on an ephemeral port (phase-5.md §6.2):
 * contexts, commands, a run with SSE events (incl. resume after a cut stream), cancel,
 * node types, media and the authorize hook.
 */
import {
  AuthError,
  CommandError,
  ConflictError,
  NotFoundError,
  RevisionConflictError,
  RunRejectedError,
  createBriarClient,
  type BriarClient,
} from "@briarflow/client";
import type { Command } from "@briarflow/authoring";
import { createSequentialIdGenerator, type RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { createBriar, type Briar } from "briarflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnauthorizedError, briarError, createBriarApp, serve, type BriarServer } from "../../src/index.js";

const PORTRAIT: Command[] = [
  { op: "type.defineStruct", scope: { kind: "global" }, id: "ty_char", name: "Character", fields: [{ name: "name", type: "text" }] },
  { op: "flow.create", id: "flow_p", name: "Portrait", inputNodeId: "n_in", outputNodeId: "n_out" },
  { op: "flow.input.add", flowId: "flow_p", name: "character", type: "Character" },
  { op: "flow.output.add", flowId: "flow_p", name: "description", type: "text" },
  { op: "flow.output.add", flowId: "flow_p", name: "image", type: "image" },
  { op: "node.add", flowId: "flow_p", id: "n_brk", type: "briar.struct.break", config: { typeId: "ty_char" }, position: { x: 200, y: 0 } },
  { op: "node.add", flowId: "flow_p", id: "n_llm", type: "mock.llm", position: { x: 400, y: 0 } },
  { op: "node.add", flowId: "flow_p", id: "n_img", type: "mock.image", position: { x: 600, y: 0 } },
  { op: "edge.connect", flowId: "flow_p", from: { node: "n_in", port: "character" }, to: { node: "n_brk", port: "value" } },
  { op: "edge.connect", flowId: "flow_p", from: { node: "n_brk", port: "name" }, to: { node: "n_llm", port: "prompt" } },
  { op: "edge.connect", flowId: "flow_p", from: { node: "n_llm", port: "text" }, to: { node: "n_img", port: "prompt" } },
  { op: "edge.connect", flowId: "flow_p", from: { node: "n_llm", port: "text" }, to: { node: "n_out", port: "description" } },
  { op: "edge.connect", flowId: "flow_p", from: { node: "n_img", port: "image" }, to: { node: "n_out", port: "image" } },
  { op: "flow.exec.set", flowId: "flow_p", edges: null },
  { op: "flow.exec.enable", flowId: "flow_p" },
  { op: "flow.create", id: "flow_d", name: "Slow", inputNodeId: "n_din", outputNodeId: "n_dout" },
  { op: "flow.output.add", flowId: "flow_d", name: "value", type: "text" },
  { op: "flow.input.add", flowId: "flow_d", name: "value", type: "text" },
  { op: "node.add", flowId: "flow_d", id: "n_delay", type: "mock.delay", values: { ms: 150 }, position: { x: 200, y: 0 } },
  { op: "edge.connect", flowId: "flow_d", from: { node: "n_din", port: "value" }, to: { node: "n_delay", port: "value" } },
  { op: "edge.connect", flowId: "flow_d", from: { node: "n_delay", port: "value" }, to: { node: "n_dout", port: "value" } },
  { op: "flow.exec.set", flowId: "flow_d", edges: null },
  { op: "flow.exec.enable", flowId: "flow_d" },
];

let briar: Briar;
let server: BriarServer;
let client: BriarClient;
let cutFirstStream = false;

/** A fetch that cuts the first event stream after two events (to exercise resume). */
const cuttingFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const res = await fetch(input, init);
  if (!cutFirstStream || !input.includes("/events") || !res.body) return res;
  cutFirstStream = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g) ?? []).length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  const frames = text.split("\n\n").slice(0, 2).join("\n\n") + "\n\n";
  return new Response(frames, { status: res.status, headers: res.headers });
};

beforeAll(async () => {
  briar = createBriar({ packs: [mockPack], idGenerator: createSequentialIdGenerator(), clock: () => new Date("2026-10-21T12:00:00.000Z") });
  const app = createBriarApp(briar, {
    pingIntervalMs: 50,
    authorize: ({ action, request }) => {
      if (request.headers.get("x-user") === "anon") throw new UnauthorizedError();
      return !(action === "flows.run" && request.headers.get("x-user") === "viewer");
    },
  });
  app.get("/api/v1/portrait/:name", async (c) => {
    try {
      const run = await briar.run("flow_p", { character: { name: c.req.param("name") } });
      return c.json((await run.result).outputs);
    } catch (err) {
      return briarError(c, err);
    }
  });
  server = await serve(app, { port: 0 });
  client = createBriarClient({ baseUrl: `${server.url}/api/v1`, fetch: cuttingFetch, reconnect: { initialDelayMs: 1, maxDelayMs: 5 } });
});

afterAll(async () => {
  await server.close();
  await briar.close();
});

describe("client ⇄ server", () => {
  it("creates, lists, reads and deletes contexts", async () => {
    const doc = await client.contexts.create({ name: "Portraits", id: "ctx_portraits" });
    expect(doc).toMatchObject({ id: "ctx_portraits", revision: 0 });
    await client.contexts.create({ name: "Scratch", id: "ctx_scratch" });
    await expect(client.contexts.create({ name: "Again", id: "ctx_scratch" })).rejects.toBeInstanceOf(ConflictError);

    const ids: string[] = [];
    for await (const c of client.contexts.iterate({ limit: 1 })) ids.push(c.id);
    expect(ids.sort()).toEqual(["ctx_portraits", "ctx_scratch"]);

    await client.contexts.delete("ctx_scratch");
    await expect(client.contexts.get("ctx_scratch")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("applies commands; stale revisions and rejected commands map to client errors", async () => {
    const applied = await client.contexts.apply("ctx_portraits", { baseRevision: 0, commands: PORTRAIT });
    expect(applied).toMatchObject({ revision: 1, changed: true });
    expect(applied.diagnostics).toEqual([]);

    const stale = await client.contexts.apply("ctx_portraits", { baseRevision: 0, commands: [{ op: "context.rename", name: "X" }] }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(RevisionConflictError);
    expect(stale).toMatchObject({ expected: 0, actual: 1 });

    const rejected = await client.contexts
      .apply("ctx_portraits", { baseRevision: 1, commands: [{ op: "context.rename", name: "Ok" }, { op: "flow.input.add", flowId: "flow_p", name: "Character", type: "text" }] })
      .catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(CommandError);
    expect(rejected).toMatchObject({ commandIndex: 1, op: "flow.input.add" });
    expect((await client.contexts.get("ctx_portraits")).revision).toBe(1);
  });

  it("runs a flow with SSE events, resumes a cut stream, and serves the generated image", async () => {
    const info = await client.flows.get("flow_p");
    expect(info.contextId).toBe("ctx_portraits");
    expect(Object.keys((info.signature.inputs as { properties: object }).properties)).toEqual(["character"]);

    cutFirstStream = true;
    const run = await client.flows.run("flow_p", { character: { name: "Ada" } });
    const events: RunEvent[] = [];
    for await (const e of run.events()) events.push(e);
    expect(cutFirstStream).toBe(false);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events[0]?.type).toBe("run.started");
    expect(events.at(-1)?.type).toBe("run.completed");

    const result = await run.result;
    expect(result.status).toBe("succeeded");
    expect((await client.runs.get(run.id)).result).toEqual(result);

    const image = result.outputs?.["image"] as { uri: string; mime: string; bytes: number };
    const blob = await client.media.download(image.uri.replace("briar-media://", ""));
    expect(blob.size).toBe(image.bytes);
    expect(blob.type).toBe(image.mime);
  });

  it("waits for a result, rejects invalid inputs and cancels a running flow", async () => {
    const waited = await client.flows.run("flow_p", { character: { name: "Bo" } }, { wait: true });
    expect(waited.status).toBe("succeeded");
    await expect(client.flows.run("flow_p", { character: { name: 3 } })).rejects.toBeInstanceOf(RunRejectedError);

    const slow = await client.flows.run("flow_d", { value: "late" });
    const cancelled = await client.runs.cancel(slow.id, "test");
    expect(cancelled.runId).toBe(slow.id);
    expect((await slow.result).status).toBe("cancelled");
    expect((await client.runs.cancel(slow.id)).status).toBe("cancelled");
  });

  it("uploads and downloads media; lists node types with revalidation", async () => {
    const bytes = new TextEncoder().encode("hello media");
    const ref = await client.media.upload(bytes, { mime: "text/plain", filename: "hello.txt" });
    expect(ref).toMatchObject({ mime: "text/plain", bytes: bytes.length });
    const blob = await client.media.download(ref.uri.replace("briar-media://", ""));
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

    const first = await client.nodeTypes.list();
    expect(first.nodes.some((n) => n.type === "mock.image")).toBe(true);
    expect(await client.nodeTypes.list()).toEqual(first);
  });

  it("maps authorize denials to AuthError and serves custom routes", async () => {
    const as = (user: string) => createBriarClient({ baseUrl: `${server.url}/api/v1`, headers: { "x-user": user } });
    await expect(as("viewer").flows.run("flow_p", { character: { name: "Cy" } })).rejects.toMatchObject({ status: 403 });
    await expect(as("anon").contexts.get("ctx_portraits")).rejects.toBeInstanceOf(AuthError);
    await expect(as("anon").contexts.get("ctx_portraits")).rejects.toMatchObject({ status: 401 });

    const custom = await fetch(`${server.url}/api/v1/portrait/Dee`);
    expect(custom.status).toBe(200);
    expect(((await custom.json()) as { description: string }).description).toContain("Dee");
  });
});
