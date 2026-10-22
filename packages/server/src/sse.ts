/**
 * Server-sent events for `GET /runs/:runId/events` (rest-api.md §4, phase-5.md §4.4).
 * Web streams only, so it runs on every runtime.
 */
import { serializeError, type Logger, type RunEvent } from "@briarflow/core";

export interface EventStreamOptions {
  pingIntervalMs: number;
  /** The request's signal: aborting it (client gone) stops the stream. */
  signal?: AbortSignal | undefined;
  logger: Logger;
  runId: string;
}

const encoder = new TextEncoder();

/** One SSE frame for an event: `id`, `event`, one-line JSON `data`. */
export function formatEvent(event: RunEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * A `text/event-stream` body over a run's events. Ends after `run.completed` (or when the
 * iterable ends). A client disconnect stops the iterator and the ping timer; it never cancels
 * the run.
 */
export function eventStream(events: AsyncIterable<RunEvent>, options: EventStreamOptions): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  let stopped = false;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeStop: (() => void) | undefined;
  const stopSignal = new Promise<"stop">((resolve) => {
    wakeStop = () => resolve("stop");
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    options.signal?.removeEventListener("abort", stop);
    wakeStop?.();
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.signal?.aborted) {
        stop();
        controller.close();
        return;
      }
      options.signal?.addEventListener("abort", stop, { once: true });

      const write = (text: string): void => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const schedulePing = (): void => {
        if (pingTimer !== undefined) clearTimeout(pingTimer);
        if (stopped || options.pingIntervalMs <= 0) return;
        pingTimer = setTimeout(() => {
          write(": ping\n\n");
          schedulePing();
        }, options.pingIntervalMs);
      };
      const finish = (): void => {
        stop();
        try {
          controller.close();
        } catch {
          // already cancelled by the consumer
        }
      };

      void (async () => {
        schedulePing();
        try {
          for (;;) {
            const next = await Promise.race([iterator.next(), stopSignal]);
            if (next === "stop" || next.done) break;
            write(formatEvent(next.value));
            schedulePing();
            if (next.value.type === "run.completed") break;
          }
        } catch (err) {
          options.logger.warn("http.event_stream_failed", { runId: options.runId, error: serializeError(err) });
        }
        finish();
      })();
    },
    cancel() {
      stop();
    },
  });
}
