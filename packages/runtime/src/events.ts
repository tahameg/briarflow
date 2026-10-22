/**
 * Per-run event history with replay (docs/specs/runtime.md §7).
 */
import type { RunEvent } from "@briarflow/core";

/** Append-only event log. Readers replay history, then follow live events until `run.completed`. */
export class EventLog {
  private readonly history: RunEvent[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  get length(): number {
    return this.history.length;
  }

  push(event: RunEvent): void {
    if (this.closed) return;
    this.history.push(event);
    if (event.type === "run.completed") this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** A fresh iterable over events with `seq > after`. */
  iterate(after?: number): AsyncIterable<RunEvent> {
    const start = after === undefined || !Number.isFinite(after) ? 0 : Math.max(0, Math.floor(after) + 1);
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RunEvent> => {
        let index = start;
        let done = false;
        const finished = (): IteratorResult<RunEvent> => ({ done: true, value: undefined });
        return {
          next: async () => {
            for (;;) {
              if (done) return finished();
              const event = this.history[index];
              if (event !== undefined) {
                index += 1;
                return { done: false, value: event };
              }
              if (this.closed) {
                done = true;
                return finished();
              }
              await new Promise<void>((resolve) => this.waiters.push(resolve));
            }
          },
          return: async () => {
            done = true;
            return finished();
          },
        };
      },
    };
  }
}
