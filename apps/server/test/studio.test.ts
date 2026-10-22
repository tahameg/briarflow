import { createBriar } from "briarflow";
import type { Logger } from "@briarflow/core";
import { describe, expect, it } from "vitest";
import { ensureStudioStart } from "../src/studio.js";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("ensureStudioStart", () => {
  it("returns nothing when no start context is configured", async () => {
    expect(await ensureStudioStart(createBriar(), {}, quiet)).toEqual({});
  });

  it("creates a missing context and flow once, then finds them by name", async () => {
    const briar = createBriar();
    const first = await ensureStudioStart(briar, { context: "Marketing", flow: "Portrait" }, quiet);
    expect(first.contextId).toMatch(/^ctx_/);
    expect(first.flowId).toMatch(/^flow_/);
    const ctx = await briar.contexts.get(first.contextId!);
    expect([ctx.name, ctx.doc.flows.map((f) => f.name)]).toEqual(["Marketing", ["Portrait"]]);
    expect(await ensureStudioStart(briar, { context: "Marketing", flow: "Portrait" }, quiet)).toEqual(first);
  });

  it("matches an existing context and flow by id", async () => {
    const briar = createBriar();
    const { contextId, flowId } = await ensureStudioStart(briar, { context: "A", flow: "Main" }, quiet);
    expect(await ensureStudioStart(briar, { context: contextId!, flow: flowId! }, quiet)).toEqual({ contextId, flowId });
  });
});
