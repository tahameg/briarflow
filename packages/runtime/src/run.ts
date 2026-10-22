/**
 * Internal: one local run (docs/specs/runtime.md §2–§8, variables.md §6–§8).
 */
import {
  NodeError,
  serializeError,
  type ContextDocument,
  type ExecContext,
  type Logger,
  type MediaStore,
  type NodeCatalog,
  type RetryPolicy,
  type Run,
  type RunEvent,
  type RunEventsOptions,
  type RunResult,
  type RunStatus,
  type SecretResolver,
  type SerializedError,
} from "@briarflow/core";
import { computeCacheKey, replaceMedia, type RunCache } from "./cache.js";
import { EventLog } from "./events.js";
import { classify, failure, type NodeFailure } from "./failures.js";
import { byDepthThenId, prepare, UNSET, type Plan, type PlannedNode } from "./prepare.js";
import type { Scheduler, SlotRequest } from "./scheduler.js";
import { checkPortValue } from "./values.js";

/** What a run needs from its engine. */
export interface RunServices {
  catalog: NodeCatalog;
  media: MediaStore;
  secrets: SecretResolver;
  logger: Logger;
  cache: RunCache;
  clock: () => Date;
  random: () => number;
  fetch: typeof fetch;
  cancelGraceMs: number;
  scheduler: Scheduler;
  /** `TypeError`s thrown by `ctx.fetch` (classified as `node.unavailable`). */
  fetchErrors: WeakSet<object>;
  /** Removes a queued run from the engine queue. */
  dequeue(run: LocalRun): void;
  /** Called once when a run reaches a terminal state. */
  finished(run: LocalRun): void;
}

/** Options of one run, defaults applied. */
export interface LocalRunOptions {
  runId: string;
  context: ContextDocument;
  flowId: string;
  inputs: unknown;
  useCache: boolean;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
}

type NodeState = "pending" | "waiting" | "running" | "retrying" | "completed" | "failed" | "skipped";

interface ProgressState {
  open: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: { fraction: number; message: string | undefined } | undefined;
}

interface NodeExec {
  state: NodeState;
  outputs: Record<string, unknown> | undefined;
  /** Waiting slot request (first start or retry). */
  slot: SlotRequest | undefined;
  holdsSlot: boolean;
  progress: ProgressState;
  startedAtMs: number;
}

type Outcome =
  | { kind: "ok"; value: unknown; usedState: boolean }
  | { kind: "error"; failure: NodeFailure }
  | { kind: "timeout" }
  | { kind: "cancelled" };

type Raced<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "aborted" };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventBody = DistributiveOmit<RunEvent, "runId" | "seq" | "at">;

/**
 * @deprecated Use `ExecContext` from `@briarflow/core`, which now has `resolveType` (REQ-6,
 * REQ-12). Kept as an alias for one phase.
 */
export type EngineExecContext = ExecContext;

const TERMINAL: ReadonlySet<NodeState> = new Set(["completed", "failed", "skipped"]);

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : `${typeof value} ${JSON.stringify(value)}`;
}

/** A run executed by the local engine. */
export class LocalRun implements Run {
  readonly id: string;
  readonly result: Promise<RunResult>;

  private statusValue: RunStatus = "queued";
  private resolveResult!: (result: RunResult) => void;
  private readonly log = new EventLog();
  private seq = 0;
  private lastAtMs = Number.NEGATIVE_INFINITY;
  private readonly abort = new AbortController();
  private cancelKind: "cancel" | "timeout" | undefined;
  private cancelMessage = "";
  private isFinished = false;
  private startedAt: string | undefined;
  private plan: Plan | undefined;
  private readonly exec = new Map<string, NodeExec>();
  private firstFailure: { node: PlannedNode; error: SerializedError } | undefined;
  private readonly readyQueue: string[] = [];
  private draining = false;
  /** Writer node id → value it wrote. */
  private readonly written = new Map<string, unknown>();
  /** Variable key → latest written value. */
  private readonly current = new Map<string, unknown>();
  private runTimer: ReturnType<typeof setTimeout> | undefined;
  private detachSignal: (() => void) | undefined;
  /** Identity of the document as given to `engine.run` (documents are immutable by contract). */
  private readonly contextId: string;
  private readonly contextRevision: number;

