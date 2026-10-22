import { EXEC_IN, EXEC_THEN } from "../nodes/exec-ports.js";
import { BriarError } from "../errors.js";
import type { Clock, IdGenerator, IdKind } from "../util/ids.js";
import { createIdGenerator, ID_PREFIXES, isValidId } from "../util/ids.js";
import type { ContextDocument, FlowDocument, NodeInstance } from "./model.js";
import { CONTEXT_FORMAT, CONTEXT_FORMAT_VERSION, FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "./model.js";

function checkId(kind: IdKind, label: string, id: string): void {
  if (typeof id !== "string" || !isValidId(kind, id)) {
    throw new BriarError(
      "document.invalid_id",
      `"${String(id)}" is not a valid ${label} id. Expected ${ID_PREFIXES[kind]}_ followed by 1–60 of A–Z, a–z, 0–9, _ or -.`,
      { details: { id, kind } },
    );
  }
}

/** Options of {@link createContextDocument}. */
export interface CreateContextOptions {
  name: string;
  /** Default: `idGenerator("ctx")`. Must match the context id regex. */
  id?: string;
  description?: string;
  /** Default: `createIdGenerator()`. */
  idGenerator?: IdGenerator;
  /** Default: `() => new Date()`. Sets `createdAt` and `updatedAt`. */
  clock?: Clock;
}

/**
 * Creates an empty context: revision 0, no types, globals or flows.
 * Throws `BriarError("document.invalid_id" | "document.invalid_name")` for a bad id or a name
 * that is empty or longer than 120 characters.
 *
 * @example
 * ```ts
 * const doc = createContextDocument({ name: "Marketing" });
 * ```
 */
export function createContextDocument(options: CreateContextOptions): ContextDocument {
  const ids = options.idGenerator ?? createIdGenerator();
  const id = options.id ?? ids("ctx");
  checkId("context", "context", id);
  const name = options.name;
  if (typeof name !== "string" || name.trim() === "" || name.length > 120) {
    throw new BriarError("document.invalid_name", `Context name must be 1–120 characters (got ${typeof name === "string" ? name.length : 0}).`, {
      details: { name },
    });
  }
  const now = (options.clock ?? (() => new Date()))().toISOString();
  const doc: ContextDocument = {
    format: CONTEXT_FORMAT,
    formatVersion: CONTEXT_FORMAT_VERSION,
    id,
    name,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    types: [],
    globals: [],
    flows: [],
  };
  if (options.description !== undefined) doc.description = options.description;
  return doc;
}

/** Options of {@link createFlowDocument}. */
export interface CreateFlowOptions {
  name: string;
  /** Default: `idGenerator("flow")`. */
  id?: string;
  description?: string;
  /** Default: `idGenerator("n")`. */
  inputNodeId?: string;
  /** Default: `idGenerator("n")`. */
  outputNodeId?: string;
  idGenerator?: IdGenerator;
}

/**
 * Creates an empty flow with its `briar.input` node at `{x:0,y:0}` and `briar.output` node at
 * `{x:640,y:0}` (commands.md §5 `flow.create`). The flow is not added to any context.
 *
 * @example
 * ```ts
 * const flow = createFlowDocument({ name: "Portrait", id: "flow_p" });
 * ```
 */
export function createFlowDocument(options: CreateFlowOptions): FlowDocument {
  const ids = options.idGenerator ?? createIdGenerator();
  const id = options.id ?? ids("flow");
  checkId("flow", "flow", id);
  const name = options.name;
  // eslint-disable-next-line no-control-regex
  if (typeof name !== "string" || name.trim() === "" || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new BriarError("document.invalid_name", "Flow name must be 1–80 characters without control characters.", {
      details: { name },
    });
  }
  const inputNodeId = options.inputNodeId ?? ids("n");
  const outputNodeId = options.outputNodeId ?? ids("n");
  checkId("node", "input node", inputNodeId);
  checkId("node", "output node", outputNodeId);
  if (inputNodeId === outputNodeId) {
    throw new BriarError("document.invalid_id", `The input and output nodes need different ids (both are "${inputNodeId}").`, {
      details: { id: inputNodeId, kind: "node" },
    });
  }
  const flow: FlowDocument = {
    id,
    name,
    types: [],
    inputs: [],
    outputs: [],
    variables: [],
    nodes: [
      { id: inputNodeId, type: FLOW_INPUT_NODE_TYPE, position: { x: 0, y: 0 } },
      { id: outputNodeId, type: FLOW_OUTPUT_NODE_TYPE, position: { x: 640, y: 0 } },
    ],
    edges: [],
    execEdges: [{ id: ids("x"), from: { node: inputNodeId, port: EXEC_THEN }, to: { node: outputNodeId, port: EXEC_IN } }],
  };
  if (options.description !== undefined) flow.description = options.description;
  return flow;
}

/**
 * Finds a flow by id.
 *
 * @example
 * ```ts
 * const flow = findFlow(doc, "flow_p");
 * ```
 */
export function findFlow(doc: ContextDocument, flowId: string): FlowDocument | undefined {
  return doc.flows.find((flow) => flow.id === flowId);
}

/**
 * Finds a node by id inside a flow.
 *
 * @example
 * ```ts
 * const node = findNode(flow, "n_tpl");
 * ```
 */
export function findNode(flow: FlowDocument, nodeId: string): NodeInstance | undefined {
  return flow.nodes.find((node) => node.id === nodeId);
}
