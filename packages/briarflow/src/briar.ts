/**
 * `createBriar()`: the Layer-1 facade (ARCHITECTURE.md §6.2, docs/tasks/phase-4.md).
 */
import { applyCommands as applyBatch, type Command, type CreatedIds } from "@briarflow/authoring";
import {
  BriarError,
  RevisionConflictError,
  createCatalog,
  createContextDocument,
  createIdGenerator,
  createMedia,
  createMemoryLastRuns,
  createMemoryMediaRegistry,
  createMemorySettings,
  createMemoryVault,
  createTypeScope,
  findFlow,
  flowSignatureSchema,
  noopLogger,
  validateContext,
  validateValue,
  type Clock,
  type ContextDocument,
  type ContextListQuery,
  type ContextStore,
  type ContextSummary,
  type Diagnostic,
  type FlowDocument,
  type FlowSignatureSchema,
  type IdGenerator,
  type LastRun,
  type LastRunStore,
  type Logger,
  type Media,
  type MediaRegistry,
  type MediaStore,
  type NodeCatalog,
  type NodeDescriptor,
  type NodePack,
  type JsonValue,
  type PackSetting,
  type Page,
  type SecretResolver,
  type SecretVault,
  type SettingsStore,
  type TypeDecl,
} from "@briarflow/core";
import { stdPack } from "@briarflow/nodes-std";
import { checkRunRequest, createEngine, type Engine, type EngineOptions, type RunReuse } from "@briarflow/runtime";
import { createContextHandle, type ContextHandle, type FlowHandle, type HandleHost } from "./handles.js";
import { MemoryContextStore } from "./memory-context-store.js";
import { LastRunKeeper } from "./last-runs.js";
import { FacadeRun, RunRegistry, type BriarRun, type RunListFilter, type RunRetention } from "./runs.js";
import { noSecrets } from "./secrets.js";

/** Options of {@link createBriar}. Every field is optional. */
export interface BriarOptions {
  /** Where contexts live. Default: a new `MemoryContextStore`. */
  store?: ContextStore;
  /** The media registry (media.md §2). Default: a registry in memory. */
  media?: MediaRegistry;
  /** Where uploaded files are kept (`stored` media). Default: none (uploads go in the registry). */
  blobs?: MediaStore;
  /** Media bytes kept in memory across runs. Default 256 MB. */
  mediaMemoryBytes?: number;
  /** The last run of each flow (media.md §5). Default: in memory. */
  lastRuns?: LastRunStore;
  /** Secrets for nodes. Default: none (every lookup is `undefined`). */
  secrets?: SecretResolver;
  /** The secret vault (`ctx.secrets.read`, `briar.vault`). Default: a vault in memory. */
  vault?: SecretVault;
  /** Setting values (`ctx.settings.get`, `briar.settings`). Default: settings in memory. */
  settings?: SettingsStore;
  /** Node packs. The standard pack is added unless `std: false` or a pack named `"briar"` is given. */
  packs?: readonly NodePack[];
  /** Add `stdPack` from `@briarflow/nodes-std`. Default `true`. */
  std?: boolean;
  /** Default: no-op. */
  logger?: Logger;
  /** Engine tuning (concurrency, cache, retries' jitter, fetch, …). */
  engine?: Omit<EngineOptions, "catalog" | "media" | "secrets" | "vault" | "settings" | "logger" | "clock" | "idGenerator">;
  /** Time source for documents, runs and the run registry. Default `() => new Date()`. */
  clock?: Clock;
  /** Ids of contexts, created entities and runs. Default `createIdGenerator()`. */
  idGenerator?: IdGenerator;
  /** Finished runs kept by `briar.runs`. Default `{ maxRuns: 200, maxAgeMs: 3_600_000 }`. */
  runRetention?: RunRetention;
  /** Save attempts when applying global writes hits revision conflicts. Default 5. */
  globalWriteAttempts?: number;
}

/** Body of `POST /contexts/:id/commands`. */
export interface ApplyCommandsRequest {
  baseRevision: number;
  commands: readonly Command[];
}

/** Result of {@link Briar.applyCommands}. */
export interface ApplyCommandsResult {
  revision: number;
  changed: boolean;
  /** One entry per command. */
  created: CreatedIds[];
  diagnostics: Diagnostic[];
  /** The resulting document (not part of the REST body). */
  doc: ContextDocument;
}

/** What `GET /flows/:flowId` returns. */
export interface FlowInfo {
  contextId: string;
  revision: number;
  flow: FlowDocument;
  signature: FlowSignatureSchema;
}