  constructor(
    private readonly services: RunServices,
    private readonly options: LocalRunOptions,
  ) {
    this.id = options.runId;
    this.contextId = options.context.id;
    this.contextRevision = options.context.revision;
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  get status(): RunStatus {
    return this.statusValue;
  }

  events(options?: RunEventsOptions): AsyncIterable<RunEvent> {
    return this.log.iterate(options?.after);
  }

  cancel(reason?: string): void {
    this.requestCancel("cancel", typeof reason === "string" && reason !== "" ? reason : "The run was cancelled.");
  }

  /** Links the caller's `signal` (engine, after queueing). */
  attachSignal(): void {
    const signal = this.options.signal;
    if (!signal) return;
    const onAbort = () => this.cancel(typeof signal.reason === "string" ? signal.reason : undefined);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    this.detachSignal = () => signal.removeEventListener("abort", onAbort);
  }

  // ------------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------------

  /** Leaves `queued` (engine, when a run slot is free). */
  begin(): void {
    if (this.isFinished) return;
    this.statusValue = "running";
    this.startedAt = this.nowIso();
    const { context, flowId, timeoutMs } = this.options;
    this.emit({ type: "run.started", flowId, contextId: this.contextId });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      this.runTimer = setTimeout(
        () => this.requestCancel("timeout", `The run took longer than ${timeoutMs} ms and was stopped.`),
        timeoutMs,
      );
    }
    try {
      const prepared = prepare(context, flowId, this.services.catalog, this.options.inputs);
      if (!prepared.ok) {
        this.finishWith("failed", prepared.error);
        return;
      }
      const plan = prepared.plan;
      this.plan = plan;
      for (const id of plan.nodes.keys()) {
        this.exec.set(id, {
          state: "pending",
          outputs: undefined,
          slot: undefined,
          holdsSlot: false,
          progress: { open: false, timer: undefined, pending: undefined },
          startedAtMs: 0,
        });
      }
      this.markReady([...plan.nodes.values()].filter((n) => n.deps.size === 0).map((n) => n.id));
      this.checkDone();
    } catch (err) {
      this.internalError(err);
    }
  }

  private internalError(err: unknown): void {
    if (this.isFinished) return;
    const cause = serializeError(err);
    this.finishWith("failed", {
      code: "run.internal",
      message: `The engine hit an internal error: ${cause.message}. Please report this as a Briarflow bug.`,
      cause,
    });
  }

  private requestCancel(kind: "cancel" | "timeout", message: string): void {
    if (this.isFinished || this.cancelKind) return;
    this.cancelKind = kind;
    this.cancelMessage = message;
    if (this.statusValue === "queued") {
      this.services.dequeue(this);
      this.finish();
      return;
    }
    this.abort.abort(new NodeError("node.cancelled", message));
    const plan = this.plan;
    if (plan) {
      const notStarted = [...plan.nodes.values()]
        .filter((n) => {
          const s = this.exec.get(n.id)?.state;
          return s === "pending" || s === "waiting";
        })
        .sort(byDepthThenId);
      for (const node of notStarted) {
        const ex = this.exec.get(node.id) as NodeExec;
        if (ex.slot) this.services.scheduler.withdraw(ex.slot);
        ex.slot = undefined;
        ex.state = "skipped";
        this.emit({ type: "node.skipped", nodeId: node.id, reason: "cancelled" });
      }
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.isFinished || !this.plan) return;
    for (const ex of this.exec.values()) if (!TERMINAL.has(ex.state)) return;
    this.finish();
  }

