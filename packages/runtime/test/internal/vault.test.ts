/**
 * ctx.secrets.read and ctx.settings.get: a node reads only the vault secrets its inputs or
 * its pack's settings give it.
 */
import { createMemorySettings, createMemoryVault, defineNode, definePack, t, type SecretVault } from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { describe, expect, it } from "vitest";
import { context, edge, field, flow, ir, node, testEngine } from "./helpers.js";

const useKey = defineNode({
  type: "keyed.useKey",
  inputs: { key: t.optional(t.secret({ kind: "apiKey" })), other: { type: t.text(), default: "" } },
  outputs: { text: t.text() },
  cache: false,
  run: async ({ inputs, ctx }) => {
    const fromSetting = (await ctx.settings.get("defaultKey")) as string | null;
    const ref = inputs.key ?? fromSetting;
    if (inputs.other !== "") return { text: await ctx.secrets.read(inputs.other) };
    return { text: ref ? `got ${(await ctx.secrets.read(ref)).length} chars` : "no key" };
  },
});
const keyed = definePack({ name: "keyed", version: "1.0.0", settings: { defaultKey: t.optional(t.secret()) }, nodes: [useKey] });

async function vaultWith(): Promise<SecretVault> {
  const vault = createMemoryVault();
  await vault.create({ name: "MAIN", kind: "apiKey", value: "sk-12345" });
  await vault.create({ name: "SIDE", kind: "text", value: "abc" });
  return vault;
}

function doc(values: Record<string, unknown>) {
  return context([
    flow({
      outputs: [field("text", ir.text())],
      nodes: [node("n_k", "keyed.useKey", { values })],
      edges: [edge("n_k.text", "n_out.text")],
    }),
  ]);
}

async function run(values: Record<string, unknown>, settings = createMemorySettings()) {
  const { engine } = testEngine({ packs: [stdPack, keyed], vault: await vaultWith(), settings });
  return engine.run({ context: doc(values), flowId: "flow_t" }).result;
}

describe("vault access", () => {
  it("reads the secret a secret input names", async () => {
    expect((await run({ key: "MAIN" })).outputs).toEqual({ text: "got 8 chars" });
  });

  it("reads the secret a secret setting of the pack names", async () => {
    expect((await run({}, createMemorySettings({ "keyed.defaultKey": "SIDE" }))).outputs).toEqual({ text: "got 3 chars" });
    expect((await run({})).outputs).toEqual({ text: "no key" });
  });

  it("refuses a secret the node was not given, by name in text", async () => {
    const r = await run({ key: "MAIN", other: "SIDE" });
    expect(r.status).toBe("failed");
    expect(r.error?.cause?.code ?? r.error?.code).toBe("node.secret_not_allowed");
  });

  it("fails with node.missing_secret for a name that is not in the vault", async () => {
    const r = await run({ key: "GONE" });
    expect(r.error?.cause?.code ?? r.error?.code).toBe("node.missing_secret");
  });
});