/** What `GET /node-types` returns. */
export interface NodeTypesInfo {
  packs: { name: string; version: string; title: string; description: string; settings: PackSetting[] }[];
  nodes: NodeDescriptor[];
  /** Pack types (ids `<pack>.<Name>`). */
  types: TypeDecl[];
}

/** One declared setting with its pack, as the settings screen lists it. */
export interface SettingInfo extends PackSetting {
  pack: string;
  packTitle: string;
}

/** What `GET /settings` returns: every declared setting and the stored values, by key. */
export interface SettingsInfo {
  settings: SettingInfo[];
  values: Record<string, JsonValue>;
}

/** Options of {@link Briar.run}. */
export interface BriarRunOptions {
  /** Default `true`. `false` neither reads nor writes the cache and carries nothing over. */
  useCache?: boolean;
  /** Run every node again, even nodes whose result could be carried over or cached. */
  force?: boolean;
  /** Aborting it cancels the run. */
  signal?: AbortSignal;
  /** Whole-run timeout. */
  timeoutMs?: number;
  runId?: string;
  /**
   * Throw `run.invalid_flow` / `run.invalid_inputs` (with `details.diagnostics`) instead of
   * returning a failed run. The REST API uses this to answer 422 before creating a run.
   */
  throwOnInvalid?: boolean;
  /** Run this document instead of the stored one (`FlowHandle.run` passes its current document). */
  context?: ContextDocument;
}

/**
 * The Briarflow API: contexts, authoring, node types and runs.
 *
 * @example
 * ```ts
 * const briar = createBriar({ packs: [mockPack] });
 * const ctx = await briar.contexts.create({ name: "Demo" });
 * const run = await briar.run(flowId, { topic: "cats" });
 * const result = await run.result;
 * ```
 */
export interface Briar {
  readonly store: ContextStore;
  /** Media registry and loader. */
  readonly media: Media;
  readonly catalog: NodeCatalog;
  readonly engine: Engine;
  readonly contexts: {
    /** Creates and saves an empty context (revision 0). Existing id → `context.exists`. */
    create(input: { name: string; description?: string; id?: string }): Promise<ContextHandle>;
    list(query?: ContextListQuery): Promise<Page<ContextSummary>>;
    /** Walks every page of `list`. */
    iterate(query?: { search?: string; pageSize?: number }): AsyncIterable<ContextSummary>;
    /** Throws `context.not_found`. */
    get(contextId: string): Promise<ContextHandle>;
    find(contextId: string): Promise<ContextHandle | undefined>;
    delete(contextId: string): Promise<boolean>;
  };
  readonly flows: {
    /** Loads the flow's context and returns the flow. Throws `flow.not_found`. */
    get(flowId: string): Promise<FlowHandle>;
    /** Id of the context that holds the flow. */
    locate(flowId: string): Promise<string | undefined>;
    /** Flow document plus its signature as JSON Schema. Throws `flow.not_found`. */
    info(flowId: string): Promise<FlowInfo>;
  };
  /** Node descriptors and pack types of the loaded packs. */
  nodeTypes(): NodeTypesInfo;
  /** Validation findings of a stored context. Throws `context.not_found`. */
  diagnostics(contextId: string): Promise<{ revision: number; diagnostics: Diagnostic[] }>;
  /**
   * Load → check `baseRevision` → apply commands atomically → save with `expectedRevision`.
   * Throws `context.not_found`, `RevisionConflictError`, the `CommandError` of a rejected
   * command, or `FlowIdConflictError`.
   */
  applyCommands(contextId: string, request: ApplyCommandsRequest): Promise<ApplyCommandsResult>;
  /** Starts a run of a stored flow. Throws `flow.not_found`. */
  run(flowId: string, inputs?: Record<string, unknown>, options?: BriarRunOptions): Promise<BriarRun>;
  readonly runs: {
    get(runId: string): BriarRun | undefined;
    /** Newest first. */
    list(filter?: RunListFilter): BriarRun[];
    /** The last run of a flow (kept until the next run of the flow). Throws `flow.not_found`. */
    last(flowId: string): Promise<LastRun | undefined>;
  };
  /** The secret vault. Values go in and never come out (except to nodes, through the engine). */
  readonly vault: SecretVault;
  /** Declared settings and their values. */
  readonly settings: {
    info(): Promise<SettingsInfo>;
    /**
     * Sets a declared setting; `null` / `undefined` clears it (the default applies). Throws
     * `settings.unknown` for an undeclared key and `settings.invalid` for a value that does
     * not fit its type.
     */
    set(key: string, value: unknown): Promise<void>;
  };
  /** Cancels running runs, waits for them, closes packs and stores that have `close()`. */
  close(): Promise<void>;
}

