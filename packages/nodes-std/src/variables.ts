/**
 * Variable and global nodes (docs/specs/variables.md §3). The engine executes these four node
 * types itself (it knows the ordering plan); their `run` is only a fallback outside the engine.
 */
import { cfg, defineNode, NodeError, t, type PortError, type UnknownValue } from "@briarflow/core";

function unknownRef(kind: string, id: string): PortError {
  return { error: { code: "config.unknown_ref", message: `${kind} "${id}" does not exist in this flow. Pick another one.` } };
}

function engineOnly(type: string): never {
  throw new NodeError(
    "node.failed",
    `${type} reads values in graph order and only works inside the Briarflow engine. Run it as part of a flow.`,
  );
}

/** `briar.variable.get`: reads a flow variable (variables.md §4 Rule 3). */
export const variableGet = defineNode({
  type: "briar.variable.get",
  title: "Get variable",
  category: "Variables",
  icon: "variable",
  color: "lavender",
  description: "Reads a flow variable: the value of the last Set node before it, or the starting value.",
  cache: false,
  config: { variableId: cfg.flowVariable({ title: "Variable" }) },
  outputs: { value: t.var("V") },
  resolvePorts({ config, scope }) {
    const variable = scope.flow.variables.find((v) => v.id === config.variableId);
    if (!variable) return unknownRef("Variable", config.variableId);
    return { outputs: { value: t.fromRef(variable.type) } };
  },
  run: (): { value: UnknownValue } => engineOnly("briar.variable.get"),
});

/** `briar.variable.set`: writes a flow variable and passes the value through. */
export const variableSet = defineNode({
  type: "briar.variable.set",
  title: "Set variable",
  category: "Variables",
  icon: "variable",
  color: "lavender",
  description: "Writes a flow variable. The written value is also available on the output.",
  cache: false,
  config: { variableId: cfg.flowVariable({ title: "Variable" }) },
  inputs: { value: t.var("V") },
  outputs: { value: t.var("V") },
  resolvePorts({ config, scope }) {
    const variable = scope.flow.variables.find((v) => v.id === config.variableId);
    if (!variable) return unknownRef("Variable", config.variableId);
    return { inputs: { value: t.fromRef(variable.type) }, outputs: { value: t.fromRef(variable.type) } };
  },
  run: ({ inputs }) => ({ value: inputs.value }),
});

/** `briar.global.get`: reads a context global. */
export const globalGet = defineNode({
  type: "briar.global.get",
  title: "Get global",
  category: "Variables",
  icon: "globe",
  color: "lavender",
  description: "Reads a global variable of the context.",
  cache: false,
  config: { globalId: cfg.global({ title: "Global" }) },
  outputs: { value: t.var("G") },
  resolvePorts({ config, scope }) {
    const global = scope.globals.find((g) => g.id === config.globalId);
    if (!global) return unknownRef("Global", config.globalId);
    return { outputs: { value: t.fromRef(global.type) } };
  },
  run: (): { value: UnknownValue } => engineOnly("briar.global.get"),
});

/** `briar.global.set`: writes a readwrite global (persisted by the facade after success). */
export const globalSet = defineNode({
  type: "briar.global.set",
  title: "Set global",
  category: "Variables",
  icon: "globe",
  color: "lavender",
  description: "Writes a readwrite global. The value is saved to the context after the run succeeds.",
  cache: false,
  config: { globalId: cfg.global({ title: "Global", writable: true }) },
  inputs: { value: t.var("G") },
  outputs: { value: t.var("G") },
  resolvePorts({ config, scope }) {
    const global = scope.globals.find((g) => g.id === config.globalId);
    if (!global) return unknownRef("Global", config.globalId);
    return { inputs: { value: t.fromRef(global.type) }, outputs: { value: t.fromRef(global.type) } };
  },
  run: ({ inputs }) => ({ value: inputs.value }),
});