  private finish(): void {
    if (this.isFinished) return;
    if (this.cancelKind === "cancel") {
      this.finishWith("cancelled", { code: "run.cancelled", message: this.cancelMessage });
      return;
    }
    if (this.cancelKind === "timeout") {
      this.finishWith("failed", { code: "run.timeout", message: this.cancelMessage });
      return;
    }
    if (this.firstFailure) {
      const { node, error } = this.firstFailure;
      this.finishWith("failed", {
        code: "run.node_failed",
        message: `Node ${node.title} failed: ${error.message}`,
        nodeId: node.id,
        cause: error,
      });
      return;
    }
    const plan = this.plan as Plan;
    const outputNode = [...plan.nodes.values()].find((n) => n.kind === "output");
    const outputs = outputNode ? this.exec.get(outputNode.id)?.outputs : undefined;
    if (!outputs) {
      this.internalError(new Error("the output node did not complete"));
      return;
    }
    const variables: Record<string, unknown> = {};
    const globalWrites: Record<string, unknown> = {};
    for (const slot of plan.variables.values()) {
      const wrote = this.current.has(slot.key);
      if (slot.kind === "flow" && slot.isPublic) {
        const value = wrote ? this.current.get(slot.key) : slot.start;
        if (value !== UNSET) variables[slot.name] = value;
      }
      if (slot.kind === "global" && wrote) globalWrites[slot.name] = this.current.get(slot.key);
    }
    this.finishWith("succeeded", undefined, { outputs: { ...outputs }, variables, globalWrites });
  }

  private finishWith(
    status: RunResult["status"],
    error: SerializedError | undefined,
    success?: { outputs: Record<string, unknown>; variables: Record<string, unknown>; globalWrites: Record<string, unknown> },
  ): void {
    if (this.isFinished) return;
    this.isFinished = true;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    this.detachSignal?.();
    for (const ex of this.exec.values()) this.endProgress(ex);
    const finishedAt = this.nowIso();
    const { flowId } = this.options;
    const result: RunResult = {
      runId: this.id,
      flowId,
      contextId: this.contextId,
      contextRevision: this.contextRevision,
      status,
      startedAt: this.startedAt ?? finishedAt,
      finishedAt,
    };
    if (success) {
      result.outputs = success.outputs;
      result.variables = success.variables;
      result.globalWrites = success.globalWrites;
    }
    if (error) result.error = error;
    this.statusValue = status;
    this.emit({ type: "run.completed", result });
    this.resolveResult(result);
    this.services.finished(this);
  }

  // ------------------------------------------------------------------------------------------
  // Events and time
  // ------------------------------------------------------------------------------------------

  private nowMs(): number {
    return this.services.clock().getTime();
  }

  private nowIso(): string {
    this.lastAtMs = Math.max(this.lastAtMs, this.nowMs());
    return new Date(this.lastAtMs).toISOString();
  }

  private emit(body: EventBody): void {
    const event = { runId: this.id, seq: this.seq, at: this.nowIso(), ...body } as RunEvent;
    this.seq += 1;
    this.log.push(event);
  }

  private emitStarted(node: PlannedNode, ex: NodeExec, attempt: number): void {
    if (attempt === 1) ex.startedAtMs = this.nowMs();
    this.emit({ type: "node.started", nodeId: node.id, attempt });
  }

  // ------------------------------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------------------------------