/** Packs that hold resources (e.g. Python packs). */
interface ClosablePack extends NodePack {
  close(): Promise<void> | void;
}

function isClosable(value: unknown): value is { close(): Promise<void> | void } {
  return typeof value === "object" && value !== null && typeof (value as { close?: unknown }).close === "function";
}

function contextNotFound(contextId: string): BriarError {
  return new BriarError("context.not_found", `Context "${contextId}" does not exist. Check the id, or list contexts with briar.contexts.list().`, {
    details: { contextId },
  });
}

function flowNotFound(flowId: string): BriarError {
  return new BriarError("flow.not_found", `Flow "${flowId}" does not exist in any context. Check the flow id.`, {
    details: { flowId },
  });
}

function invalidBody(problems: { path: string; problem: string }[]): BriarError {
  return new BriarError("request.invalid_body", `Invalid commands request: ${problems.map((p) => `${p.path} ${p.problem}`).join("; ")}.`, {
    details: problems,
  });
}

/**
 * Creates the facade. With no options everything lives in memory and only the standard
 * nodes are loaded.
 *
 * @example
 * ```ts
 * import { createBriar, envSecrets } from "briarflow";
 * import { FsMediaStore } from "@briarflow/storage-fs";
 * import { SqliteContextStore, SqliteLastRunStore, SqliteMediaRegistry } from "@briarflow/storage-sqlite";
 * import { mockPack } from "@briarflow/nodes-mock";
 *
 * const briar = createBriar({
 *   store: new SqliteContextStore({ file: "./data/briar.db" }),
 *   media: new SqliteMediaRegistry({ file: "./data/briar.db" }),
 *   blobs: new FsMediaStore({ dir: "./data/media" }),
 *   lastRuns: new SqliteLastRunStore({ file: "./data/briar.db" }),
 *   secrets: envSecrets(),
 *   packs: [mockPack],
 * });
 * ```
 */
