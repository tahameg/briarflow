import { describe, expect, it } from "vitest";
import { SseParser, readSse } from "../../src/sse.js";

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

describe("SseParser", () => {
  it("parses the spec format with id, event and data", () => {
    const p = new SseParser();
    const msgs = p.push('id: 0\nevent: run.started\ndata: {"seq":0}\n\nid: 1\nevent: node.started\ndata: {"seq":1}\n\n');
    expect(msgs).toEqual([
      { event: "run.started", data: '{"seq":0}', id: "0" },
      { event: "node.started", data: '{"seq":1}', id: "1" },
    ]);
    expect(p.lastId).toBe("1");
  });

  it("ignores comments and dispatches nothing for blocks without data", () => {
    const p = new SseParser();
    expect(p.push(": ping\n\nevent: x\n\n")).toEqual([]);
  });

  it("joins multi-line data, defaults the event type and strips only one leading space", () => {
    const p = new SseParser();
    expect(p.push("data:a\ndata:  b\ndata\n\n")).toEqual([{ event: "message", data: "a\n b\n", id: undefined }]);
  });

  it("handles CRLF and CR line endings, also split across chunks", () => {
    const p = new SseParser();
    const out = [...p.push("id: 7\r"), ...p.push("\ndata: x\r\n\r"), ...p.push("\ndata: y\r\r")];
    expect(out).toEqual([
      { event: "message", data: "x", id: "7" },
      { event: "message", data: "y", id: "7" },
    ]);
  });

  it("handles a message split at arbitrary points", () => {
    const text = 'id: 3\nevent: node.progress\ndata: {"fraction":0.5}\n\n';
    for (let cut = 1; cut < text.length; cut++) {
      const p = new SseParser();
      const msgs = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
      expect(msgs).toEqual([{ event: "node.progress", data: '{"fraction":0.5}', id: "3" }]);
    }
  });

  it("reads retry, ignores ids with NUL and unknown fields", () => {
    const p = new SseParser();
    expect(p.push("id: 1\n\nid: a\0b\nretry: 3000\nfoo: bar\ndata: z\n\n")).toEqual([{ event: "message", data: "z", id: "1", retry: 3000 }]);
  });

  it("discards an incomplete trailing message on end", () => {
    const p = new SseParser();
    expect(p.push("data: partial\n")).toEqual([]);
    p.end();
    expect(p.push("\n")).toEqual([]);
  });
});

describe("readSse", () => {
  it("decodes UTF-8 split across byte chunks", async () => {
    const bytes = new TextEncoder().encode("data: héllo ✓\n\n");
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const msgs = [];
    for await (const m of readSse(streamOf(chunks))) msgs.push(m);
    expect(msgs).toEqual([{ event: "message", data: "héllo ✓", id: undefined }]);
  });

  it("cancels the stream when the consumer stops early", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode("data: x\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const m of readSse(stream)) {
      expect(m.data).toBe("x");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
