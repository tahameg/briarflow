/**
 * Compile-only checks (phase-1.md §5.3, §5.11): extra inference cases and the shared run
 * types. Checked by `npm run typecheck`; not executed by Vitest.
 */
import { expectTypeOf } from "vitest";
import {
  cfg,
  defineEnum,
  defineNode,
  defineStruct,
  t,
  type ConfigOf,
  type ContextStore,
  type MediaStore,
  type NodeCompletedEvent,
  type NodeFailedEvent,
  type NodeProgressEvent,
  type NodeRetryingEvent,
  type NodeSkippedEvent,
  type NodeStartedEvent,
  type Run,
  type RunCompletedEvent,
  type RunEvent,
  type RunEventType,
  type RunResult,
  type RunStartedEvent,
  type RunStatus,
  type SecretResolver,
  type TerminalRunStatus,
  type ValueOf,
} from "@briarflow/core";

export function moreInferenceChecks(): void {
  // Struct with defaults and nested enums/lists.
  const Tone = defineEnum("Tone", ["calm", "excited"]);
  const Stats = defineStruct("Stats", {
    words: t.int({ min: 0 }),
    tones: t.list(t.ref(Tone)),
    note: { type: t.optional(t.text()), default: null },
  });
  expectTypeOf<ValueOf<typeof Stats>>().toEqualTypeOf<{ words: number; tones: readonly ("calm" | "excited")[]; note: string | null }>();

  // Config: optional and defaulted fields.
  const node = defineNode({
    type: "demo.cfg",
    config: {
      count: cfg.int({ min: 0, default: 1 }),
      maybe: cfg.int({ optional: true }),
      flag: cfg.boolean(),
      variableId: cfg.flowVariable(),
      globalId: cfg.global({ writable: true }),
    },
    run({ config }) {
      expectTypeOf(config.count).toEqualTypeOf<number>();
      expectTypeOf(config.maybe).toEqualTypeOf<number | undefined>();
      expectTypeOf(config.flag).toEqualTypeOf<boolean>();
      expectTypeOf(config.variableId).toEqualTypeOf<string>();
      return {};
    },
  });
  expectTypeOf<ConfigOf<typeof node>["globalId"]>().toEqualTypeOf<string>();
}

export function runTypeChecks(): void {
  const base = { runId: "run_1", seq: 0, at: "2026-01-01T00:00:00.000Z" };
  const result: RunResult = {
    runId: "run_1",
    flowId: "flow_p",
    contextId: "ctx_1",
    contextRevision: 3,
    status: "succeeded",
    outputs: { prompt: "x" },
    startedAt: base.at,
    finishedAt: base.at,
  };
  const failed: RunResult = { ...result, status: "failed", error: { code: "run.node_failed", message: "m", nodeId: "n_1", cause: { code: "node.failed", message: "x" } } };
  void failed;

  const events: RunEvent[] = [
    { ...base, type: "run.started", flowId: "flow_p", contextId: "ctx_1" } satisfies RunStartedEvent,
    { ...base, type: "node.started", nodeId: "n_1", attempt: 1 } satisfies NodeStartedEvent,
    { ...base, type: "node.progress", nodeId: "n_1", fraction: 0.5, message: "half" } satisfies NodeProgressEvent,
    {
      ...base,
      type: "node.retrying",
      nodeId: "n_1",
      attempt: 1,
      nextAttempt: 2,
      delayMs: 500,
      error: { code: "node.rate_limited", message: "m", retryable: true },
    } satisfies NodeRetryingEvent,
    { ...base, type: "node.completed", nodeId: "n_1", outputs: { text: "x" }, cached: false, durationMs: 3 } satisfies NodeCompletedEvent,
    { ...base, type: "node.failed", nodeId: "n_1", error: { code: "node.failed", message: "m" } } satisfies NodeFailedEvent,
    { ...base, type: "node.skipped", nodeId: "n_2", reason: "upstream_failed", cause: "n_1" } satisfies NodeSkippedEvent,
    { ...base, type: "run.completed", result } satisfies RunCompletedEvent,
  ];

  for (const event of events) {
    switch (event.type) {
      case "node.progress":
        expectTypeOf(event.fraction).toEqualTypeOf<number>();
        break;
      case "run.completed":
        expectTypeOf(event.result).toEqualTypeOf<RunResult>();
        break;
      case "node.skipped":
        expectTypeOf(event.reason).toEqualTypeOf<"upstream_failed" | "cancelled">();
        break;
      default:
        expectTypeOf(event.runId).toEqualTypeOf<string>();
    }
  }

  expectTypeOf<RunEventType>().toEqualTypeOf<
    "run.started" | "node.started" | "node.progress" | "node.retrying" | "node.completed" | "node.failed" | "node.skipped" | "run.completed"
  >();
  expectTypeOf<TerminalRunStatus>().toMatchTypeOf<RunStatus>();

  // @ts-expect-error unknown event type
  const bad: RunEvent = { ...base, type: "node.unknown", nodeId: "n_1" };
  void bad;

  const run = {} as Run;
  expectTypeOf(run.result).toEqualTypeOf<Promise<RunResult>>();
  expectTypeOf(run.events({ after: 3 })).toEqualTypeOf<AsyncIterable<RunEvent>>();

  // Extension interfaces are implementable with plain objects.
  const secrets: SecretResolver = { get: async () => undefined };
  void secrets;
  expectTypeOf<ContextStore["kind"]>().toEqualTypeOf<string>();
  expectTypeOf<ReturnType<MediaStore["delete"]>>().toEqualTypeOf<Promise<boolean>>();
}