export function createBriar(options: BriarOptions = {}): Briar {
  const store = options.store ?? new MemoryContextStore();
  const engineFetch = options.engine?.fetch;
  const media = createMedia({
    registry: options.media ?? createMemoryMediaRegistry({ ...(options.clock ? { clock: options.clock } : {}) }),
    ...(options.blobs ? { blobs: options.blobs } : {}),
    ...(engineFetch ? { fetch: engineFetch } : {}),
    ...(options.mediaMemoryBytes === undefined ? {} : { memoryBytes: options.mediaMemoryBytes }),
  });
  const secrets = options.secrets ?? noSecrets;
  const vault = options.vault ?? createMemoryVault({ clock: options.clock ?? (() => new Date()) });
  const settingsStore = options.settings ?? createMemorySettings();
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? (() => new Date());
  const idGenerator = options.idGenerator ?? createIdGenerator();
  const userPacks = [...(options.packs ?? [])];
  const packs = options.std !== false && !userPacks.some((p) => p.name === stdPack.name) ? [stdPack, ...userPacks] : userPacks;
  const catalog = createCatalog(packs);
  const engine = createEngine({ ...(options.engine ?? {}), catalog, media, secrets, vault, settings: settingsStore, logger, clock, idGenerator });
  const declaredSettings = (): SettingInfo[] => catalog.packs.flatMap((p) => p.settings.map((s) => ({ ...s, pack: p.name, packTitle: p.title })));
  const registry = new RunRegistry(options.runRetention ?? {}, clock);
  const lastRuns = new LastRunKeeper(options.lastRuns ?? createMemoryLastRuns(), media, logger, clock);
  const attempts = options.globalWriteAttempts ?? 5;
  let closed = false;
  let closing: Promise<void> | undefined;

  const ensureOpen = (): void => {
    if (closed) throw new BriarError("briar.closed", "This Briarflow instance was closed. Create a new one with createBriar().");
  };

  const loadOrThrow = async (contextId: string): Promise<ContextDocument> => {
    const doc = await store.load(contextId);
    if (!doc) throw contextNotFound(contextId);
    return doc;
  };

  const run = async (flowId: string, inputs: Record<string, unknown> | undefined, runOptions: BriarRunOptions = {}): Promise<BriarRun> => {
    ensureOpen();
    let doc = runOptions.context;
    if (!doc) {
      const contextId = await store.locateFlow(flowId);
      if (contextId === undefined) throw flowNotFound(flowId);
      doc = await store.load(contextId);
      if (!doc || !findFlow(doc, flowId)) throw flowNotFound(flowId);
    } else if (!findFlow(doc, flowId)) {
      throw new BriarError("flow.not_found", `Flow "${flowId}" does not exist in context "${doc.name}". Check the flow id.`, {
        details: { flowId },
      });
    }
    if (runOptions.runId !== undefined && registry.get(runOptions.runId)) {
      throw new BriarError("run.invalid_call", `Run id "${runOptions.runId}" is already in use. Omit runId or pass a new one.`, {
        details: { runId: runOptions.runId },
      });
    }
    if (runOptions.throwOnInvalid) {
      const check = checkRunRequest(doc, flowId, catalog, inputs ?? {});
      if (!check.ok) throw new BriarError(check.error.code, check.error.message, { details: check.error.details });
    }
    const runId = runOptions.runId ?? idGenerator("run");
    let reuse: RunReuse | undefined;
    try {
      reuse = await lastRuns.begin({ runId, contextId: doc.id, flowId, revision: doc.revision, inputs: inputs ?? {} });
    } catch (err) {
      logger.warn("Recording the run as the flow's last run failed; nothing is carried over.", { runId, error: err instanceof Error ? err.message : String(err) });
    }
    const engineRun = engine.run({
      context: doc,
      flowId,
      inputs: inputs ?? {},
      runId,
      ...(reuse ? { reuse } : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      ...(runOptions.useCache !== undefined ? { useCache: runOptions.useCache } : {}),
      ...(runOptions.force ? { force: true } : {}),
      ...(runOptions.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
    });
    const globalIds = new Map(doc.globals.map((g) => [g.name, g.id] as const));
    // The run's result resolves once the flow's last run is saved, so the next run can carry it over.
    const recorded = reuse ? engineRun.result.then((result) => lastRuns.finish(runId, result, engineRun.events())) : Promise.resolve();
    const facadeRun = new FacadeRun(engineRun, flowId, doc.id, globalIds, { store, catalog, logger, clock, idGenerator, attempts }, recorded);
    registry.add(facadeRun);
    return facadeRun;
  };

  const host: HandleHost = {
    editorOptions: () => ({ catalog, idGenerator, clock }),
    load: (contextId) => store.load(contextId),
    save: (doc, expectedRevision) => {
      ensureOpen();
      return store.save(doc, { expectedRevision });
    },
    run,
  };

  const contexts: Briar["contexts"] = {
    async create(input) {
      ensureOpen();
      const createOptions: Parameters<typeof createContextDocument>[0] = { name: input?.name, idGenerator, clock };
      if (input?.id !== undefined) createOptions.id = input.id;
      if (input?.description !== undefined) createOptions.description = input.description;
      const doc = createContextDocument(createOptions);
      if (await store.load(doc.id)) {
        throw new BriarError("context.exists", `A context with id "${doc.id}" already exists. Pick another id or omit it.`, {
          details: { contextId: doc.id },
        });
      }
      await store.save(doc, { expectedRevision: 0 });
      return createContextHandle(host, doc);
    },
    async list(query) {
      ensureOpen();
      return store.list(query);
    },
    async *iterate(query = {}) {
      ensureOpen();
      let cursor: string | undefined;
      do {
        const q: ContextListQuery = { limit: query.pageSize ?? 50 };
        if (query.search !== undefined) q.search = query.search;
        if (cursor !== undefined) q.cursor = cursor;
        const page = await store.list(q);
        yield* page.items;
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    },
    async get(contextId) {
      ensureOpen();
      return createContextHandle(host, await loadOrThrow(contextId));
    },
    async find(contextId) {
      ensureOpen();
      const doc = await store.load(contextId);
      return doc ? createContextHandle(host, doc) : undefined;
    },
    async delete(contextId) {
      ensureOpen();
      return store.delete(contextId);
    },
  };

  const locateFlow = async (flowId: string): Promise<{ doc: ContextDocument; flow: FlowDocument }> => {
    const contextId = await store.locateFlow(flowId);
    const doc = contextId === undefined ? undefined : await store.load(contextId);
    const flow = doc ? findFlow(doc, flowId) : undefined;
    if (!doc || !flow) throw flowNotFound(flowId);
    return { doc, flow };
  };

  const flows: Briar["flows"] = {
    async get(flowId) {
      ensureOpen();
      const { doc } = await locateFlow(flowId);
      return createContextHandle(host, doc).flows.get(flowId);
    },
    async locate(flowId) {
      ensureOpen();
      return store.locateFlow(flowId);
    },
    async info(flowId) {
      ensureOpen();
      const { doc, flow } = await locateFlow(flowId);
      return { contextId: doc.id, revision: doc.revision, flow, signature: flowSignatureSchema(doc, flowId, catalog) };
    },
  };

  return {
    store,
    media,
    catalog,
    engine,
    contexts,
    flows,
    nodeTypes() {
      return {
        packs: catalog.packs.map((p) => ({ name: p.name, version: p.version, title: p.title, description: p.description, settings: p.settings.map((s) => ({ ...s })) })),
        nodes: catalog.descriptors(),
        types: [...catalog.types],
      };
    },
    async diagnostics(contextId) {
      ensureOpen();
      const doc = await loadOrThrow(contextId);
      return { revision: doc.revision, diagnostics: validateContext(doc, catalog) };
    },
    async applyCommands(contextId, request) {
      ensureOpen();
      const problems: { path: string; problem: string }[] = [];
      if (typeof request !== "object" || request === null) {
        problems.push({ path: "", problem: "must be an object { baseRevision, commands }" });
      } else {
        if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
          problems.push({ path: "baseRevision", problem: "must be a whole number >= 0 (the revision your commands are based on)" });
        }
        if (!Array.isArray(request.commands)) problems.push({ path: "commands", problem: "must be an array of commands" });
      }
      if (problems.length > 0) throw invalidBody(problems);
      const doc = await loadOrThrow(contextId);
      if (doc.revision !== request.baseRevision) {
        throw new RevisionConflictError({ id: doc.id, name: doc.name, expected: request.baseRevision, actual: doc.revision });
      }
      const result = applyBatch(doc, request.commands, { catalog, idGenerator, clock });
      if (!result.ok) throw result.error;
      if (result.changed) await store.save(result.doc, { expectedRevision: request.baseRevision });
      return {
        revision: result.doc.revision,
        changed: result.changed,
        created: result.created,
        diagnostics: result.diagnostics,
        doc: result.doc,
      };
    },
    run,
    runs: {
      get: (runId) => registry.get(runId),
      list: (filter) => registry.list(filter),
      async last(flowId) {
        ensureOpen();
        const contextId = await store.locateFlow(flowId);
        if (contextId === undefined) throw flowNotFound(flowId);
        return lastRuns.store.get(contextId, flowId);
      },
    },
    vault,
    settings: {
      async info() {
        const settings = declaredSettings();
        const all = await settingsStore.all();
        const values: Record<string, JsonValue> = {};
        for (const s of settings) if (all[s.key] !== undefined) values[s.key] = all[s.key] as JsonValue;
        return { settings, values };
      },
      async set(key, value) {
        ensureOpen();
        const decl = declaredSettings().find((s) => s.key === key);
        if (!decl) {
          throw new BriarError("settings.unknown", `There is no setting "${key}". Settings come from the loaded packs.`, { details: { key } });
        }
        if (value === null || value === undefined) return settingsStore.set(key, undefined);
        const problems = validateValue(value, decl.type, createTypeScope({}), { path: key });
        if (problems.length > 0) {
          throw new BriarError("settings.invalid", `Setting ${decl.title}: ${problems[0]!.message}`, { details: { key, diagnostics: problems } });
        }
        await settingsStore.set(key, value as JsonValue);
      },
    },
    close() {
      closing ??= (async () => {
        closed = true;
        const active = registry.active();
        for (const r of active) r.cancel("Briarflow is shutting down.");
        await Promise.all(active.map((r) => r.result));
        await lastRuns.settle();
        const errors: unknown[] = [];
        const tryClose = async (target: unknown): Promise<void> => {
          if (!isClosable(target)) return;
          try {
            await target.close();
          } catch (err) {
            errors.push(err);
          }
        };
        for (const pack of userPacks as readonly (NodePack | ClosablePack)[]) await tryClose(pack);
        await tryClose(media);
        await tryClose(lastRuns.store);
        await tryClose(store);
        await tryClose(vault);
        await tryClose(settingsStore);
        for (const err of errors) logger.error("briar.close_failed", { error: err instanceof Error ? err.message : String(err) });
      })();
      return closing;
    },
  };
}

