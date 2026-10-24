/**
 * The last run of each flow and carry-over of media-making nodes (media.md §5).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSequentialIdGenerator, type MediaRef, type RunEvent } from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { SqliteContextStore, SqliteLastRunStore, SqliteMediaRegistry } from "@briarflow/storage-sqlite";
import { createBriar, type Briar, type BriarOptions } from "briarflow";

function setup(extra: Partial<BriarOptions> = {}): Briar {
  return createBriar({ packs: [mockPack], idGenerator: createSequentialIdGenerator(), ...extra });
}

/** prompt → mock.image → image, on the execution line. */
async function imageFlow(briar: Briar): Promise<string> {
  const ctx = await briar.contexts.create({ name: "Pics", id: "ctx_pics" });
  const flow = ctx.flows.create("Picture");
  flow.inputs.add("prompt", "text");
  flow.outputs.add("image", "image");
  const img = flow.nodes.add("mock.image", { id: "n_img", values: { width: 8, height: 8 } });
  flow.connect(flow.input.port("prompt"), img.port("prompt"));
  flow.connect(img.port("image"), flow.output.port("image"));
  flow.line(flow.input, img, flow.output);
  await ctx.save();
  return flow.id;
}

async function runOnce(briar: Briar, flowId: string, prompt: string, options: { force?: boolean } = {}) {
  const run = await briar.run(flowId, { prompt }, options);
  const events: RunEvent[] = [];
  for await (const e of run.events()) events.push(e);
  const result = await run.result;
  expect(result.status).toBe("succeeded");
  const node = events.find((e): e is Extract<RunEvent, { type: "node.completed" }> => e.type === "node.completed" && e.nodeId === "n_img");
  return { runId: run.id, image: result.outputs?.["image"] as MediaRef, cached: node?.cached };
}

describe("last runs", () => {
  it("records the flow's last run with node outputs and reuse keys", async () => {
    const briar = setup();
    const flowId = await imageFlow(briar);
    expect(await briar.runs.last(flowId)).toBeUndefined();
    const first = await runOnce(briar, flowId, "cat");
    const last = await briar.runs.last(flowId);
    expect(last).toMatchObject({ runId: first.runId, flowId, contextId: "ctx_pics", status: "succeeded", inputs: { prompt: "cat" } });
    expect(last?.nodes["n_img"]).toMatchObject({ state: "completed", outputs: { image: first.image }, key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await briar.media.entry(first.image))?.owner).toEqual({ runId: first.runId, flowId, contextId: "ctx_pics" });
    await briar.close();
  });

  it("carries unchanged media nodes over, runs changed ones and removes what the new run did not keep", async () => {
    const briar = setup();
    const flowId = await imageFlow(briar);
    const first = await runOnce(briar, flowId, "cat");

    const same = await runOnce(briar, flowId, "cat");
    expect(same.cached).toBe(true);
    expect(same.image).toEqual(first.image);
    expect((await briar.media.entry(same.image))?.owner?.runId).toBe(same.runId);

    const changed = await runOnce(briar, flowId, "dog");
    expect(changed.cached).toBe(false);
    expect(changed.image).not.toEqual(first.image);
    expect(await briar.media.entry(first.image)).toBeUndefined();
    expect(await briar.media.entry(changed.image)).toBeDefined();
    await briar.close();
  });

  it("force runs every node again and drops the old artifact", async () => {
    const briar = setup();
    const flowId = await imageFlow(briar);
    const first = await runOnce(briar, flowId, "cat");
    const forced = await runOnce(briar, flowId, "cat", { force: true });
    expect(forced.cached).toBe(false);
    expect(forced.image).not.toEqual(first.image);
    expect(await briar.media.entry(first.image)).toBeUndefined();
    // A forced result is cached and recorded like any other.
    expect((await runOnce(briar, flowId, "cat")).image).toEqual(forced.image);
    await briar.close();
  });

  it("does not carry over media that is gone", async () => {
    const briar = setup({ engine: { cache: { get: async () => undefined, set: async () => {} } } });
    const flowId = await imageFlow(briar);
    const first = await runOnce(briar, flowId, "cat");
    await briar.media.delete(first.image);
    const again = await runOnce(briar, flowId, "cat");
    expect(again.cached).toBe(false);
    expect(await briar.media.entry(again.image)).toBeDefined();
    await briar.close();
  });
});

describe("last runs in SQLite", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const persistent = (file: string): Partial<BriarOptions> => ({
    store: new SqliteContextStore({ file }),
    media: new SqliteMediaRegistry({ file }),
    lastRuns: new SqliteLastRunStore({ file }),
  });

  it("carries the last run over into a new server process, loading the artifact from the database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "briar-last-run-"));
    dirs.push(dir);
    const file = join(dir, "briar.db");
    const one = setup(persistent(file));
    const flowId = await imageFlow(one);
    const first = await runOnce(one, flowId, "cat");
    const bytes = await one.media.read(first.image);
    await one.close();

    // A new facade: empty memory cache and memory copies; everything comes from the database.
    const two = createBriar({ packs: [mockPack], ...persistent(file) });
    expect((await two.runs.last(flowId))?.runId).toBe(first.runId);
    expect(await two.media.read(first.image)).toEqual(bytes);
    const again = await runOnce(two, flowId, "cat");
    expect(again.cached).toBe(true);
    expect(again.image).toEqual(first.image);
    await two.close();
  });

  it("at start, marks a run that never finished as interrupted and removes media no last run keeps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "briar-last-run-"));
    dirs.push(dir);
    const file = join(dir, "briar.db");
    const registry = new SqliteMediaRegistry({ file });
    const lastRuns = new SqliteLastRunStore({ file });
    const kept = await registry.add({ mime: "text/plain", source: { kind: "data" }, owner: { runId: "run_kept", flowId: "flow_a", contextId: "ctx_a" } }, new Uint8Array([1]));
    const orphan = await registry.add({ mime: "text/plain", source: { kind: "data" }, owner: { runId: "run_old", flowId: "flow_a", contextId: "ctx_a" } }, new Uint8Array([2]));
    const upload = await registry.add({ mime: "text/plain", source: { kind: "data" } }, new Uint8Array([3]));
    await lastRuns.set({ runId: "run_kept", contextId: "ctx_a", flowId: "flow_a", revision: 1, status: "running", requestedAt: "2026-10-25T00:00:00.000Z", inputs: {}, nodes: {} });
    registry.close();
    lastRuns.close();

    // The clean-up runs when the facade starts; close() waits for it.
    await createBriar({ ...persistent(file) }).close();
    const store = new SqliteLastRunStore({ file });
    const after = new SqliteMediaRegistry({ file });
    expect((await store.get("ctx_a", "flow_a"))?.status).toBe("interrupted");
    expect(await after.get(kept.id)).toBeDefined();
    expect(await after.get(orphan.id)).toBeUndefined();
    expect(await after.get(upload.id)).toBeDefined();
    store.close();
    after.close();
  });
});
