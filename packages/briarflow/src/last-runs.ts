/**
 * Keeps the last run of every flow (docs/specs/media.md §5): the record is replaced when a run
 * is requested, filled when it ends, and media from runs that are no longer the last one is
 * removed. Nodes that make media and get the same inputs again are carried over.
 */
import { serializeError, type LastRun, type LastRunNode, type LastRunStore, type Logger, type Media, type RunEvent, type RunResult } from "@briarflow/core";
import type { RunReuse } from "@briarflow/runtime";

interface Started {
  contextId: string;
  flowId: string;
}

/** Internal: owned by the facade. */
export class LastRunKeeper {
  readonly #running = new Map<string, Started>();
  readonly #keys = new Map<string, Map<string, string>>();
  readonly #pending = new Set<Promise<void>>();
  readonly #ready: Promise<void>;

  constructor(
    readonly store: LastRunStore,
    private readonly media: Media,
    private readonly logger: Logger,
    private readonly clock: () => Date,
  ) {
    this.#ready = this.#sweep().catch((err: unknown) => {
      this.logger.warn("Cleaning up media of earlier runs failed.", { error: serializeError(err) });
    });
  }

  /** Records a new run as the flow's last run and returns what it may carry over. */
  async begin(input: { runId: string; contextId: string; flowId: string; revision: number; inputs: Record<string, unknown> }): Promise<RunReuse> {
    await this.#ready;
    const { runId, contextId, flowId } = input;
    const previous = new Map<string, Record<string, unknown>>();
    const before = await this.store.get(contextId, flowId);
    for (const node of Object.values(before?.nodes ?? {})) {
      if (node.state === "completed" && node.key !== undefined && node.outputs) previous.set(node.key, node.outputs);
    }
    await this.store.set({
      runId,
      contextId,
      flowId,
      revision: input.revision,
      status: "running",
      requestedAt: this.clock().toISOString(),
      inputs: input.inputs,
      nodes: {},
    });
    this.#running.set(runId, { contextId, flowId });
    const keys = new Map<string, string>();
    this.#keys.set(runId, keys);
    const owner = { runId, flowId, contextId };
    return {
      previous,
      onResult: async (r) => {
        keys.set(r.nodeId, r.key);
        if (r.reused && r.media.length > 0) await this.media.adopt(r.media, owner);
      },
    };
  }

  /**
   * Fills the record once the run ends (`events` is its full history), then removes stale
   * media. Never rejects.
   */
  finish(runId: string, result: RunResult, events: AsyncIterable<RunEvent>): Promise<void> {
    const work = this.#finish(runId, result, events)
      .catch((err: unknown) => this.logger.warn("Saving the last run failed.", { runId, error: serializeError(err) }))
      .finally(() => this.#pending.delete(work));
    this.#pending.add(work);
    return work;
  }

  /** Waits for records still being written. */
  async settle(): Promise<void> {
    await this.#ready;
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  async #finish(runId: string, result: RunResult, events: AsyncIterable<RunEvent>): Promise<void> {
    const started = this.#running.get(runId);
    const keys = this.#keys.get(runId) ?? new Map<string, string>();
    try {
      if (!started) return;
      const { contextId, flowId } = started;
      const nodes: Record<string, LastRunNode> = {};
      for await (const e of events) {
        if (e.type === "node.completed") {
          const key = keys.get(e.nodeId);
          nodes[e.nodeId] = { state: "completed", outputs: e.outputs, cached: e.cached, durationMs: e.durationMs, ...(key === undefined ? {} : { key }) };
        } else if (e.type === "node.failed") {
          nodes[e.nodeId] = { state: "failed", error: e.error };
        } else if (e.type === "node.skipped") {
          nodes[e.nodeId] = { state: "skipped", skipReason: e.reason, ...(e.cause === undefined ? {} : { cause: e.cause }) };
        }
      }
      const current = await this.store.get(contextId, flowId);
      this.#running.delete(runId);
      if (current?.runId !== runId) {
        // A newer run of the flow was requested meanwhile: this one is not kept.
        await this.media.deleteOwned({ runId });
        return;
      }
      await this.store.set({ ...current, status: result.status, finishedAt: result.finishedAt, nodes, result });
      for (const owner of await this.media.registry.owners()) {
        if (owner.contextId !== contextId || owner.flowId !== flowId || owner.runId === runId || this.#running.has(owner.runId)) continue;
        await this.media.deleteOwned({ runId: owner.runId });
      }
    } finally {
      this.#running.delete(runId);
      this.#keys.delete(runId);
    }
  }

  /** At start: runs that were running when the server stopped are `interrupted`; media of runs that are no one's last run goes. */
  async #sweep(): Promise<void> {
    const last = new Map<string, LastRun>();
    for (const run of await this.store.list()) {
      if (run.status === "running") {
        const interrupted: LastRun = { ...run, status: "interrupted" };
        await this.store.set(interrupted);
        last.set(run.runId, interrupted);
      } else {
        last.set(run.runId, run);
      }
    }
    let removed = 0;
    for (const owner of await this.media.registry.owners()) {
      if (last.has(owner.runId)) continue;
      removed += (await this.media.deleteOwned({ runId: owner.runId })).length;
    }
    if (removed > 0) this.logger.info("Removed media of earlier runs.", { removed });
  }
}
