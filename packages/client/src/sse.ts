/**
 * Minimal, standalone Server-Sent Events parser (WHATWG "event stream interpretation").
 * Used by `RemoteRun` to read `GET /runs/:runId/events` from a `fetch` body stream, which
 * (unlike `EventSource`) lets the client stop reconnecting after `run.completed`.
 */

/** One dispatched SSE message. */
export interface SseMessage {
  /** `event:` field; `"message"` when absent. */
  event: string;
  /** Concatenated `data:` lines joined with `\n`. */
  data: string;
  /** Last event id seen on the stream so far (persists across messages, per spec). */
  id: string | undefined;
  /** `retry:` value in ms, if this message block set one. */
  retry?: number;
}

/**
 * Incremental SSE parser. Feed decoded text with `push`; complete messages are returned.
 * Handles `\n`, `\r\n` and `\r` line endings, including a `\r\n` split across chunks.
 *
 * @example
 * ```ts
 * const parser = new SseParser();
 * for (const msg of parser.push("id: 1\nevent: node.started\ndata: {}\n\n")) console.log(msg.id);
 * ```
 */
export class SseParser {
  private buffer = "";
  private pendingCr = false;
  private data: string[] = [];
  private hasData = false;
  private eventType = "";
  private retry: number | undefined;
  private lastEventId: string | undefined;

  /** Last event id seen (`id:` field), used for resuming. */
  get lastId(): string | undefined {
    return this.lastEventId;
  }

  /** Feeds a chunk of text; returns the messages completed by it. */
  push(chunk: string): SseMessage[] {
    const out: SseMessage[] = [];
    let text = chunk;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (text.startsWith("\n")) text = text.slice(1);
    }
    this.buffer += text;
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      const line = this.buffer.slice(start, i);
      if (ch === 13) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.pendingCr = true;
        }
      }
      start = i + 1;
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /**
   * Ends the stream. Per spec an incomplete trailing message (no blank line) is discarded.
   */
  end(): void {
    this.buffer = "";
    this.pendingCr = false;
    this.resetMessage();
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.data.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    if (!this.hasData) {
      this.resetMessage();
      return undefined;
    }
    const msg: SseMessage = { event: this.eventType || "message", data: this.data.join("\n"), id: this.lastEventId };
    if (this.retry !== undefined) msg.retry = this.retry;
    this.resetMessage();
    return msg;
  }

  private resetMessage(): void {
    this.data = [];
    this.hasData = false;
    this.eventType = "";
    this.retry = undefined;
  }
}

/**
 * Reads an SSE byte stream (e.g. a `fetch` response body) and yields messages.
 * Releases the reader lock when the consumer stops early.
 *
 * @example
 * ```ts
 * const res = await fetch(url, { headers: { accept: "text/event-stream" } });
 * for await (const msg of readSse(res.body!)) console.log(msg.event, msg.data);
 * ```
 */
export async function* readSse(stream: ReadableStream<Uint8Array>, parser: SseParser = new SseParser()): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let done = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        const tail = decoder.decode();
        if (tail) yield* parser.push(tail);
        parser.end();
        return;
      }
      yield* parser.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    if (!done) {
      try {
        await reader.cancel();
      } catch {
        // stream already errored or closed
      }
    }
    reader.releaseLock();
  }
}
