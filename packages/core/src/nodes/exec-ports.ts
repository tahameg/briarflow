/**
 * Execution ports (docs/specs/execution.md): which execution lines a node can take and send.
 * Derived from the node type, never stored.
 */
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "../documents/model.js";
import type { AnyNodeDefinition } from "./define.js";

/** The execution input every non-pure node has. */
export const EXEC_IN = "in";
/** Where execution goes next. */
export const EXEC_THEN = "then";
/** Where execution goes when the node fails (only `canFail` nodes). */
export const EXEC_FAILED = "failed";
/** The data output a `canFail` node fills when it fails. */
export const ERROR_OUTPUT = "error";

/** Execution port names of a node, in display order. */
export interface ExecPorts {
  inputs: readonly string[];
  outputs: readonly string[];
}

const NONE: ExecPorts = { inputs: [], outputs: [] };
const INPUT_NODE: ExecPorts = { inputs: [], outputs: [EXEC_THEN] };
const OUTPUT_NODE: ExecPorts = { inputs: [EXEC_IN], outputs: [] };
const STEP: ExecPorts = { inputs: [EXEC_IN], outputs: [EXEC_THEN] };
const FALLIBLE: ExecPorts = { inputs: [EXEC_IN], outputs: [EXEC_THEN, EXEC_FAILED] };

/**
 * Execution ports of a node type: Input sends `then`; Output takes `in`; pure nodes have
 * none; every other node takes `in` and sends `then` (and `failed` when it `canFail`). An
 * unknown type keeps `in` / `then` so its lines stay valid until its pack is back.
 *
 * @example
 * ```ts
 * execPortsOf("mock.llm", catalog.get("mock.llm")); // { inputs: ["in"], outputs: ["then", "failed"] }
 * ```
 */
export function execPortsOf(type: string, def: AnyNodeDefinition | undefined): ExecPorts {
  if (type === FLOW_INPUT_NODE_TYPE) return INPUT_NODE;
  if (type === FLOW_OUTPUT_NODE_TYPE) return OUTPUT_NODE;
  if (def?.pure) return NONE;
  return def?.canFail ? FALLIBLE : STEP;
}

/** True when the node sits on the execution line (has an execution input or output). */
export function isExecNode(type: string, def: AnyNodeDefinition | undefined): boolean {
  const p = execPortsOf(type, def);
  return p.inputs.length > 0 || p.outputs.length > 0;
}
