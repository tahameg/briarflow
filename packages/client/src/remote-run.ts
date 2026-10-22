import type { Run, RunCompletedEvent, RunEvent, RunEventsOptions, RunResult, RunStatus, SerializedError } from "@briarflow/core";
import { serializeError } from "@briarflow/core";
import { BriarClientError, InvalidResponseError, NetworkError } from "./errors.js";
import { isAbort, seg } from "./http.js";
import type { Http } from "./http.js";
import { readSse } from "./sse.js";
import type { CancelRunResult, ReconnectOptions, RunInfo } from "./types.js";

const TERMINAL = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

/** Resolved reconnect settings. */
export type ReconnectSettings = Required<ReconnectOptions>;

/** Default reconnect settings. */
export const DEFAULT_RECONNECT: ReconnectSettings = { initialDelayMs: 500, maxDelayMs: 10_000, maxAttempts: 8 };

/** Internal construction data of a {@link RemoteRun}. */
export interface RemoteRunInit {
  http: Http;
  runId: string;
  status: RunStatus;
  flowId?: string;
  contextId?: string;
  /** Known final result (`wait=true` or a terminal `GET /runs/:id`). */
  result?: RunResult;
  reconnect: ReconnectSettings;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; ISO timestamps for synthesized results. */
  now?: () => string;
}

type FeedState = "idle" | "running" | "done" | "failed";

/**
 * A run executing on a Briarflow server. Implements the runtime's `Run` interface: `status`
 * is tracked from the event stream, `result` never rejects, `events()` replays history then
 * live events and ends after `run.completed`.
 *
 * One SSE connection per run is shared by all `events()` iterables and the status tracker.
 * It is opened right away for a live run (lazily, on the first `events()` call, for a run that
 * is already finished) and resumed with `?after=<last seq>` when it drops.
 *
 * If the stream cannot be recovered (after `reconnect.maxAttempts` consecutive failures, or a
 * 4xx such as `run.not_found`), the client asks `GET /runs/:id` for the result. When that
 * fails too, `result` resolves with `status: "failed"` and `error.code = "client.run_lost"`
 * (`contextRevision: -1` when unknown), and open `events()` iterables throw the stream error.
 *
 * @example
 * ```ts
 * const run = await client.flows.run("flow_p", { topic: "cats" });
 * for await (const e of run.events()) console.log(e.seq, e.type);
 * const result = await run.result;
 * ```
 */
export class RemoteRun implements Run {
  readonly id: string;
  private _status: RunStatus;
  private _flowId: string | undefined;
  private _contextId: string | undefined;
  private startedAt: string | undefined;
  private knownResult: RunResult | undefined;
  readonly result: Promise<RunResult>;
  private resolveResult!: (result: RunResult) => void;

  private readonly http: Http;
  private readonly reconnect: ReconnectSettings;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => string;
  private readonly buffer: RunEvent[] = [];
  private lastSeq = -1;
  private waiters: (() => void)[] = [];
  private feedState: FeedState = "idle";
  private feedError: unknown;

  constructor(init: RemoteRunInit) {
    this.http = init.http;
    this.id = init.runId;
    this._status = init.status;
    this._flowId = init.flowId;
    this._contextId = init.contextId;
    this.reconnect = init.reconnect;
    this.sleep = init.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = init.now ?? (() => new Date().toISOString());
    this.result = new Promise<RunResult>((resolve) => {
      this.resolveResult = resolve;
    });
    if (init.result) this.settle(init.result);
    else this.startFeed();
  }

  /** Current status; updated synchronously as events arrive. */
  get status(): RunStatus {
    return this._status;
  }

  /** Flow id, once known (always known for runs created by `flows.run` or `runs.open`). */
  get flowId(): string | undefined {
    return this._flowId;
  }

  /** Context id, once known (from `run.started`, the result, or `runs.open`). */
  get contextId(): string | undefined {
    return this._contextId;
  }

  /** Fresh iterable: past events (with `seq > after`), then live ones; ends after `run.completed`. */
  events(options: RunEventsOptions = {}): AsyncIterable<RunEvent> {
    const after = options.after ?? -1;
    return {
      [Symbol.asyncIterator]: () => {
        this.startFeed();
        return this.iterate(after);
      },
    };
  }

  /** Requests cancellation (fire and forget). No-op on terminal runs. */
  cancel(reason?: string): void {
    if (TERMINAL.has(this._status)) return;
    this.requestCancel(reason).catch(() => {
      // fire-and-forget by contract; use requestCancel() to observe failures
    });
  }