  private markReady(ids: string[]): void {
    const plan = this.plan as Plan;
    const sorted = ids.map((id) => plan.nodes.get(id) as PlannedNode).sort(byDepthThenId);
    for (const n of sorted) this.readyQueue.push(n.id);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let id = this.readyQueue.shift(); id !== undefined; id = this.readyQueue.shift()) this.startNode(id);
    } finally {
      this.draining = false;
    }
  }

  private startNode(id: string): void {
    const node = (this.plan as Plan).nodes.get(id) as PlannedNode;
    const ex = this.exec.get(id) as NodeExec;
    if (ex.state !== "pending" || this.cancelKind || this.isFinished) return;
    if (node.kind !== "node") {
      this.runInline(node, ex);
      return;
    }
    ex.state = "waiting";
    const req: SlotRequest = {
      nodeType: node.node.type,
      limit: node.def?.concurrency,
      start: () => {
        ex.slot = undefined;
        ex.holdsSlot = true;
        ex.state = "running";
        this.emitStarted(node, ex, 1);
        this.execute(node, ex).catch((err: unknown) => {
          this.failNode(node, ex, failure("node.failed", `Internal engine error while running the node: ${serializeError(err).message}`, node.id));
        });
      },
    };
    ex.slot = req;
    this.services.scheduler.request(req);
  }

  private releaseSlot(node: PlannedNode, ex: NodeExec): void {
    if (!ex.holdsSlot) return;
    ex.holdsSlot = false;
    this.services.scheduler.release(node.node.type);
  }

  /** Waits for a slot again (retries). Resolves `false` when the run is cancelled first. */
  private acquire(node: PlannedNode, ex: NodeExec): Promise<boolean> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (ex.slot) this.services.scheduler.withdraw(ex.slot);
        ex.slot = undefined;
        resolve(false);
      };
      const req: SlotRequest = {
        nodeType: node.node.type,
        limit: node.def?.concurrency,
        start: () => {
          signal.removeEventListener("abort", onAbort);
          ex.slot = undefined;
          ex.holdsSlot = true;
          resolve(true);
        },
      };
      ex.slot = req;
      signal.addEventListener("abort", onAbort, { once: true });
      this.services.scheduler.request(req);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Node outcomes
  // ------------------------------------------------------------------------------------------

  private completeNode(node: PlannedNode, ex: NodeExec, outputs: Record<string, unknown>, cached: boolean): void {
    if (TERMINAL.has(ex.state) || this.isFinished) return;
    ex.state = "completed";
    ex.outputs = outputs;
    this.endProgress(ex);
    const durationMs = Math.max(0, this.nowMs() - ex.startedAtMs);
    this.emit({ type: "node.completed", nodeId: node.id, outputs, cached, durationMs });
    if (!this.cancelKind) {
      const plan = this.plan as Plan;
      const ready: string[] = [];
      for (const d of node.dependents) {
        const dep = plan.nodes.get(d) as PlannedNode;
        if (this.exec.get(d)?.state !== "pending") continue;
        if ([...dep.deps].every((x) => this.exec.get(x)?.state === "completed")) ready.push(d);
      }
      if (ready.length > 0) this.markReady(ready);
    }
    this.releaseSlot(node, ex);
    this.checkDone();
  }

  private failNode(node: PlannedNode, ex: NodeExec, f: NodeFailure): void {
    if (TERMINAL.has(ex.state) || this.isFinished) return;
    ex.state = "failed";
    this.endProgress(ex);
    this.emit({ type: "node.failed", nodeId: node.id, error: f.error });
    if (!this.cancelKind) {
      if (!this.firstFailure) this.firstFailure = { node, error: f.error };
      this.skipDownstream(node);
    }
    this.releaseSlot(node, ex);
    this.checkDone();
  }

  private cancelNode(node: PlannedNode, ex: NodeExec): void {
    this.failNode(node, ex, failure("node.cancelled", `Node ${node.title} was cancelled.`, node.id));
  }

  private skipDownstream(failed: PlannedNode): void {
    const plan = this.plan as Plan;
    const seen = new Set<string>();
    const stack = [...failed.dependents];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const d of (plan.nodes.get(id) as PlannedNode).dependents) stack.push(d);
    }
    const toSkip = [...seen]
      .filter((id) => this.exec.get(id)?.state === "pending")
      .map((id) => plan.nodes.get(id) as PlannedNode)
      .sort(byDepthThenId);
    for (const n of toSkip) {
      (this.exec.get(n.id) as NodeExec).state = "skipped";
      this.emit({ type: "node.skipped", nodeId: n.id, reason: "upstream_failed", cause: failed.id });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Inputs and outputs
  // ------------------------------------------------------------------------------------------

  private resolveInputs(node: PlannedNode): { ok: true; values: Record<string, unknown> } | { ok: false; failure: NodeFailure } {
    const plan = this.plan as Plan;
    const values: Record<string, unknown> = {};
    const constants = node.node.values ?? {};
    for (const port of node.ports.inputs) {
      const source = node.incoming.get(port.name);
      let value: unknown;
      if (source) {
        value = this.exec.get(source.node)?.outputs?.[source.port];
        if (value === undefined) value = null;
      } else if (Object.prototype.hasOwnProperty.call(constants, port.name) && constants[port.name] !== undefined) {
        value = constants[port.name];
      } else if (port.hasDefault) {
        value = port.default ?? null;
      } else if (port.type.kind === "optional") {
        value = null;
      } else {
        return {
          ok: false,
          failure: failure(
            "node.invalid_input",
            `Node ${node.title} has no value for input "${port.name}". Connect an edge or set a constant.`,
            node.id,
            { details: { port: port.name } },
          ),
        };
      }
      const r = checkPortValue(value, port.type, plan.scope, `inputs.${port.name}`, { flowId: plan.flow.id, nodeId: node.id, port: port.name });
      if (!r.ok) {
        return {
          ok: false,
          failure: failure("node.invalid_input", `Node ${node.title} got an invalid input: ${r.diagnostics[0]?.message ?? port.name}.`, node.id, {
            details: { diagnostics: r.diagnostics },
          }),
        };
      }
      values[port.name] = r.value;
    }
    return { ok: true, values };
  }

  private normalizeOutputs(node: PlannedNode, raw: unknown): { ok: true; outputs: Record<string, unknown> } | { ok: false; failure: NodeFailure } {
    const plan = this.plan as Plan;
    const bad = (message: string, details?: unknown): { ok: false; failure: NodeFailure } => ({
      ok: false,
      failure: failure("node.invalid_output", message, node.id, details === undefined ? {} : { details }),
    });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return bad(`Node ${node.title} returned ${describe(raw)} instead of an object with its outputs.`);
    }
    const rec = raw as Record<string, unknown>;
    const names = node.ports.outputs.map((p) => p.name);
    for (const key of Object.keys(rec)) {
      if (rec[key] !== undefined && !names.includes(key)) {
        return bad(
          `Node ${node.title} returned an unknown output "${key}". ${names.length > 0 ? `Its outputs are: ${names.join(", ")}.` : "It has no outputs."}`,
          { port: key },
        );
      }
    }
    const outputs: Record<string, unknown> = {};
    for (const port of node.ports.outputs) {
      let value = rec[port.name];
      if (value === undefined) {
        if (port.type.kind === "optional") value = null;
        else return bad(`Node ${node.title} did not return its output "${port.name}".`, { port: port.name });
      }
      const r = checkPortValue(value, port.type, plan.scope, `outputs.${port.name}`, { flowId: plan.flow.id, nodeId: node.id, port: port.name });
      if (!r.ok) return bad(`Node ${node.title} returned an invalid output: ${r.diagnostics[0]?.message ?? port.name}.`, { diagnostics: r.diagnostics });
      outputs[port.name] = r.value;
    }
    return { ok: true, outputs };
  }

  // ------------------------------------------------------------------------------------------
  // Inline nodes: built-ins and variables
  // ------------------------------------------------------------------------------------------

  private runInline(node: PlannedNode, ex: NodeExec): void {
    const plan = this.plan as Plan;
    ex.state = "running";
    this.emitStarted(node, ex, 1);
    try {
      if (node.kind === "input") {
        this.completeNode(node, ex, { ...plan.inputs }, false);
        return;
      }
      if (node.kind === "output") {
        const r = this.resolveInputs(node);
        if (r.ok) this.completeNode(node, ex, r.values, false);
        else this.failNode(node, ex, r.failure);
        return;
      }
      const slot = node.variable === undefined ? undefined : plan.variables.get(node.variable);
      if (!slot) {
        this.failNode(node, ex, failure("variable.unknown", `Node ${node.title} refers to a variable that no longer exists.`, node.id));
        return;
      }
      if (node.kind === "variableGet" || node.kind === "globalGet") {
        const writer = plan.reads.get(node.id) ?? null;
        const value = writer !== null && this.written.has(writer) ? this.written.get(writer) : slot.start;
        if (value === UNSET) {
          this.failNode(
            node,
            ex,
            failure(
              "node.invalid_input",
              `Node ${node.title} reads "${slot.name}" before anything writes it, and "${slot.name}" has no starting value.`,
              node.id,
            ),
          );
          return;
        }
        const out = this.normalizeOutputs(node, { value });
        if (out.ok) this.completeNode(node, ex, out.outputs, false);
        else this.failNode(node, ex, out.failure);
        return;
      }
      const r = this.resolveInputs(node);
      if (!r.ok) {
        this.failNode(node, ex, r.failure);
        return;
      }
      const value = r.values["value"];
      this.written.set(node.id, value);
      this.current.set(slot.key, value);
      this.completeNode(node, ex, { value }, false);
    } catch (err) {
      this.failNode(node, ex, classify(err, node.id, this.services.fetchErrors));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Catalog nodes: secrets, cache, attempts, retries
  // ------------------------------------------------------------------------------------------

  private async execute(node: PlannedNode, ex: NodeExec): Promise<void> {
    const def = node.def;
    if (!def) {
      this.failNode(node, ex, failure("node.failed", `Node type "${node.node.type}" is not loaded.`, node.id));
      return;
    }
    const inputs = this.resolveInputs(node);
    if (!inputs.ok) {
      this.failNode(node, ex, inputs.failure);
      return;
    }

    const secretValues = new Map<string, string>();
    for (const name of def.secrets) {
      const r = await this.raceAbort(() => this.services.secrets.get(name));
      if (this.cancelKind) return this.cancelNode(node, ex);
      if (r.kind === "error") return this.failNode(node, ex, classify(r.error, node.id, this.services.fetchErrors));
      if (r.kind !== "value" || typeof r.value !== "string") {
        return this.failNode(
          node,
          ex,
          failure("node.missing_secret", `Node ${node.title} needs secret "${name}". Set it in your secrets provider (e.g. env var ${name}).`, node.id, {
            details: { secret: name },
          }),
        );
      }
      secretValues.set(name, r.value);
    }

    let cacheKey: string | undefined;
    if (def.cache && this.options.useCache) {
      cacheKey = await this.cacheKey(node, inputs.values);
      if (cacheKey !== undefined) {
        const key = cacheKey;
        const r = await this.raceAbort(() => this.services.cache.get(key));
        if (this.cancelKind) return this.cancelNode(node, ex);
        if (r.kind === "error") this.cacheWarning("read", node, r.error);
        else if (r.kind === "value" && r.value !== undefined && r.value !== null) {
          // A shared or stale cache may hold outputs that no longer fit the ports (REQ-14).
          const cached = this.normalizeOutputs(node, typeof r.value === "object" ? { ...(r.value as object) } : r.value);
          if (cached.ok) return this.completeNode(node, ex, cached.outputs, true);
          this.services.logger.warn("Cache entry ignored: it does not match the node's outputs; running the node.", {
            runId: this.id,
            nodeId: node.id,
            error: cached.failure.error,
          });
        }
      }
    }

    for (let attempt = 1; ; ) {
      const outcome = await this.attempt(node, ex, inputs.values, attempt, secretValues);
      if (this.cancelKind) return this.cancelNode(node, ex);
      let fail: NodeFailure;
      if (outcome.kind === "ok") {
        const out = this.normalizeOutputs(node, outcome.value);
        if (out.ok) {
          if (cacheKey !== undefined && !outcome.usedState) {
            try {
              await this.services.cache.set(cacheKey, out.outputs);
            } catch (err) {
              this.cacheWarning("write", node, err);
            }
            if (this.cancelKind) return this.cancelNode(node, ex);
          }
          return this.completeNode(node, ex, out.outputs, false);
        }
        fail = out.failure;
      } else if (outcome.kind === "timeout") {
        fail = failure("node.timeout", `Node ${node.title} did not finish within ${def.timeoutMs} ms (attempt ${attempt}).`, node.id, {
          retryable: true,
          details: { timeoutMs: def.timeoutMs, attempt },
        });
      } else if (outcome.kind === "error") {
        fail = outcome.failure;
      } else {
        return this.cancelNode(node, ex);
      }

      if (!fail.retryable || attempt >= def.retry.maxAttempts) return this.failNode(node, ex, fail);
      const delayMs = this.retryDelay(def.retry, attempt, fail.retryAfterMs);
      this.emit({ type: "node.retrying", nodeId: node.id, attempt, nextAttempt: attempt + 1, delayMs, error: fail.error });
      ex.state = "retrying";
      this.releaseSlot(node, ex);
      await this.wait(delayMs);
      if (this.cancelKind) return this.cancelNode(node, ex);
      const granted = await this.acquire(node, ex);
      if (!granted || this.cancelKind) return this.cancelNode(node, ex);
      attempt += 1;
      ex.state = "running";
      this.emitStarted(node, ex, attempt);
    }
  }

  private cacheWarning(op: "read" | "write" | "key", node: PlannedNode, err: unknown): void {
    this.services.logger.warn(`Cache ${op} failed; treating it as a miss.`, {
      runId: this.id,
      nodeId: node.id,
      error: serializeError(err),
    });
  }

  private async cacheKey(node: PlannedNode, inputs: Record<string, unknown>): Promise<string | undefined> {
    const plan = this.plan as Plan;
    try {
      const keyed: Record<string, unknown> = {};
      for (const port of node.ports.inputs) {
        keyed[port.name] = replaceMedia(inputs[port.name], port.type, (id) => plan.scope.getType(id)?.decl);
      }
      return await computeCacheKey({
        nodeType: node.node.type,
        pack: node.pack,
        cacheVersion: node.def?.cacheVersion ?? "1",
        config: node.config,
        typeBindings: node.ports.typeBindings,
        inputs: keyed,
      });
    } catch (err) {
      this.cacheWarning("key", node, err);
      return undefined;
    }
  }

  private retryDelay(policy: RetryPolicy, attempt: number, retryAfterMs: number | undefined): number {
    const initial = policy.initialDelayMs ?? 500;
    const factor = policy.factor ?? 2;
    const max = policy.maxDelayMs ?? 10_000;
    let delay = Math.min(max, initial * factor ** (attempt - 1));
    if (policy.jitter ?? true) delay *= 0.5 + this.services.random() * 0.5;
    if (retryAfterMs !== undefined) delay = Math.min(Math.max(delay, retryAfterMs), max * 3);
    return Math.round(delay);
  }

  /** Resolves after `ms`, or early when the run is cancelled. */
  private wait(ms: number): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** Runs `work`, but stops waiting as soon as the run is cancelled. */
  private raceAbort<T>(work: () => T | Promise<T>): Promise<Raced<T>> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      const onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
      let p: Promise<T>;
      try {
        p = Promise.resolve(work());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ kind: "value", value });
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ kind: "error", error });
        },
      );
    });
  }

  private attempt(
    node: PlannedNode,
    ex: NodeExec,
    inputs: Record<string, unknown>,
    attempt: number,
    secrets: Map<string, string>,
  ): Promise<Outcome> {
    const def = node.def;
    const runSignal = this.abort.signal;
    if (!def || runSignal.aborted) return Promise.resolve({ kind: "cancelled" });
    const controller = new AbortController();
    let usedState = false;
    let active = true;
    const ctx = this.makeContext(node, ex, controller.signal, attempt, secrets, () => {
      usedState = true;
    }, () => active);
    return new Promise<Outcome>((resolve) => {
      let settled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const onRunAbort = () => {
        controller.abort(runSignal.reason);
        graceTimer = setTimeout(() => settle({ kind: "cancelled" }), this.services.cancelGraceMs);
      };
      const settle = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        active = false;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        runSignal.removeEventListener("abort", onRunAbort);
        resolve(outcome);
      };
      runSignal.addEventListener("abort", onRunAbort, { once: true });
      if (def.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          controller.abort(new NodeError("node.timeout", `Node ${node.title} did not finish within ${def.timeoutMs} ms.`));
          settle({ kind: "timeout" });
        }, def.timeoutMs);
      }
      let work: Promise<unknown>;
      try {
        work = Promise.resolve(def.run({ inputs: inputs as never, config: node.config as never, node: node.node, ctx }));
      } catch (err) {
        work = Promise.reject(err);
      }
      work.then(
        (value) => settle({ kind: "ok", value, usedState }),
        (err: unknown) => settle({ kind: "error", failure: classify(err, node.id, this.services.fetchErrors) }),
      );
    });
  }

  private makeContext(
    node: PlannedNode,
    ex: NodeExec,
    signal: AbortSignal,
    attempt: number,
    secrets: Map<string, string>,
    markStateRead: () => void,
    isActive: () => boolean,
  ): ExecContext {
    const plan = this.plan as Plan;
    const def = node.def;
    const logger = this.services.logger;
    const tag = { runId: this.id, nodeId: node.id };
    const lookup = (kind: "flow" | "global", name: string): unknown => {
      markStateRead();
      for (const slot of plan.variables.values()) {
        if (slot.kind === kind && slot.name === name) return slot.start === UNSET ? undefined : slot.start;
      }
      throw new NodeError(
        "variable.unknown",
        kind === "global"
          ? `Global "${name}" does not exist in context "${this.options.context.name}". Check the name.`
          : `Variable "${name}" does not exist in flow "${plan.flow.name}". Check the name.`,
        { details: { name } },
      );
    };
    const baseFetch = this.services.fetch;
    const fetchErrors = this.services.fetchErrors;
    const boundFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        return await baseFetch(input, init?.signal ? init : { ...(init ?? {}), signal });
      } catch (err) {
        if (err instanceof TypeError) fetchErrors.add(err);
        throw err;
      }
    }) as typeof fetch;
    return {
      signal,
      runId: this.id,
      flowId: plan.flow.id,
      nodeId: node.id,
      attempt,
      progress: (fraction: number, message?: string) => {
        if (isActive()) this.reportProgress(node, ex, fraction, message);
      },
      log: {
        debug: (message, data) => logger.debug(message, { ...data, ...tag }),
        info: (message, data) => logger.info(message, { ...data, ...tag }),
        warn: (message, data) => logger.warn(message, { ...data, ...tag }),
        error: (message, data) => logger.error(message, { ...data, ...tag }),
      },
      media: this.services.media,
      secrets: {
        get: async (name: string) => {
          const value = secrets.get(name);
          if (!def?.secrets.includes(name) || value === undefined) {
            throw new NodeError(
              "node.secret_not_declared",
              `Node ${node.title} asked for secret "${name}", which its definition does not declare. Add "${name}" to the node's secrets.`,
              { details: { secret: name } },
            );
          }
          return value;
        },
      },
      globals: { get: (name: string) => lookup("global", name) },
      variables: { get: (name: string) => lookup("flow", name) },
      fetch: boundFetch,
      resolveType: (id: string) => plan.scope.getType(id)?.decl,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Progress (throttled to one event per 100 ms per node, latest wins)
  // ------------------------------------------------------------------------------------------

  private reportProgress(node: PlannedNode, ex: NodeExec, fraction: number, message: string | undefined): void {
    if (TERMINAL.has(ex.state) || this.isFinished) return;
    if (typeof fraction !== "number" || Number.isNaN(fraction)) return;
    const f = Math.min(1, Math.max(0, fraction));
    const m = typeof message === "string" ? message.slice(0, 200) : undefined;
    const p = ex.progress;
    if (!p.open) {
      this.emitProgress(node.id, f, m);
      p.open = true;
      p.timer = setTimeout(() => this.flushProgress(node, ex), 100);
    } else {
      p.pending = { fraction: f, message: m };
    }
  }

  private flushProgress(node: PlannedNode, ex: NodeExec): void {
    const p = ex.progress;
    p.timer = undefined;
    const pending = p.pending;
    p.pending = undefined;
    if (pending && !TERMINAL.has(ex.state) && !this.isFinished) {
      this.emitProgress(node.id, pending.fraction, pending.message);
      p.timer = setTimeout(() => this.flushProgress(node, ex), 100);
    } else {
      p.open = false;
    }
  }

  private emitProgress(nodeId: string, fraction: number, message: string | undefined): void {
    this.emit(message === undefined ? { type: "node.progress", nodeId, fraction } : { type: "node.progress", nodeId, fraction, message });
  }

  private endProgress(ex: NodeExec): void {
    const p = ex.progress;
    if (p.timer !== undefined) clearTimeout(p.timer);
    p.timer = undefined;
    p.pending = undefined;
    p.open = false;
  }
}
