/**
 * The execution engine (docs/specs/runtime.md §1).
 */
import {
  BriarError,
  createIdGenerator,
  noopLogger,
  type ContextDocument,
  type Logger,
  type MediaStore,
  type NodeCatalog,
  type Run,
  type SecretResolver,
} from "@briarflow/core";
import { createMemoryCache, type RunCache } from "./cache.js";
import { LocalRun, type RunServices } from "./run.js";
import { Scheduler } from "./scheduler.js";

/** Options of {@link createEngine}. */
export interface EngineOptions {
  catalog: NodeCatalog;
  media: MediaStore;
  secrets: SecretResolver;
  /** Default: no-op. */
  logger?: Logger;
  /** Default: `createMemoryCache({ maxEntries: 500 })`, shared by all runs of the engine. */
  cache?: RunCache;
  /** Nodes running at once across all runs. Default 8. */
  concurrency?: number;
  /** Runs in `running` state at once; more wait in `queued`. Default 16. */
  maxConcurrentRuns?: number;
  /** Default `() => new Date()`. */
  clock?: () => Date;
  /** Default `createIdGenerator()`. Run ids are `idGenerator("run")`. */
  idGenerator?: (prefix: string) => string;
  /** Retry jitter source. Default `Math.random`. */
  random?: () => number;
  /** Given to nodes as `ctx.fetch`. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** How long cancelled nodes may take to settle. Default 5000 ms. */
  cancelGraceMs?: number;
}

/** Options of {@link Engine.run}. */
export interface RunOptions {
  context: ContextDocument;
  flowId: string;
  /** Flow inputs by name. Default `{}`. */
  inputs?: Record<string, unknown>;
  /** Aborting it cancels the run. */
  signal?: AbortSignal;
  /** Default `true`; `false` neither reads nor writes the cache. */
  useCache?: boolean;
  /** Whole-run timeout, counted from leaving `queued`. Default none. */
  timeoutMs?: number;
  /**
   * Default `idGenerator("run")`. Must be unique: the engine keeps no registry and does not
   * check it (the `briarflow` facade rejects ids already in its run registry).
   */
  runId?: string;
}

/** Runs flows. Create one per process (or per catalog) and share it. */
export interface Engine {
  readonly catalog: NodeCatalog;
  /**
   * Starts a run and returns it immediately (`status` is `queued`). Never throws for user
   * errors: an invalid flow or inputs end in a failed `RunResult`. Throws
   * `BriarError("run.invalid_call")` for missing arguments.
   */
  run(options: RunOptions): Run;
}

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new BriarError("engine.invalid_options", `createEngine: ${name} must be a whole number >= 1 (got ${String(value)}).`, {
      details: { option: name, value },
    });
  }
  return value;
}

/**
 * Creates an execution engine.
 *
 * @example
 * ```ts
 * const engine = createEngine({ catalog: createCatalog([stdPack, mockPack]), media, secrets });
 * const run = engine.run({ context: doc, flowId: "flow_p", inputs: { topic: "cats" } });
 * for await (const event of run.events()) console.log(event.type);
 * const result = await run.result;
 * ```
 */
export function createEngine(options: EngineOptions): Engine {
  if (!options || typeof options !== "object" || !options.catalog || !options.media || !options.secrets) {
    throw new BriarError("engine.invalid_options", "createEngine needs { catalog, media, secrets }.");
  }
  const concurrency = positiveInt("concurrency", options.concurrency, 8);
  const maxConcurrentRuns = positiveInt("maxConcurrentRuns", options.maxConcurrentRuns, 16);
  const cancelGraceMs = options.cancelGraceMs ?? 5000;
  if (typeof cancelGraceMs !== "number" || !Number.isFinite(cancelGraceMs) || cancelGraceMs < 0) {
    throw new BriarError("engine.invalid_options", `createEngine: cancelGraceMs must be a number >= 0 (got ${String(cancelGraceMs)}).`);
  }
  const idGenerator = options.idGenerator ?? createIdGenerator();
  const queue: LocalRun[] = [];
  const active = new Set<LocalRun>();
  let pumping = false;
  let again = false;

  const pumpRuns = (): void => {
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        while (active.size < maxConcurrentRuns && queue.length > 0) {
          const run = queue.shift() as LocalRun;
          active.add(run);
          run.begin();
        }
      } while (again);
    } finally {
      pumping = false;
    }
  };

  const services: RunServices = {
    catalog: options.catalog,
    media: options.media,
    secrets: options.secrets,
    logger: options.logger ?? noopLogger,
    cache: options.cache ?? createMemoryCache({ maxEntries: 500 }),
    clock: options.clock ?? (() => new Date()),
    random: options.random ?? Math.random,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    cancelGraceMs,
    scheduler: new Scheduler(concurrency),
    fetchErrors: new WeakSet(),
    dequeue(run) {
      const i = queue.indexOf(run);
      if (i >= 0) queue.splice(i, 1);
    },
    finished(run) {
      if (active.delete(run)) pumpRuns();
    },
  };

  return {
    catalog: options.catalog,
    run(runOptions: RunOptions): Run {
      if (!runOptions || typeof runOptions !== "object") {
        throw new BriarError("run.invalid_call", "engine.run needs an options object: { context, flowId, inputs? }.");
      }
      const { context, flowId } = runOptions;
      if (!context || typeof context !== "object" || !Array.isArray((context as { flows?: unknown }).flows)) {
        throw new BriarError("run.invalid_call", "engine.run needs a context document in options.context.");
      }
      if (typeof flowId !== "string" || flowId === "") {
        throw new BriarError("run.invalid_call", "engine.run needs the id of the flow to run in options.flowId.");
      }
      if (runOptions.timeoutMs !== undefined && (typeof runOptions.timeoutMs !== "number" || !(runOptions.timeoutMs > 0))) {
        throw new BriarError("run.invalid_call", `engine.run: timeoutMs must be a number > 0 (got ${String(runOptions.timeoutMs)}).`);
      }
      const run = new LocalRun(services, {
        runId: runOptions.runId ?? idGenerator("run"),
        context,
        flowId,
        inputs: runOptions.inputs,
        useCache: runOptions.useCache !== false,
        timeoutMs: runOptions.timeoutMs,
        signal: runOptions.signal,
      });
      queue.push(run);
      run.attachSignal();
      queueMicrotask(pumpRuns);
      return run;
    },
  };
}