  /**
   * Like `cancel`, but returns the server's answer (`202 { runId, status }`, or `200` with the
   * terminal status when the run already finished). Throws `BriarClientError` on failure.
   */
  async requestCancel(reason?: string): Promise<CancelRunResult> {
    return this.http.json<CancelRunResult>({
      method: "POST",
      path: `/runs/${seg(this.id)}/cancel`,
      json: reason === undefined ? {} : { reason },
    });
  }

  private async *iterate(after: number): AsyncGenerator<RunEvent> {
    let i = 0;
    for (;;) {
      while (i < this.buffer.length) {
        const ev = this.buffer[i++]!;
        if (ev.seq > after) yield ev;
        if (ev.type === "run.completed") return;
      }
      if (this.feedState === "done") return;
      if (this.feedState === "failed") throw this.feedError;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  private startFeed(): void {
    if (this.feedState !== "idle") return;
    this.feedState = "running";
    void this.runFeed().catch((err: unknown) => this.giveUp(err));
  }

  private settle(result: RunResult): void {
    if (this.knownResult) return;
    this.knownResult = result;
    this._status = result.status;
    this._flowId ??= result.flowId;
    this._contextId ??= result.contextId;
    this.resolveResult(result);
  }

  private accept(ev: RunEvent): void {
    this.buffer.push(ev);
    this.lastSeq = ev.seq;
    if (ev.type === "run.started") {
      this._flowId ??= ev.flowId;
      this._contextId ??= ev.contextId;
      this.startedAt = ev.at;
    }
    if (ev.type === "run.completed") {
      this.settle(ev.result);
      this.feedState = "done";
    } else if (this._status === "queued") {
      this._status = "running";
    }
    this.wake();
  }

  private async runFeed(): Promise<void> {
    const { initialDelayMs, maxDelayMs, maxAttempts } = this.reconnect;
    let attempts = 0;
    let delay = initialDelayMs;
    for (;;) {
      let failure: unknown;
      try {
        const res = await this.http.send({
          method: "GET",
          path: `/runs/${seg(this.id)}/events`,
          ...(this.lastSeq >= 0 ? { query: { after: this.lastSeq } } : {}),
          headers: { accept: "text/event-stream" },
        });
        if (!res.body) throw new InvalidResponseError(`GET /runs/${this.id}/events returned no body.`, { status: res.status });
        for await (const msg of readSse(res.body)) {
          const ev = parseEvent(msg.data, this.id);
          if (ev.seq <= this.lastSeq) continue;
          this.accept(ev);
          attempts = 0;
          delay = initialDelayMs;
          if (ev.type === "run.completed") return;
        }
        failure = new NetworkError(`The event stream of run "${this.id}" closed before run.completed.`);
      } catch (err) {
        if (isFatal(err)) {
          await this.giveUp(err);
          return;
        }
        failure = err;
      }
      attempts++;
      if (attempts > maxAttempts) {
        await this.giveUp(failure);
        return;
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  /** The stream is unrecoverable: fetch the result if possible, else report the run as lost. */
  private async giveUp(err: unknown): Promise<void> {
    let result = this.knownResult;
    if (!result) {
      try {
        const info = await this.http.json<RunInfo>({ method: "GET", path: `/runs/${seg(this.id)}` });
        result = info.result;
      } catch {
        result = undefined;
      }
    }
    if (result) {
      this.settle(result);
      const completed: RunCompletedEvent = { type: "run.completed", runId: this.id, seq: this.lastSeq + 1, at: result.finishedAt, result };
      this.accept(completed);
      return;
    }
    const cause: SerializedError = serializeError(err);
    const now = this.now();
    this.settle({
      runId: this.id,
      flowId: this._flowId ?? "",
      contextId: this._contextId ?? "",
      contextRevision: -1,
      status: "failed",
      error: {
        code: "client.run_lost",
        message: `Lost the event stream of run "${this.id}" and could not fetch its result (${cause.message}). The run may still be running on the server; check GET /runs/${this.id}.`,
        cause,
      },
      startedAt: this.startedAt ?? now,
      finishedAt: now,
    });
    this.feedError = err instanceof BriarClientError ? err : new NetworkError(cause.message, { cause: err });
    this.feedState = "failed";
    this.wake();
  }
}

function isFatal(err: unknown): boolean {
  if (isAbort(err)) return true;
  if (!(err instanceof BriarClientError) || err.status === undefined) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

function parseEvent(data: string, runId: string): RunEvent {
  let ev: unknown;
  try {
    ev = JSON.parse(data);
  } catch (err) {
    throw new InvalidResponseError(`Run "${runId}" sent an event that is not valid JSON.`, { cause: err });
  }
  const e = ev as Partial<RunEvent> | null;
  if (typeof e !== "object" || e === null || typeof e.type !== "string" || typeof e.seq !== "number") {
    throw new InvalidResponseError(`Run "${runId}" sent an event without "type" and "seq".`);
  }
  return e as RunEvent;
}
