/**
 * End-to-end: a Python pack from the example worker used through the `briarflow` facade.
 * Skipped when python/.venv is missing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBriar, staticSecrets, type Briar } from "briarflow";
import { spawnPythonWorker, type PythonWorker } from "../../src/index.js";

const PYTHON_DIR = fileURLToPath(new URL("../../../../python/", import.meta.url));
const PYTHON = `${PYTHON_DIR}.venv/bin/python`;
const EXAMPLE = `${PYTHON_DIR}examples/imaging_nodes.py`;

describe.skipIf(!existsSync(PYTHON))("python pack through the briarflow facade", () => {
  let worker: PythonWorker;
  let briar: Briar;

  beforeAll(async () => {
    worker = await spawnPythonWorker({ command: PYTHON, args: [EXAMPLE], cwd: PYTHON_DIR });
    briar = createBriar({ packs: [await worker.pack()], secrets: staticSecrets({ IMAGING_KEY: "k" }) });
  }, 30_000);

  afterAll(async () => {
    await briar?.close();
    await worker?.stop();
  });

  it("lists the Python node types next to the standard ones", () => {
    const info = briar.nodeTypes();
    expect(info.packs.map((p) => p.name)).toEqual(["briar", "imaging"]);
    expect(info.nodes.map((n) => n.type)).toContain("imaging.uppercase");
  });

  it("builds, saves and runs a flow with Python nodes (secrets included)", async () => {
    const ctx = await briar.contexts.create({ name: "Python demo" });
    const flow = ctx.flows.create("Shout and sign");
    flow.inputs.add("text", "text");
    flow.outputs.add("loud", "text").outputs.add("signature", "text");
    const upper = flow.nodes.add("imaging.uppercase");
    const sign = flow.nodes.add("imaging.sign");
    flow.connect(flow.input.port("text"), upper.port("text"));
    flow.connect(upper.port("result"), sign.port("text"));
    flow.connect(upper.port("result"), flow.output.port("loud"));
    flow.connect(sign.port("result"), flow.output.port("signature"));
    await ctx.save();

    const run = await briar.run(flow.id, { text: "hello" });
    const result = await run.result;
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual({
      loud: "HELLO",
      signature: createHash("sha256").update("kHELLO").digest("hex"),
    });
    expect(briar.runs.get(run.id)?.info().status).toBe("succeeded");
  }, 30_000);
});
