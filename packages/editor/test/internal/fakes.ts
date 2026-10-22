/**
 * Test doubles: a tiny command applier (a handful of ops with inverses, used until/besides the
 * real `@briarflow/authoring`) and a scriptable in-memory backend.
 */
import { CommandError } from "@briarflow/authoring";
import type { BatchResult, Command, CreatedIds } from "@briarflow/authoring";
import type { NodeTypesInfo } from "@briarflow/client";
import { createContextDocument, createFlowDocument, createSequentialIdGenerator } from "@briarflow/core";
import type { ContextDocument, FlowDocument, Run, RunEvent, RunResult, RunStatus } from "@briarflow/core";
import type { BackendApplyInput, BackendApplyResult, CommandApplier, EditorBackend } from "../../src/index.js";

export const CLOCK = () => new Date("2026-01-01T00:00:00Z");

export function baseDoc(): ContextDocument {
  const ids = createSequentialIdGenerator();
  const doc = createContextDocument({ name: "Test", id: "ctx_1", idGenerator: ids, clock: CLOCK });
  const flow = createFlowDocument({ name: "Main", id: "flow_a", inputNodeId: "n_in", outputNodeId: "n_out", idGenerator: ids });
  return { ...doc, flows: [flow] };
}

/** Applies node.add / node.move / node.remove / flow.setViewport / context.rename. */
export const fakeApplier: CommandApplier = (doc, commands, options) => {
  let d = doc;
  const inverse: Command[] = [];
  const resolved: Command[] = [];
  const created: CreatedIds[] = [];
  const fail = (i: number, c: Command, code: string, message: string): BatchResult => ({
    ok: false,
    error: new CommandError(code, message, { commandIndex: i, op: c.op }),
  });
  const flowOf = (id: string) => d.flows.find((f) => f.id === id);
  const withFlow = (f: FlowDocument) => ({ ...d, flows: d.flows.map((x) => (x.id === f.id ? f : x)) });
  for (const [i, c] of commands.entries()) {
    if (c.op === "context.rename") {
      if (c.name.trim() === "") return fail(i, c, "command.invalid_payload", "Command context.rename: name must not be empty.");
      inverse.unshift({ op: "context.rename", name: d.name, restore: true });
      d = { ...d, name: c.name };
      resolved.push(c);
      created.push({});
      continue;
    }
    if (!("flowId" in c)) return fail(i, c, "command.unknown_op", `Unknown command "${c.op}".`);
    const flow = flowOf(c.flowId as string);
    if (!flow) return fail(i, c, "command.unknown_ref", `Command ${c.op}: flow "${String(c.flowId)}" does not exist.`);
    if (c.op === "node.add") {
      const id = c.id ?? options.idGenerator!("n");
      if (flow.nodes.some((n) => n.id === id)) return fail(i, c, "command.duplicate_id", `Command node.add: id "${id}" is already used by a node.`);
      d = withFlow({ ...flow, nodes: [...flow.nodes, { id, type: c.type, position: c.position }] });
      inverse.unshift({ op: "node.remove", flowId: flow.id, nodeId: id, restore: true });
      resolved.push({ ...c, id });
      created.push({ nodeId: id });
    } else if (c.op === "node.move" || c.op === "node.remove") {
      const node = flow.nodes.find((n) => n.id === c.nodeId);
      if (!node) return fail(i, c, "command.unknown_ref", `Command ${c.op}: node "${c.nodeId}" does not exist.`);
      if (c.op === "node.move") {
        if (node.position.x !== c.position.x || node.position.y !== c.position.y) {
          d = withFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === node.id ? { ...n, position: c.position } : n)) });
          inverse.unshift({ op: "node.move", flowId: flow.id, nodeId: node.id, position: node.position, restore: true });
        }
      } else {
        d = withFlow({ ...flow, nodes: flow.nodes.filter((n) => n.id !== node.id) });
        inverse.unshift({ op: "node.add", flowId: flow.id, id: node.id, type: node.type, position: node.position, restore: true });
      }
      resolved.push(c);
      created.push({});
    } else if (c.op === "flow.setViewport") {
      d = withFlow({ ...flow, ui: { viewport: c.viewport } });
      resolved.push(c);
      created.push({});
    } else {
      return fail(i, c, "command.unknown_op", `Unknown command "${c.op}".`);
    }
  }
  const changed = JSON.stringify({ ...d, revision: 0 }) !== JSON.stringify({ ...doc, revision: 0 });
  if (!changed) return { ok: true, doc, created, inverse: [], resolved, diagnostics: [], changed: false };
  const clock = options.clock ?? (() => new Date());
  return {
    ok: true,
    doc: { ...d, revision: doc.revision + 1, updatedAt: clock().toISOString() },
    created,
    inverse,
    resolved,
    diagnostics: [],
    changed: true,
  };
};

