/**
 * `runNode`: runs one node definition outside the engine with a fake `ExecContext`
 * (docs/specs/node-api.md §6). Ports are resolved like the engine does (static ports, or
 * `resolvePorts` with validated config), inputs are resolved (given → port default → `null`
 * for optional) and normalized/validated against their port types, outputs are checked after
 * `run`. Progress reports and log lines are captured for assertions.
 */
import {
  ERROR_OUTPUT,
  containsVar,
  createCatalog,
  findFlow,
  NodeError,
  normalizeValue,
  resolveFlowPorts,
  scopeForFlow,
  substituteTypeVars,
  validateNodeConfig,
  CONTEXT_FORMAT,
  CONTEXT_FORMAT_VERSION,
  type AnyNodeDefinition,
  type ContextDocument,
  type ExecContext,
  type FlowDocument,
  type LogData,
  type Logger,
  type MediaStore,
  type NodeCatalog,
  type NodeInstance,
  type NodePack,
  type OutputsOf,
  type ResolvedPort,
  type TypeDecl,
  type TypeRef,
} from "@briarflow/core";
import { memoryMediaStore } from "./fixtures/media.js";

/** One captured `ctx.progress` call (clamped like the engine; no throttling). */
export interface CapturedProgress {
  fraction: number;
  message?: string;
}

/** One captured `ctx.log` line (`data` includes `runId` and `nodeId`). */
export interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data: LogData;
}

/** Options of {@link runNode}. */
export interface RunNodeOptions {
  /** Node config (validated; defaults applied). */
  config?: Record<string, unknown>;
  /**
   * A context that provides types, globals and (with `flowId`) the flow the node is placed in.
   * Default: an empty context.
   */
  context?: ContextDocument;
  /** Flow of `context` the node is placed in. Default: a new empty flow `flow_runnode`. */
  flowId?: string;
  /**
   * Packs whose types are visible (`ctx.resolveType`, port types). When one of them contains
   * a node of the same type, its (qualified) definition is used for the ports.
   */
  packs?: readonly NodePack[];
  /** Generic bindings of the node instance (`node.typeBindings`); bound ports are checked. */
  typeBindings?: Record<string, TypeRef>;
  /** Default: a fresh `memoryMediaStore()`. */
  media?: MediaStore;
  /** Secret values by name. Declared secrets missing here fail with `node.missing_secret`. */
  secrets?: Record<string, string>;
  /** `ctx.globals` by name. Default: the context's global values. */
  globals?: Record<string, unknown>;
  /** `ctx.variables` by name. Default: the flow variables' defaults. */
  variables?: Record<string, unknown>;
  /** `ctx.signal`. Default: a signal that never aborts. */
  signal?: AbortSignal;
  /** Default 1. */
  attempt?: number;
  /** Default `"run_test"`. */
  runId?: string;
  /** Default `"n_test"`. */
  nodeId?: string;
  /** Node title (`node.title`). */
  title?: string;
  /** `ctx.fetch`. Default: a fetch that rejects (tests must not use the network). */
  fetch?: typeof fetch;
  /** Also receives every log line. */
  logger?: Logger;
  /** Normalize and validate inputs before `run` (default `true`). */
  checkInputs?: boolean;
  /** Normalize and validate outputs after `run` (default `true`). */
  checkOutputs?: boolean;
}

/** Result of {@link runNode}. */
export interface RunNodeResult<O = Readonly<Record<string, unknown>>> {
  /** Normalized outputs (every declared port; omitted optional → `null`). */
  outputs: O;
  /** Every `ctx.progress` call, in order. */
  progress: CapturedProgress[];
  /** Every `ctx.log` line, in order. */
  logs: CapturedLog[];
  /** The media store the node used. */
  media: MediaStore;
  /** The inputs passed to `run` (resolved and normalized). */
  inputs: Record<string, unknown>;
  /** Resolved ports of the node. */
  ports: { inputs: readonly ResolvedPort[]; outputs: readonly ResolvedPort[] };
  /** Whether `ctx.globals.get` / `ctx.variables.get` was called (the engine would not cache). */
  usedState: boolean;
}

