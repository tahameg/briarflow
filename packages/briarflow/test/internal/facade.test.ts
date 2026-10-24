import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandError } from "@briarflow/authoring";
import { createSequentialIdGenerator, type ContextStore, type LogData, type Logger, type MediaStore } from "@briarflow/core";
import { mockHash, mockPack } from "@briarflow/nodes-mock";
import { FsContextStore, FsMediaStore } from "@briarflow/storage-fs";
import { SqliteContextStore, SqliteLastRunStore, SqliteMediaRegistry } from "@briarflow/storage-sqlite";
import { createBriar, envSecrets, MemoryContextStore, MemoryMediaStore, staticSecrets, type Briar, type BriarOptions } from "briarflow";

function stepClock(start = Date.parse("2026-01-01T00:00:00Z"), stepMs = 1000): () => Date {
  let t = start;
  return () => new Date((t += stepMs));
}

function setup(extra: Partial<BriarOptions> = {}): Briar {
  return createBriar({ packs: [mockPack], idGenerator: createSequentialIdGenerator(), clock: stepClock(), ...extra });
}

/** The README quick start: struct + template + mock LLM. */
async function quickStart(briar: Briar) {
  const ctx = await briar.contexts.create({ name: "Marketing" });
  ctx.types.defineEnum("ArtStyle", ["anime", "realistic", "pixel"]);
  ctx.types.defineStruct("Character", { name: "text", age: "int", style: "ArtStyle" });
  ctx.globals.create("brandGuide", "text", { access: "readonly", value: "Pastel colors" });
  const flow = ctx.flows.create("Portrait");
  flow.inputs.add("character", "Character");
  flow.outputs.add("reply", "text");
  const brk = flow.nodes.add("briar.struct.break", { config: { typeId: ctx.types.get("Character").id } });
  const tpl = flow.nodes.add("text.template", { at: [300, 100], config: { template: "Portrait of {{name}}, {{style}} style" } });
  const llm = flow.nodes.add("mock.llm", { values: { seed: 7 } });
  flow.connect(flow.input.port("character"), brk.port("value"));
  flow.connect(brk.port("name"), tpl.port("name"));
  flow.connect(brk.port("style"), tpl.port("style"));
  flow.connect(tpl.port("text"), llm.port("prompt"));
  flow.connect(llm.port("text"), flow.output.port("reply"));
  flow.line(flow.input, llm, flow.output);
  expect(ctx.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
  await ctx.save();
  return { ctx, flow };
}

async function expectQuickStartRun(briar: Briar, flowId: string): Promise<void> {
  const run = await briar.run(flowId, { character: { name: "Aria", age: 27, style: "anime" } });
  const result = await run.result;
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("succeeded");
  const prompt = "Portrait of Aria, anime style";
  const hash = await mockHash({ system: null, prompt, seed: 7 });
  expect(result.outputs).toEqual({ reply: `Mock reply ${hash.slice(0, 8)}: ${prompt}` });
}

describe("quick start", () => {
  it("builds a flow with fluent handles and runs it (memory stores)", async () => {
    const briar = setup();
    const { flow, ctx } = await quickStart(briar);
    expect(ctx.dirty).toBe(false);
    expect(ctx.savedRevision).toBe(ctx.revision);
    await expectQuickStartRun(briar, flow.id);
    await briar.close();
  });

  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it.each([
    ["fs", async (dir: string) => ({ store: new FsContextStore({ dir: join(dir, "ctx"), durable: false }) as ContextStore, blobs: new FsMediaStore({ dir: join(dir, "media"), durable: false }) as MediaStore })],
    [
      "sqlite",
      async (dir: string) => ({
        store: new SqliteContextStore({ file: join(dir, "briar.db") }) as ContextStore,
        media: new SqliteMediaRegistry({ file: join(dir, "briar.db") }),
        lastRuns: new SqliteLastRunStore({ file: join(dir, "briar.db") }),
        blobs: new MemoryMediaStore() as MediaStore,
      }),
    ],
  ])("runs against the %s store and survives a new facade instance", async (_kind, make) => {
    const dir = await mkdtemp(join(tmpdir(), "briar-facade-"));
    dirs.push(dir);
    const first = await make(dir);
    const briar = setup(first);
    const { flow } = await quickStart(briar);
    await expectQuickStartRun(briar, flow.id);
    await briar.close();

    const again = setup(await make(dir));
    const handle = await again.flows.get(flow.id);
    expect(handle.name).toBe("Portrait");
    await expectQuickStartRun(again, flow.id);
    await again.close();
  });
});

describe("contexts and flows", () => {
  it("lists, iterates, finds flows across contexts and deletes", async () => {
    const briar = setup();
    const a = await briar.contexts.create({ name: "Alpha" });
    const b = await briar.contexts.create({ name: "Beta", description: "second" });
    const fa = a.flows.create("One");
    const fb = b.flows.create("Two");
    await a.save();
    await b.save();
    expect((await briar.contexts.list()).items.map((c) => c.name)).toEqual(["Beta", "Alpha"]);
    const all: string[] = [];
    for await (const c of briar.contexts.iterate({ pageSize: 1 })) all.push(c.id);
    expect(all).toEqual([b.id, a.id]);
    expect((await briar.flows.get(fa.id)).context.id).toBe(a.id);
    expect((await briar.flows.get(fb.id)).context.id).toBe(b.id);
    const info = await briar.flows.info(fb.id);
    expect(info).toMatchObject({ contextId: b.id, revision: b.revision, flow: { id: fb.id, name: "Two" } });
    expect(info.signature.inputs).toMatchObject({ type: "object" });
    await expect(briar.flows.get("flow_nope")).rejects.toMatchObject({ code: "flow.not_found" });
    await expect(briar.contexts.get("ctx_nope")).rejects.toMatchObject({ code: "context.not_found" });
    expect(await briar.contexts.find("ctx_nope")).toBeUndefined();
    await expect(briar.contexts.create({ name: "Dup", id: a.id })).rejects.toMatchObject({ code: "context.exists" });
    expect(await briar.contexts.delete(a.id)).toBe(true);
    await expect(briar.flows.get(fa.id)).rejects.toMatchObject({ code: "flow.not_found" });
  });

  it("reports node types with the std pack added automatically", () => {
    const info = setup().nodeTypes();
    expect(info.packs.map((p) => p.name)).toEqual(["briar", "mock"]);
    expect(info.nodes.some((n) => n.type === "mock.llm")).toBe(true);
    expect(info.types.map((t) => t.id)).toContain("briar.RoundingMode");
    expect(createBriar({ std: false, packs: [mockPack] }).nodeTypes().packs.map((p) => p.name)).toEqual(["mock"]);
  });
});

describe("handles", () => {
  it("throws CommandError for rejected calls, supports undo/redo and detects save conflicts", async () => {
    const briar = setup();
    const ctx = await briar.contexts.create({ name: "H" });
    const flow = ctx.flows.create("F");
    expect(() => flow.inputs.add("x", "Nope")).toThrow(CommandError);
    expect(() => flow.nodes.add("nope.node")).toThrowError(/nope\.node/);
    flow.inputs.add("x", "text");
    expect(flow.doc.inputs.map((i) => i.name)).toEqual(["x"]);
    expect(ctx.undo()).toBe(true);
    expect(flow.doc.inputs).toEqual([]);
    expect(ctx.redo()).toBe(true);
    expect(ctx.redo()).toBe(false);
    expect(() => ctx.globals.get("missing")).toThrowError(/has no global "missing"/);
    await ctx.save();

    const other = await briar.contexts.get(ctx.id);
    other.apply({ op: "context.rename", name: "Renamed" });
    await other.save();
    ctx.apply({ op: "context.setDescription", description: "stale" });
    await expect(ctx.save()).rejects.toMatchObject({ code: "store.revision_conflict" });
    await ctx.reload();
    expect(ctx.name).toBe("Renamed");
    expect(ctx.dirty).toBe(false);
  });
});

describe("applyCommands", () => {
  it("applies, saves and maps conflicts and rejections", async () => {
    const briar = setup();
    const ctx = await briar.contexts.create({ name: "Cmd" });
    const ok = await briar.applyCommands(ctx.id, { baseRevision: 0, commands: [{ op: "flow.create", name: "Portrait", id: "flow_p" }] });
    expect(ok).toMatchObject({ revision: 1, changed: true, created: [{ flowId: "flow_p" }] });
    expect((await briar.store.load(ctx.id))?.revision).toBe(1);
    expect(await briar.flows.locate("flow_p")).toBe(ctx.id);

    await expect(briar.applyCommands(ctx.id, { baseRevision: 0, commands: [{ op: "context.rename", name: "X" }] })).rejects.toMatchObject({
      code: "store.revision_conflict",
      details: { expected: 0, actual: 1 },
    });

    const rejected = briar.applyCommands(ctx.id, {
      baseRevision: 1,
      commands: [
        { op: "context.rename", name: "Fine" },
        { op: "flow.rename", flowId: "flow_nope", name: "Y" },
      ],
    });
    await expect(rejected).rejects.toBeInstanceOf(CommandError);
    await expect(rejected).rejects.toMatchObject({ code: "command.unknown_ref", details: { commandIndex: 1, op: "flow.rename" } });
    expect((await briar.store.load(ctx.id))?.name).toBe("Cmd");

    const noop = await briar.applyCommands(ctx.id, { baseRevision: 1, commands: [{ op: "context.rename", name: "Cmd" }] });
    expect(noop).toMatchObject({ revision: 1, changed: false });

    await expect(briar.applyCommands("ctx_missing", { baseRevision: 0, commands: [] })).rejects.toMatchObject({ code: "context.not_found" });
    await expect(briar.applyCommands(ctx.id, { baseRevision: -1, commands: "x" as never })).rejects.toMatchObject({
      code: "request.invalid_body",
    });

    const other = await briar.contexts.create({ name: "Other" });
    await expect(briar.applyCommands(other.id, { baseRevision: 0, commands: [{ op: "flow.create", name: "Clash", id: "flow_p" }] })).rejects.toMatchObject({
      code: "store.flow_id_conflict",
    });
  });
});

describe("global writes", () => {
  async function counterFlow(briar: Briar) {
    const ctx = await briar.contexts.create({ name: "Globals" });
    const note = ctx.globals.create("note", "text", { value: "old" });
    const extra = ctx.globals.create("extra", "text", { value: "old" });
    const flow = ctx.flows.create("Write");
    flow.inputs.add("text", "text");
    flow.outputs.add("written", "text");
    const set = flow.nodes.setGlobal(note);
    const set2 = flow.nodes.setGlobal(extra);
    flow.connect(flow.input.port("text"), set.port("value"));
    flow.connect(set.port("value"), set2.port("value"));
    flow.connect(set2.port("value"), flow.output.port("written"));
    flow.wireExecution();
    expect(ctx.diagnostics().filter((d) => d.severity === "error")).toEqual([]);
    await ctx.save();
    return { ctx, flow, note, extra };
  }

  function capture(): { logger: Logger; warnings: [string, LogData | undefined][] } {
    const warnings: [string, LogData | undefined][] = [];
    const noop = () => {};
    return { warnings, logger: { debug: noop, info: noop, error: (m, d) => warnings.push([m, d]), warn: (m, d) => warnings.push([m, d]) } };
  }

  it("persists writes before run.result resolves", async () => {
    const briar = setup();
    const { ctx, flow, note } = await counterFlow(briar);
    const run = await briar.run(flow.id, { text: "new" });
    const result = await run.result;
    expect(result.globalWrites).toEqual({ note: "new", extra: "new" });
    expect(run.globalWriteStatus).toBe("applied");
    const stored = await briar.store.load(ctx.id);
    expect(stored?.globals.find((g) => g.id === note.id)?.value).toBe("new");
    expect(stored?.revision).toBe(ctx.revision + 1);
  });

  it("retries on revision conflicts", async () => {
    const briar = setup();
    const { ctx, flow, note } = await counterFlow(briar);
    // Conflicting store: the first save attempt fails as if someone saved meanwhile.
    const store = briar.store;
    const realSave = store.save.bind(store);
    let failures = 2;
    store.save = async (doc, options) => {
      if (failures > 0 && options?.expectedRevision !== undefined) {
        failures -= 1;
        const current = await store.load(doc.id);
        await realSave({ ...current!, revision: current!.revision + 1, description: `edit ${failures}` });
      }
      return realSave(doc, options);
    };
    const run = await briar.run(flow.id, { text: "retry" });
    await run.result;
    expect(run.globalWriteStatus).toBe("applied");
    const stored = await store.load(ctx.id);
    expect(stored?.globals.find((g) => g.id === note.id)?.value).toBe("retry");
    expect(stored?.description).toBe("edit 0");
  });

  it("drops writes to globals deleted or made readonly meanwhile", async () => {
    const { logger, warnings } = capture();
    const briar = setup({ logger });
    const { ctx, flow, note, extra } = await counterFlow(briar);
    // Someone makes "extra" readonly between run start and write-back: the first load by the
    // write-back applies that edit first.
    const store = briar.store;
    const realLoad = store.load.bind(store);
    let edited = false;
    store.load = async (id) => {
      if (!edited) {
        edited = true;
        await briar.applyCommands(id, { baseRevision: ctx.revision, commands: [{ op: "global.setAccess", globalId: extra.id, access: "readonly" }] });
      }
      return realLoad(id);
    };
    const run = await briar.run(flow.id, { text: "x" }, { context: ctx.doc });
    await run.result;
    expect(run.globalWriteStatus).toBe("partial");
    expect(warnings).toContainEqual(["global.write_dropped", { runId: run.id, globalId: extra.id, reason: "readonly" }]);
    const stored = await briar.store.load(ctx.id);
    expect(stored?.globals.find((g) => g.id === note.id)?.value).toBe("x");
    expect(stored?.globals.find((g) => g.id === extra.id)?.value).toBe("old");

    await briar.store.delete(ctx.id);
    const gone = await briar.run(flow.id, { text: "y" }, { context: ctx.doc });
    await gone.result;
    expect(gone.globalWriteStatus).toBe("failed");
  });

  it("writes nothing for failed runs", async () => {
    const briar = setup();
    const { ctx, flow } = await counterFlow(briar);
    const run = await briar.run(flow.id, { text: 42 });
    expect((await run.result).status).toBe("failed");
    expect(run.globalWriteStatus).toBeUndefined();
    expect((await briar.store.load(ctx.id))?.revision).toBe(ctx.revision);
  });
});

describe("runs", () => {
  async function echo(briar: Briar) {
    const ctx = await briar.contexts.create({ name: "Echo" });
    const flow = ctx.flows.create("Echo");
    flow.inputs.add("text", "text").outputs.add("text", "text");
    flow.connect(flow.input.port("text"), flow.output.port("text"));
    await ctx.save();
    return flow;
  }

  it("registers runs, filters and evicts finished ones", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const briar = setup({ clock: () => new Date(now), runRetention: { maxRuns: 2, maxAgeMs: 60_000 } });
    const flow = await echo(briar);
    const r1 = await briar.run(flow.id, { text: "a" });
    expect(briar.runs.get(r1.id)).toBe(r1);
    await r1.result;
    expect(r1.info()).toMatchObject({ runId: r1.id, flowId: flow.id, status: "succeeded", result: { outputs: { text: "a" } } });
    const r2 = await briar.run(flow.id, { text: "b" });
    const r3 = await briar.run(flow.id, { text: "c" });
    await Promise.all([r2.result, r3.result]);
    expect(briar.runs.list().map((r) => r.id)).toEqual([r3.id, r2.id]);
    expect(briar.runs.get(r1.id)).toBeUndefined();
    expect(briar.runs.list({ flowId: "flow_other" })).toEqual([]);
    now += 120_000;
    expect(briar.runs.list()).toEqual([]);
  });

  it("throwOnInvalid maps invalid inputs to run.invalid_inputs", async () => {
    const briar = setup();
    const flow = await echo(briar);
    await expect(briar.run(flow.id, { text: 1 }, { throwOnInvalid: true })).rejects.toMatchObject({
      code: "run.invalid_inputs",
      message: expect.stringMatching(/^Flow "Echo" received 1 invalid input: /),
    });
    await expect(briar.run(flow.id, { text: 1 }, { throwOnInvalid: true })).rejects.toMatchObject({ details: { diagnostics: [expect.anything()] } });
    await expect(briar.run("flow_nope", {})).rejects.toMatchObject({ code: "flow.not_found" });
    const first = await briar.run(flow.id, { text: "a" }, { runId: "run_custom" });
    await expect(briar.run(flow.id, { text: "b" }, { runId: "run_custom" })).rejects.toMatchObject({ code: "run.invalid_call" });
    await first.result;
  });

  it("flow.run runs unsaved edits", async () => {
    const briar = setup();
    const flow = await echo(briar);
    flow.outputs.add("extra", "text");
    flow.connect(flow.input.port("text"), flow.output.port("extra"));
    const result = await (await flow.run({ text: "hi" })).result;
    expect(result.outputs).toEqual({ text: "hi", extra: "hi" });
  });

  it("close cancels running runs, closes packs and stores, and refuses later calls", async () => {
    let packClosed = false;
    const closablePack = Object.assign(Object.create(mockPack) as typeof mockPack, { close: () => void (packClosed = true) });
    const store = new MemoryContextStore();
    const briar = createBriar({ store, packs: [closablePack], idGenerator: createSequentialIdGenerator() });
    const ctx = await briar.contexts.create({ name: "Slow" });
    const flow = ctx.flows.create("Slow");
    flow.inputs.add("text", "text").outputs.add("text", "text");
    const delay = flow.nodes.add("mock.delay", { values: { ms: 10_000 } });
    flow.connect(flow.input.port("text"), delay.port("value"));
    flow.connect(delay.port("value"), flow.output.port("text"));
    flow.line(flow.input, delay, flow.output);
    await ctx.save();
    const run = await briar.run(flow.id, { text: "x" });
    await briar.close();
    expect((await run.result).status).toBe("cancelled");
    expect(packClosed).toBe(true);
    await expect(store.list()).rejects.toMatchObject({ code: "store.closed" });
    await expect(briar.contexts.list()).rejects.toMatchObject({ code: "briar.closed" });
    await briar.close();
  });
});