type ApplyBehaviour = "ok" | { error: unknown } | "hold";

interface HeldCall {
  input: BackendApplyInput;
  release(): void;
}

/** In-memory backend that applies commands with the given applier (or answers as scripted). */
export class FakeBackend implements EditorBackend {
  doc: ContextDocument;
  readonly applyCalls: BackendApplyInput[] = [];
  readonly held: HeldCall[] = [];
  loads = 0;
  /** Next behaviours of `apply`, consumed in order; default "ok". */
  readonly script: ApplyBehaviour[] = [];
  /** When true every apply waits for `releaseNext()`. */
  holdAll = false;
  runs: FakeRun[] = [];
  runError: unknown;
  nodeTypesInfo: NodeTypesInfo = { packs: [], nodes: [], types: [] };

  constructor(
    doc: ContextDocument,
    private readonly applier: CommandApplier,
    private readonly catalog: Parameters<CommandApplier>[2]["catalog"],
  ) {
    this.doc = doc;
  }

  async load(): Promise<ContextDocument> {
    this.loads++;
    return this.doc;
  }

  async nodeTypes(): Promise<NodeTypesInfo> {
    return this.nodeTypesInfo;
  }

  async apply(_contextId: string, input: BackendApplyInput): Promise<BackendApplyResult> {
    this.applyCalls.push({ baseRevision: input.baseRevision, commands: [...input.commands] });
    let behaviour = this.script.shift() ?? "ok";
    if (behaviour === "ok" && this.holdAll) behaviour = "hold";
    if (behaviour === "hold") {
      await new Promise<void>((resolve) => this.held.push({ input, release: resolve }));
    } else if (behaviour !== "ok") {
      throw behaviour.error;
    }
    if (input.baseRevision !== this.doc.revision) {
      throw Object.assign(new Error("Revision conflict"), {
        code: "store.revision_conflict",
        details: { expected: input.baseRevision, actual: this.doc.revision },
      });
    }
    const r = this.applier(this.doc, input.commands, { catalog: this.catalog, clock: CLOCK });
    if (!r.ok) throw r.error;
    this.doc = r.doc;
    return { revision: r.doc.revision, changed: r.changed, diagnostics: r.diagnostics };
  }

  releaseNext(): void {
    this.held.shift()?.release();
  }

  async run(flowId: string): Promise<Run> {
    if (this.runError) throw this.runError;
    const run = new FakeRun(`run_${this.runs.length + 1}`, flowId);
    this.runs.push(run);
    return run;
  }
}

/** A run whose events are pushed by the test. */
export class FakeRun implements Run {
  status: RunStatus = "running";
  readonly result: Promise<RunResult>;
  cancelled: string | undefined | null = null;
  private resolveResult!: (r: RunResult) => void;
  private readonly events_: RunEvent[] = [];
  private waiters: (() => void)[] = [];
  private seq = 0;

  constructor(
    readonly id: string,
    readonly flowId: string,
  ) {
    this.result = new Promise((resolve) => (this.resolveResult = resolve));
  }

  emit(event: Record<string, unknown> & { type: RunEvent["type"] }): void {
    const e = { runId: this.id, seq: this.seq++, at: "2026-01-01T00:00:00.000Z", ...event } as RunEvent;
    this.events_.push(e);
    if (e.type === "run.completed") {
      this.status = e.result.status;
      this.resolveResult(e.result);
    }
    for (const w of this.waiters.splice(0)) w();
  }

  complete(status: "succeeded" | "failed" | "cancelled" = "succeeded"): RunResult {
    const result: RunResult = {
      runId: this.id,
      flowId: this.flowId,
      contextId: "ctx_1",
      contextRevision: 0,
      status,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      ...(status === "succeeded" ? { outputs: {} } : { error: { code: "run.node_failed", message: "boom" } }),
    };
    this.emit({ type: "run.completed", result });
    return result;
  }

  events(): AsyncIterable<RunEvent> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let i = 0;
        for (;;) {
          while (i < self.events_.length) {
            const e = self.events_[i++]!;
            yield e;
            if (e.type === "run.completed") return;
          }
          await new Promise<void>((resolve) => self.waiters.push(resolve));
        }
      },
    };
  }

  cancel(reason?: string): void {
    this.cancelled = reason;
  }
}

/** Lets pending promise callbacks run. */
export async function tick(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