const RUN_NODE_FLOW_ID = "flow_runnode";

function blankContext(): ContextDocument {
  return {
    format: CONTEXT_FORMAT,
    formatVersion: CONTEXT_FORMAT_VERSION,
    id: "ctx_runnode",
    name: "runNode",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    types: [],
    globals: [],
    flows: [],
  };
}

function blankFlow(): FlowDocument {
  return { id: RUN_NODE_FLOW_ID, name: "runNode", types: [], inputs: [], outputs: [], variables: [], nodes: [], edges: [] };
}

/** A catalog of `packs` in which `def.type` resolves to `def`. */
function catalogWith(def: AnyNodeDefinition, packs: readonly NodePack[]): NodeCatalog {
  const base = createCatalog(packs);
  const owner = base.packOf(def.type);
  const fallbackPack: NodePack = {
    kind: "nodePack",
    name: "runnode",
    version: "0.0.0",
    title: "runNode",
    description: "",
    namespaces: [def.type.split(".")[0] ?? "runnode"],
    types: [],
    nodes: [def],
  };
  return {
    packs: base.packs,
    types: base.types,
    get: (type) => (type === def.type ? def : base.get(type)),
    has: (type) => type === def.type || base.has(type),
    packOf: (type) => (type === def.type ? (owner ?? fallbackPack) : base.packOf(type)),
    getType: (id) => base.getType(id),
    descriptors: () => base.descriptors(),
  };
}

function firstMessage(diagnostics: readonly { message: string }[], fallback: string): string {
  return diagnostics[0]?.message ?? fallback;
}

/**
 * Runs one node with a fake `ExecContext`. Resolves with the normalized outputs plus the
 * captured progress and logs; rejects with what `run` threw, or with
 * `NodeError("node.invalid_input")` / `("node.invalid_output")` /
 * `("node.missing_secret")` / `("config.invalid")` for problems the engine would report.
 *
 * @example
 * ```ts
 * const { outputs } = await runNode(textTemplate, { name: "Aria" }, { config: { template: "Hi {name}" } });
 * expect(outputs.text).toBe("Hi Aria");
 * ```
 */
