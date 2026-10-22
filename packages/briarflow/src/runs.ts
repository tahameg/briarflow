/**
 * Facade runs: registry, and applying global writes after successful runs
 * (docs/specs/variables.md §8, runtime.md §7).
 */
import { applyCommand, applyCommands, type Command } from "@briarflow/authoring";
import {
  isBriarError,
  type Clock,
  type ContextDocument,
  type ContextStore,
  type IdGenerator,
  type Logger,
  type NodeCatalog,
  type Run,
  type RunEvent,
  type RunEventsOptions,
  type RunResult,
  type RunStatus,
} from "@briarflow/core";

/** Outcome of applying a run's global writes to the stored context. */
export type GlobalWriteStatus = "applied" | "partial" | "failed";

/** JSON view of a run (what `GET /runs/:runId` returns). */
export interface RunInfo {
  runId: string;
  flowId: string;
  contextId: string;
  status: RunStatus;
  createdAt: string;
  /** Present once the run is terminal (and its global writes are persisted). */
  result?: RunResult;
  /** Present when the run succeeded and wrote globals. */
  globalWriteStatus?: GlobalWriteStatus;
}

/**
 * A run started through the facade. Same interface as the engine's `Run`, but `result`
 * resolves only after the run's global writes are saved to the store, so
 * `await run.result` means "writes are persisted".
 *
 * @example
 * ```ts
 * const run = await briar.run("flow_p", { topic: "cats" });
 * for await (const e of run.events()) console.log(e.type);
 * const result = await run.result;
 * ```
 */
export interface BriarRun extends Run {
  readonly flowId: string;
  readonly contextId: string;
  /** ISO time the run was created. */
  readonly createdAt: string;
  /** The result once `result` resolved, else `undefined`. */
  readonly finished: RunResult | undefined;
  /** Set after a successful run that wrote globals. */
  readonly globalWriteStatus: GlobalWriteStatus | undefined;
  /** JSON view for APIs. */
  info(): RunInfo;
}

/** Services the write-back needs. */
export interface WriteBackServices {
  store: ContextStore;
  catalog: NodeCatalog;
  logger: Logger;
  clock: Clock;
  idGenerator: IdGenerator;
  attempts: number;
}

/** A facade run wrapping an engine run. */
export class FacadeRun implements BriarRun {
  readonly result: Promise<RunResult>;
  readonly createdAt: string;
  #finished: RunResult | undefined;
  #finishedAtMs: number | undefined;
  #globalWriteStatus: GlobalWriteStatus | undefined;

  constructor(
    private readonly inner: Run,
    readonly flowId: string,
    readonly contextId: string,
    /** Global name → id in the document the run used (variables.md §8 step 2). */
    globalIds: ReadonlyMap<string, string>,
    services: WriteBackServices,
  ) {
    this.createdAt = services.clock().toISOString();
    this.result = inner.result.then(async (result) => {
      const writes = result.status === "succeeded" ? result.globalWrites : undefined;
      if (writes && Object.keys(writes).length > 0) {
        this.#globalWriteStatus = await applyGlobalWrites(result.runId, contextId, writes, globalIds, services);
      }
      this.#finished = result;
      this.#finishedAtMs = services.clock().getTime();
      return result;
    });
  }

  get id(): string {
    return this.inner.id;
  }

  get status(): RunStatus {
    return this.inner.status;
  }

  get finished(): RunResult | undefined {
    return this.#finished;
  }

  /** Clock time (ms) when `result` resolved. */
  get finishedAtMs(): number | undefined {
    return this.#finishedAtMs;
  }

  get globalWriteStatus(): GlobalWriteStatus | undefined {
    return this.#globalWriteStatus;
  }

  events(options?: RunEventsOptions): AsyncIterable<RunEvent> {
    return this.inner.events(options);
  }

  cancel(reason?: string): void {
    this.inner.cancel(reason);
  }

