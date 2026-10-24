import { defineNode, definePack, t } from "@briarflow/core";
import { createBriar, type Briar } from "briarflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBriarApp } from "../../src/index.js";

const BASE = "http://test/api/v1";

const keyed = definePack({
  name: "keyed",
  version: "1.0.0",
  title: "Keyed",
  settings: {
    apiKey: { type: t.optional(t.secret({ kind: "apiKey" })), title: "API key", description: "Key for every call." },
    retries: { type: t.int({ min: 0 }), default: 2 },
  },
  nodes: [defineNode({ type: "keyed.ping", outputs: { ok: t.boolean() }, run: () => ({ ok: true }) })],
});

let briar: Briar;
let app: ReturnType<typeof createBriarApp>;

beforeEach(() => {
  briar = createBriar({ packs: [keyed] });
  app = createBriarApp(briar);
});

afterEach(async () => {
  await briar.close();
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return Promise.resolve(app.request(`${BASE}${path}`, init));
}

describe("secrets", () => {
  it("creates, lists, changes and deletes secrets without ever returning a value", async () => {
    const created = await call("POST", "/secrets", { name: "OPENAI_KEY", kind: "apiKey", value: "sk-very-secret" });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain("sk-very-secret");
    expect(JSON.parse(createdText)).toMatchObject({ name: "OPENAI_KEY", kind: "apiKey" });

    const list = await call("GET", "/secrets");
    const listText = await list.text();
    expect(listText).not.toContain("sk-very-secret");
    expect((JSON.parse(listText) as { items: { name: string }[] }).items.map((s) => s.name)).toEqual(["OPENAI_KEY"]);

    expect((await call("POST", "/secrets/OPENAI_KEY", { value: "sk-new" })).status).toBe(200);
    expect(await briar.vault.reveal("OPENAI_KEY")).toEqual({ kind: "apiKey", value: "sk-new" });
    expect((await call("DELETE", "/secrets/OPENAI_KEY")).status).toBe(204);
    expect((await call("DELETE", "/secrets/OPENAI_KEY")).status).toBe(404);
  });

  it("rejects duplicates and bad secrets", async () => {
    await call("POST", "/secrets", { name: "N", kind: "number", value: "42" });
    expect((await call("POST", "/secrets", { name: "N", kind: "number", value: "1" })).status).toBe(409);
    const bad = await call("POST", "/secrets", { name: "J", kind: "json", value: "{oops" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("secret.invalid");
    expect((await call("POST", "/secrets", { name: "1bad", kind: "text", value: "x" })).status).toBe(422);
    expect((await call("POST", "/secrets", { name: "K", kind: "weird", value: "x" })).status).toBe(422);
  });
});

describe("settings", () => {
  it("lists pack settings and stores values that fit their types", async () => {
    const info = (await (await call("GET", "/settings")).json()) as { settings: { key: string; pack: string; title: string }[]; values: object };
    expect(info.settings.map((s) => [s.key, s.pack, s.title])).toEqual([
      ["keyed.apiKey", "keyed", "API key"],
      ["keyed.retries", "keyed", "Retries"],
    ]);
    expect(info.values).toEqual({});
    const set = await call("POST", "/settings", { key: "keyed.apiKey", value: "OPENAI_KEY" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { values: object }).values).toEqual({ "keyed.apiKey": "OPENAI_KEY" });
    expect((await call("POST", "/settings", { key: "keyed.retries", value: -1 })).status).toBe(422);
    expect((await call("POST", "/settings", { key: "nope.x", value: 1 })).status).toBe(422);
    const cleared = await call("POST", "/settings", { key: "keyed.apiKey", value: null });
    expect(((await cleared.json()) as { values: object }).values).toEqual({});
  });

  it("node types carry the pack settings", async () => {
    const body = (await (await call("GET", "/node-types")).json()) as { packs: { name: string; settings: { key: string }[] }[] };
    expect(body.packs.find((p) => p.name === "keyed")?.settings.map((s) => s.key)).toEqual(["keyed.apiKey", "keyed.retries"]);
  });
});