export async function runNode<D extends { readonly kind: "nodeDefinition"; readonly type: string }>(
  def: D,
  inputs: Readonly<Record<string, unknown>> = {},
  options: RunNodeOptions = {},
): Promise<RunNodeResult<OutputsOf<D>>> {
  const given = def as unknown as AnyNodeDefinition;
  const packs = options.packs ?? [];
  // Prefer the pack's copy (definePack qualifies bare pack-type refs in ports).
  const packed = packs.flatMap((p) => p.nodes).find((n) => n.type === given.type && n.run === given.run);
  const definition = packed ?? given;
  const catalog = catalogWith(definition, packs);
  const nodeId = options.nodeId ?? "n_test";

  // Place the node in a flow of a (copied) context.
  const doc = structuredClone(options.context ?? blankContext()) as ContextDocument & { flows: FlowDocument[] };
  let flowId = options.flowId;
  if (flowId === undefined) {
    flowId = RUN_NODE_FLOW_ID;
    doc.flows = [...doc.flows.filter((f) => f.id !== RUN_NODE_FLOW_ID), blankFlow()];
  }
  const flow = findFlow(doc, flowId) as (FlowDocument & { nodes: NodeInstance[] }) | undefined;
  if (!flow) throw new Error(`runNode: flow "${flowId}" does not exist in the given context.`);
  const instance: NodeInstance = { id: nodeId, type: definition.type, position: { x: 0, y: 0 } };
  if (options.config !== undefined) instance.config = options.config;
  if (options.typeBindings !== undefined) instance.typeBindings = options.typeBindings;
  if (options.title !== undefined) instance.title = options.title;
  flow.nodes = [...flow.nodes.filter((n) => n.id !== nodeId), instance];

  const title = options.title ?? definition.title;
  const configCheck = validateNodeConfig(definition, options.config, doc, flowId, catalog);
  if (!configCheck.ok) {
    throw new NodeError("config.invalid", `Node ${title} has an invalid config: ${firstMessage(configCheck.diagnostics, "invalid config")}`, {
      details: { diagnostics: configCheck.diagnostics },
    });
  }
  const config = configCheck.config;
  const resolved = resolveFlowPorts(doc, flowId, catalog).nodes.get(nodeId);
  if (!resolved) throw new Error("runNode: the node could not be placed in the flow.");
  const portProblem = resolved.diagnostics.find((d) => d.severity === "error" && d.code !== "node.generic_conflict");
  if (portProblem) {
    throw new NodeError(portProblem.code, portProblem.message, { details: { diagnostics: resolved.diagnostics } });
  }
  const scope = scopeForFlow(doc, flowId, catalog);
  const bindings = { ...resolved.typeBindings, ...(options.typeBindings ?? {}) };
  const portType = (p: ResolvedPort): TypeRef => substituteTypeVars(p.declaredType, bindings);
  const at = { flowId, nodeId };

  // Inputs: given → port default → null (optional).
  const checkInputs = options.checkInputs !== false;
  const values: Record<string, unknown> = {};
  for (const port of resolved.inputs) {
    let value = inputs[port.name];
    if (value === undefined) {
      if (port.hasDefault) value = port.default ?? null;
      else if (port.declaredType.kind === "optional") value = null;
      else if (checkInputs) {
        throw new NodeError("node.invalid_input", `Node ${title} has no value for input "${port.name}". Connect an edge or set a constant.`, {
          details: { port: port.name },
        });
      }
    }
    const type = portType(port);
    if (checkInputs && !containsVar(type)) {
      const r = normalizeValue(value, type, scope, { path: `inputs.${port.name}`, at: { ...at, port: port.name } });
      if (!r.ok) {
        throw new NodeError("node.invalid_input", `Node ${title} got an invalid input: ${firstMessage(r.diagnostics, port.name)}.`, {
          details: { diagnostics: r.diagnostics },
        });
      }
      value = r.value;
    }
    values[port.name] = value === undefined ? null : value;
  }
  if (!checkInputs) {
    for (const [k, v] of Object.entries(inputs)) if (!(k in values)) values[k] = v;
  }

  // Secrets: resolved before the attempt like the engine does.
  const secretValues = new Map<string, string>();
  for (const name of definition.secrets) {
    const value = options.secrets?.[name];
    if (typeof value !== "string") {
      throw new NodeError("node.missing_secret", `Node ${title} needs secret "${name}". Set it in your secrets provider (e.g. env var ${name}).`, {
        details: { secret: name },
      });
    }
    secretValues.set(name, value);
  }

  // Globals and variables (run-start values).
  const globals = new Map<string, unknown>();
  if (options.globals) for (const [k, v] of Object.entries(options.globals)) globals.set(k, v);
  else for (const g of doc.globals) globals.set(g.name, g.value);
  const variables = new Map<string, unknown>();
  if (options.variables) for (const [k, v] of Object.entries(options.variables)) variables.set(k, v);
  else {
    for (const v of flow.variables) {
      const start = v.default !== undefined ? v.default : v.type.kind === "optional" ? null : v.type.kind === "list" ? [] : undefined;
      variables.set(v.name, start);
    }
  }

  const progress: CapturedProgress[] = [];
  const logs: CapturedLog[] = [];
  const media = options.media ?? memoryMediaStore();
  let usedState = false;
  const tag = { runId: options.runId ?? "run_test", nodeId };
  const logAt =
    (level: CapturedLog["level"]) =>
    (message: string, data?: LogData): void => {
      const full = { ...(data ?? {}), ...tag };
      logs.push({ level, message, data: full });
      options.logger?.[level](message, full);
    };
  const reader = (kind: "global" | "variable", map: Map<string, unknown>) => ({
    get(name: string): unknown {
      usedState = true;
      if (!map.has(name)) {
        throw new NodeError("variable.unknown", `${kind === "global" ? "Global" : "Variable"} "${name}" does not exist. Check the name.`, {
          details: { name },
        });
      }
      return map.get(name);
    },
  });
  const baseFetch: typeof fetch =
    options.fetch ??
    (async () => {
      throw new TypeError("runNode: no fetch given (pass options.fetch).");
    });
  const signal = options.signal ?? new AbortController().signal;
  const ctx: ExecContext = {
    signal,
    runId: tag.runId,
    flowId,
    nodeId,
    attempt: options.attempt ?? 1,
    progress(fraction: number, message?: string) {
      if (typeof fraction !== "number" || Number.isNaN(fraction)) return;
      const entry: CapturedProgress = { fraction: Math.min(1, Math.max(0, fraction)) };
      if (typeof message === "string") entry.message = message.slice(0, 200);
      progress.push(entry);
    },
    log: { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") },
    media,
    secrets: {
      async get(name: string) {
        const value = secretValues.get(name);
        if (value === undefined) {
          throw new NodeError(
            "node.secret_not_declared",
            `Node ${title} asked for secret "${name}", which its definition does not declare. Add "${name}" to the node's secrets.`,
            { details: { secret: name } },
          );
        }
        return value;
      },
    },
    globals: reader("global", globals),
    variables: reader("variable", variables),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => baseFetch(input, init?.signal ? init : { ...(init ?? {}), signal })) as typeof fetch,
    resolveType: (id: string): TypeDecl | undefined => scope.getType(id)?.decl,
  };

  const raw: unknown = await definition.run({ inputs: values as never, config: config as never, node: instance, ctx });

  // Outputs.
  let outputs: Record<string, unknown>;
  if (options.checkOutputs === false) {
    outputs = { ...(raw as Record<string, unknown>) };
  } else {
    const bad = (message: string, details?: unknown): NodeError =>
      new NodeError("node.invalid_output", message, details === undefined ? {} : { details });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw bad(`Node ${title} returned ${raw === null ? "null" : Array.isArray(raw) ? "a list" : typeof raw} instead of an object with its outputs.`);
    }
    const rec = raw as Record<string, unknown>;
    const names = resolved.outputs.map((p) => p.name);
    for (const key of Object.keys(rec)) {
      if (rec[key] !== undefined && !names.includes(key)) throw bad(`Node ${title} returned an unknown output "${key}".`, { port: key });
    }
    outputs = {};
    for (const port of resolved.outputs) {
      let value = rec[port.name];
      // A canFail node's error output is only filled on the failed line.
      if (value === undefined && port.name === ERROR_OUTPUT && (def as unknown as AnyNodeDefinition).canFail) continue;
      if (value === undefined) {
        if (port.declaredType.kind === "optional") value = null;
        else throw bad(`Node ${title} did not return its output "${port.name}".`, { port: port.name });
      }
      const type = portType(port);
      if (!containsVar(type)) {
        const r = normalizeValue(value, type, scope, { path: `outputs.${port.name}`, at: { ...at, port: port.name } });
        if (!r.ok) throw bad(`Node ${title} returned an invalid output: ${firstMessage(r.diagnostics, port.name)}.`, { diagnostics: r.diagnostics });
        value = r.value;
      }
      outputs[port.name] = value;
    }
  }

  return {
    outputs: outputs as OutputsOf<D>,
    progress,
    logs,
    media,
    inputs: values,
    ports: { inputs: resolved.inputs, outputs: resolved.outputs },
    usedState,
  };
}
