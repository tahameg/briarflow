import { isBriarError } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import {
  AuthError,
  BriarClientError,
  CommandError,
  ConflictError,
  InvalidRequestError,
  InvalidResponseError,
  NetworkError,
  NotFoundError,
  RevisionConflictError,
  RunRejectedError,
  ServerError,
  createBriarClient,
} from "../../src/index.js";
import type { Command, FetchLike } from "../../src/index.js";

/** Deliberately untyped command (the server would reject it). */
const BAD = { op: "x" } as unknown as Command;

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof body === "string" && headers.get("content-type") === "application/json") body = JSON.parse(body);
    const call = { url, method: init.method ?? "GET", headers, body };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const errorBody = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { error: details === undefined ? { code, message } : { code, message, details } });

const BASE = "http://api.test/api/v1/";

describe("createBriarClient: requests", () => {
  it("builds URLs from the base URL, encodes ids and sends headers", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { id: "ctx_1" }));
    let n = 0;
    const client = createBriarClient({ baseUrl: BASE, fetch, headers: () => ({ authorization: `Bearer t${++n}` }) });
    await client.contexts.get("ctx_1");
    await client.contexts.get("a/b");
    expect(calls.map((c) => c.url)).toEqual(["http://api.test/api/v1/contexts/ctx_1", "http://api.test/api/v1/contexts/a%2Fb"]);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer t1");
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer t2");
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });

  it("creates, deletes and reads diagnostics", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "POST") return json(201, { id: "ctx_9", name: "Marketing", revision: 0 });
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      return json(200, { revision: 3, diagnostics: [] });
    });
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const doc = await client.contexts.create({ name: "Marketing", description: "d" });
    expect(doc.id).toBe("ctx_9");
    expect(calls[0]!.body).toEqual({ name: "Marketing", description: "d" });
    await expect(client.contexts.delete("ctx_9")).resolves.toBeUndefined();
    expect(calls[1]!.method).toBe("DELETE");
    expect(await client.contexts.diagnostics("ctx_9")).toEqual({ revision: 3, diagnostics: [] });
    expect(calls[2]!.url).toBe("http://api.test/api/v1/contexts/ctx_9/diagnostics");
  });

  it("applies commands with baseRevision and returns the typed result", async () => {
    const result = { revision: 13, changed: true, created: [{ nodeId: "n_1" }], diagnostics: [] };
    const { fetch, calls } = fakeFetch(() => json(200, result));
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const commands: Command[] = [{ op: "node.move", flowId: "flow_p", nodeId: "n_tpl", position: { x: 10, y: 20 } }];
    expect(await client.contexts.apply("ctx_1", { baseRevision: 12, commands })).toEqual(result);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://api.test/api/v1/contexts/ctx_1/commands");
    expect(calls[0]!.body).toEqual({ baseRevision: 12, commands });
  });

  it("paginates contexts lazily with the cursor and keeps search and limit", async () => {
    const pages: Record<string, unknown> = {
      "": { items: [{ id: "ctx_a" }, { id: "ctx_b" }], nextCursor: "c1" },
      c1: { items: [{ id: "ctx_c" }], nextCursor: "c2" },
      c2: { items: [] },
    };
    const { fetch, calls } = fakeFetch((c) => json(200, pages[new URL(c.url).searchParams.get("cursor") ?? ""]));
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const ids: string[] = [];
    for await (const s of client.contexts.iterate({ search: "mark", limit: 2 })) ids.push(s.id);
    expect(ids).toEqual(["ctx_a", "ctx_b", "ctx_c"]);
    expect(calls.map((c) => new URL(c.url).search)).toEqual(["?search=mark&limit=2", "?search=mark&limit=2&cursor=c1", "?search=mark&limit=2&cursor=c2"]);

    calls.length = 0;
    for await (const s of client.contexts.iterate()) {
      expect(s.id).toBe("ctx_a");
      break;
    }
    expect(calls).toHaveLength(1);
  });

  it("revalidates node types with If-None-Match", async () => {
    const body = { packs: [{ name: "briar", version: "1.0.0" }], nodes: [], types: [] };
    const { fetch, calls } = fakeFetch((c) => (c.headers.get("if-none-match") === '"h1"' ? new Response(null, { status: 304 }) : json(200, body, { etag: '"h1"' })));
    const client = createBriarClient({ baseUrl: BASE, fetch });
    expect(await client.nodeTypes.list()).toEqual(body);
    expect(await client.nodeTypes.list()).toEqual(body);
    expect(calls[1]!.headers.get("if-none-match")).toBe('"h1"');
  });

  it("uploads media as a raw body and downloads it as a Blob", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.method === "POST"
        ? json(201, { id: "m1", mime: "image/png", bytes: 3, source: { kind: "stored", uri: "briar-media://m1" }, createdAt: "2026-10-25T00:00:00.000Z" })
        : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const entry = await client.media.upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { filename: "cat.png" });
    expect(entry.id).toBe("m1");
    expect(calls[0]!.url).toBe("http://api.test/api/v1/media?filename=cat.png");
    expect(calls[0]!.headers.get("content-type")).toBe("image/png");
    const blob = await client.media.download("m1");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(client.media.url("m1")).toBe("http://api.test/api/v1/media/m1");
    await expect(client.media.upload(new Uint8Array([1]))).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("passes the abort signal through", async () => {
    const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
    const wrapped: FetchLike = (url, init) => {
      const p = fetch(url, init);
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        void p.then(resolve);
      });
    };
    const client = createBriarClient({ baseUrl: BASE, fetch: wrapped });
    const ac = new AbortController();
    const pending = client.contexts.get("ctx_1", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createBriarClient: error mapping", () => {
  const cases: [Response, new (...args: never[]) => BriarClientError, string][] = [
    [errorBody(409, "store.revision_conflict", "changed", { expected: 12, actual: 14 }), RevisionConflictError, "store.revision_conflict"],
    [errorBody(409, "context.exists", "exists"), ConflictError, "context.exists"],
    [errorBody(422, "edge.type_mismatch", "Cannot connect", { commandIndex: 3, op: "edge.connect" }), CommandError, "edge.type_mismatch"],
    [errorBody(422, "run.invalid_inputs", "bad inputs", { diagnostics: [] }), RunRejectedError, "run.invalid_inputs"],
    [errorBody(404, "context.not_found", "nope"), NotFoundError, "context.not_found"],
    [errorBody(401, "auth.unauthorized", "who"), AuthError, "auth.unauthorized"],
    [errorBody(403, "auth.forbidden", "no"), AuthError, "auth.forbidden"],
    [errorBody(400, "request.invalid_body", "bad", [{ path: "/name", problem: "too long" }]), InvalidRequestError, "request.invalid_body"],
    [errorBody(500, "internal", "oops"), ServerError, "internal"],
    [new Response("<html>bad gateway</html>", { status: 502 }), ServerError, "internal"],
    [new Response("teapot", { status: 418 }), BriarClientError, "client.http_error"],
  ];

  it.each(cases.map((c, i) => [i, ...c] as const))("case %i maps to the right class and keeps code/details", async (_i, response, Cls, code) => {
    const { fetch } = fakeFetch(() => response.clone());
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const err = await client.contexts.apply("ctx_1", { baseRevision: 12, commands: [BAD] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Cls);
    expect(err).toBeInstanceOf(BriarClientError);
    expect(isBriarError(err)).toBe(true);
    expect((err as BriarClientError).code).toBe(code);
    expect((err as BriarClientError).status).toBe(response.status);
  });

  it("exposes revision conflict and command details", async () => {
    const { fetch } = fakeFetch((c) =>
      c.url.endsWith("/a/commands")
        ? errorBody(409, "store.revision_conflict", "changed", { expected: 12, actual: 14 })
        : errorBody(422, "edge.type_mismatch", "Cannot connect Prompt.text (text) to Generate image.size (Size).", { commandIndex: 3, op: "edge.connect" }),
    );
    const client = createBriarClient({ baseUrl: BASE, fetch });
    const conflict = (await client.contexts.apply("a", { baseRevision: 12, commands: [BAD] }).catch((e: unknown) => e)) as RevisionConflictError;
    expect([conflict.expected, conflict.actual]).toEqual([12, 14]);
    expect(conflict.message).toBe("changed");
    const cmd = (await client.contexts.apply("b", { baseRevision: 12, commands: [BAD] }).catch((e: unknown) => e)) as CommandError;
    expect([cmd.commandIndex, cmd.op]).toEqual([3, "edge.connect"]);
    expect(cmd.message).toContain("Cannot connect");
    expect(cmd.details).toEqual({ commandIndex: 3, op: "edge.connect" });
  });

  it("wraps fetch failures in NetworkError and bad JSON in InvalidResponseError", async () => {
    const down = createBriarClient({ baseUrl: BASE, fetch: () => Promise.reject(new TypeError("fetch failed")) });
    const err = await down.contexts.get("ctx_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).code).toBe("client.network");
    expect((err as NetworkError).message).toContain("GET /contexts/ctx_1");

    const garbled = createBriarClient({ baseUrl: BASE, fetch: async () => new Response("not json", { status: 200 }) });
    await expect(garbled.contexts.get("ctx_1")).rejects.toBeInstanceOf(InvalidResponseError);
  });
});