describe("secrets", () => {
  it("envSecrets reads prefixed variables, empty counts as missing", async () => {
    const s = envSecrets({ prefix: "B_", env: { B_KEY: "v", B_EMPTY: "" } });
    expect(await s.get("KEY")).toBe("v");
    expect(await s.get("EMPTY")).toBeUndefined();
    process.env["BRIARFLOW_TEST_SECRET"] = "env";
    expect(await envSecrets("BRIARFLOW_TEST_").get("SECRET")).toBe("env");
    delete process.env["BRIARFLOW_TEST_SECRET"];
    expect(await staticSecrets({ A: "1" }).get("A")).toBe("1");
    expect(await staticSecrets({ A: "1" }).get("toString")).toBeUndefined();
  });
});

describe("MemoryMediaStore", () => {
  it("puts, gets, deletes; never reuses ids; enforces maxBytes", async () => {
    const media = new MemoryMediaStore({ maxBytes: 10 });
    const ref = await media.put(new TextEncoder().encode("hello"), { mime: "Text/Plain; charset=utf-8", filename: "h.txt" });
    expect(ref).toMatchObject({ mime: "text/plain", bytes: 5, hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", meta: { filename: "h.txt" } });
    expect(ref.uri).toMatch(/^briar-media:\/\/m_[A-Za-z0-9]{24}$/);
    const got = await media.get(ref.uri.slice("briar-media://".length));
    expect(new TextDecoder().decode(new Uint8Array(await new Response(got!.body).arrayBuffer()))).toBe("hello");
    expect(await media.get("https://example.com/x")).toBeUndefined();
    const again = await media.put(new TextEncoder().encode("hello"), { mime: "text/plain" });
    expect(again.uri).not.toBe(ref.uri);
    expect(await media.delete(ref)).toBe(true);
    expect(await media.delete(ref)).toBe(false);
    await expect(media.put(new Uint8Array(11), { mime: "application/octet-stream" })).rejects.toMatchObject({ code: "media.too_large" });
    await expect(media.put(new Uint8Array(1), { mime: "nope" })).rejects.toMatchObject({ code: "media.invalid_mime" });
  });
});
