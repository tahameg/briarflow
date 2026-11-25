/**
 * docs/specs/secrets.md: the `secret` primitive (a vault name), the memory vault and pack
 * settings.
 */
import { describe, expect, it } from "vitest";
import { createMemoryVault, defineNode, definePack, formatType, isAssignable, parseType, readMember, t, toJsonSchema, validateValue, createTypeScope } from "../src/index.js";

const scope = createTypeScope({});

describe("Secret type (built-in struct)", () => {
  it("holds a secret name; ApiKey fixes the kind", () => {
    const type = t.apiKey().ref;
    expect(type).toEqual({ kind: "named", id: "briar.ApiKey" });
    expect(validateValue({ name: "OPENAI_KEY" }, type, scope)).toEqual([]);
    expect(validateValue("OPENAI_KEY", type, scope)).toHaveLength(1);
    expect(validateValue({ name: "K", kind: "apiKey" }, type, scope)[0]?.message).toContain("static field");
    expect(readMember({ name: "K" }, type, ["kind"], (id) => scope.getType(id)?.decl)).toBe("apiKey");
  });

  it("ApiKey fits where Secret is expected, not the other way; parses and has an object schema", () => {
    const resolve = (id: string) => scope.getType(id)?.decl;
    expect(isAssignable(t.apiKey().ref, t.secret().ref, resolve)).toBe(true);
    expect(isAssignable(t.secret().ref, t.apiKey().ref, resolve)).toBe(false);
    expect(isAssignable(t.string().ref, t.secret().ref, resolve)).toBe(false);
    const parsed = parseType("Secret?");
    expect(parsed.ok && formatType(parsed.type)).toBe("Secret?");
    expect(toJsonSchema(t.secret().ref, scope)).toMatchObject({ $ref: "#/$defs/Secret" });
  });
});

describe("memory vault", () => {
  it("never lists values and checks kinds", async () => {
    const vault = createMemoryVault({ clock: () => new Date("2026-10-24T00:00:00.000Z") });
    await vault.create({ name: "K", kind: "apiKey", value: "sk-1" });
    expect(JSON.stringify(await vault.list())).not.toContain("sk-1");
    expect(await vault.reveal("K")).toEqual({ kind: "apiKey", value: "sk-1" });
    expect(await vault.reveal("missing")).toBeUndefined();
    await expect(vault.create({ name: "K", kind: "text", value: "x" })).rejects.toMatchObject({ code: "secret.exists" });
    await expect(vault.create({ name: "N", kind: "number", value: "ten" })).rejects.toMatchObject({ code: "secret.invalid" });
    await expect(vault.create({ name: "J", kind: "json", value: "{" })).rejects.toMatchObject({ code: "secret.invalid" });
    await expect(vault.update("missing", "x")).rejects.toMatchObject({ code: "secret.not_found" });
  });
});

describe("pack settings", () => {
  const node = defineNode({ type: "p.n", run: () => ({}) });

  it("are qualified by the pack name, titled and checked", () => {
    const pack = definePack({ name: "p", version: "1.0.0", nodes: [node], settings: { chatKey: t.optional(t.secret()), retries: { type: t.int({ min: 0 }), default: 1, description: "How often." } } });
    expect(pack.settings).toEqual([
      { key: "p.chatKey", name: "chatKey", title: "Chat key", type: { kind: "optional", of: { kind: "named", id: "briar.Secret" } } },
      { key: "p.retries", name: "retries", title: "Retries", description: "How often.", type: { kind: "primitive", name: "int", constraints: { min: 0 } }, default: 1 },
    ]);
    expect(definePack({ name: "q", version: "1.0.0", nodes: [] }).settings).toEqual([]);
  });

  it("reject bad names, named types and bad defaults", () => {
    expect(() => definePack({ name: "p", version: "1.0.0", nodes: [], settings: { "bad name": t.string() } })).toThrow("is not a valid name");
    expect(() => definePack({ name: "p", version: "1.0.0", nodes: [], settings: { x: t.ref("ty_a") } })).toThrow("other named types and generics");
    expect(() => definePack({ name: "p", version: "1.0.0", nodes: [], settings: { x: { type: t.int({ min: 0 }), default: -1 } } })).toThrow("invalid default");
  });
});