  info(): RunInfo {
    const info: RunInfo = { runId: this.id, flowId: this.flowId, contextId: this.contextId, status: this.status, createdAt: this.createdAt };
    if (this.#finished) {
      info.status = this.#finished.status;
      info.result = this.#finished;
    }
    if (this.#globalWriteStatus) info.globalWriteStatus = this.#globalWriteStatus;
    return info;
  }
}

/**
 * Applies `writes` (global name → value) to the stored context (variables.md §8). Never throws.
 */
export async function applyGlobalWrites(
  runId: string,
  contextId: string,
  writes: Readonly<Record<string, unknown>>,
  globalIds: ReadonlyMap<string, string>,
  services: WriteBackServices,
): Promise<GlobalWriteStatus> {
  const { store, logger } = services;
  const options = { catalog: services.catalog, clock: services.clock, idGenerator: services.idGenerator };
  const total = Object.keys(writes).length;
  for (let attempt = 1; attempt <= services.attempts; attempt++) {
    let doc: ContextDocument | undefined;
    try {
      doc = await store.load(contextId);
    } catch (err) {
      logger.error("global.write_failed", { runId, contextId, reason: "load_failed", error: describe(err) });
      return "failed";
    }
    if (!doc) {
      for (const name of Object.keys(writes)) {
        logger.warn("global.write_dropped", { runId, globalId: globalIds.get(name) ?? name, reason: "context_deleted" });
      }
      return "failed";
    }

    const commands: Command[] = [];
    const dropped: { globalId: string; reason: string; message?: string }[] = [];
    for (const [name, value] of Object.entries(writes)) {
      const globalId = globalIds.get(name);
      const global = globalId === undefined ? undefined : doc.globals.find((g) => g.id === globalId);
      if (globalId === undefined || !global) {
        dropped.push({ globalId: globalId ?? name, reason: "deleted" });
        continue;
      }
      if (global.access === "readonly") {
        dropped.push({ globalId, reason: "readonly" });
        continue;
      }
      const command: Command = { op: "global.setValue", globalId, value };
      const check = applyCommand(doc, command, options);
      if (!check.ok) {
        dropped.push({ globalId, reason: "invalid_value", message: check.error.message });
        continue;
      }
      commands.push(command);
    }

    if (commands.length > 0) {
      const batch = applyCommands(doc, commands, options);
      if (!batch.ok) {
        logger.error("global.write_failed", { runId, contextId, reason: "rejected", error: batch.error.message });
        return "failed";
      }
      if (batch.changed) {
        try {
          await store.save(batch.doc, { expectedRevision: doc.revision });
        } catch (err) {
          if (isBriarError(err) && err.code === "store.revision_conflict" && attempt < services.attempts) continue;
          logger.error("global.write_failed", {
            runId,
            contextId,
            reason: isBriarError(err) && err.code === "store.revision_conflict" ? "conflict_retries_exhausted" : "save_failed",
            attempts: attempt,
            error: describe(err),
          });
          return "failed";
        }
      }
    }

    for (const d of dropped) logger.warn("global.write_dropped", { runId, ...d });
    if (dropped.length === 0) return "applied";
    return dropped.length === total ? "failed" : "partial";
  }
  return "failed";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Retention of finished runs (runtime.md §7: last 200 or 1 hour). */
export interface RunRetention {
  /** Finished runs kept. Default 200. */
  maxRuns?: number;
  /** Finished runs older than this (ms since they finished) are evicted. Default 3 600 000. */
  maxAgeMs?: number;
}

/** Filter of `briar.runs.list`. */
export interface RunListFilter {
  flowId?: string;
  contextId?: string;
  status?: RunStatus;
  /** Default 50. */
  limit?: number;
}

/** In-memory run registry. Running runs are never evicted. */
export class RunRegistry {
  #runs = new Map<string, FacadeRun>();
  readonly #maxRuns: number;
  readonly #maxAgeMs: number;

  constructor(
    retention: RunRetention,
    private readonly clock: Clock,
  ) {
    this.#maxRuns = retention.maxRuns ?? 200;
    this.#maxAgeMs = retention.maxAgeMs ?? 3_600_000;
  }

  add(run: FacadeRun): void {
    this.#runs.set(run.id, run);
    void run.result.then(() => this.prune());
    this.prune();
  }

  get(runId: string): FacadeRun | undefined {
    this.prune();
    return this.#runs.get(runId);
  }

  list(filter: RunListFilter = {}): FacadeRun[] {
    this.prune();
    const limit = filter.limit ?? 50;
    const out: FacadeRun[] = [];
    for (const run of this.#runs.values()) {
      if (filter.flowId !== undefined && run.flowId !== filter.flowId) continue;
      if (filter.contextId !== undefined && run.contextId !== filter.contextId) continue;
      if (filter.status !== undefined && run.info().status !== filter.status) continue;
      out.push(run);
    }
    // Insertion order is creation order: newest first = reverse.
    return out.reverse().slice(0, Math.max(0, limit));
  }

  /** Runs whose result has not resolved yet. */
  active(): FacadeRun[] {
    return [...this.#runs.values()].filter((r) => r.finished === undefined);
  }

  prune(): void {
    const now = this.clock().getTime();
    const finished = [...this.#runs.values()].filter((r) => r.finishedAtMs !== undefined);
    finished.sort((a, b) => (a.finishedAtMs as number) - (b.finishedAtMs as number));
    let excess = finished.length - this.#maxRuns;
    for (const run of finished) {
      const old = now - (run.finishedAtMs as number) > this.#maxAgeMs;
      if (excess > 0 || old) {
        this.#runs.delete(run.id);
        excess -= 1;
      }
    }
  }
}
