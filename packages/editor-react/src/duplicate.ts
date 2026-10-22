/** Copying nodes: the commands behind "Duplicate" (menu and Ctrl/Cmd+D). */
import type { Command } from "@briarflow/authoring";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "@briarflow/core";
import type { FlowDocument } from "@briarflow/core";

/** A fresh node id (`n_` + random), for commands that must reference nodes they create. */
export function randomNodeId(): string {
  return `n_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Commands that copy nodes (type, title, config, constants) `offset` away, plus the edges
 * between them, as one batch. Built-in input/output nodes are skipped. `ids` maps each copied
 * node id to its new id.
 *
 * @example
 * ```ts
 * const { commands, ids } = duplicateCommands(flow, ["n_a", "n_b"]);
 * store.dispatch(commands);
 * ```
 */
export function duplicateCommands(
  flow: FlowDocument,
  nodeIds: readonly string[],
  offset = { x: 48, y: 48 },
  makeId: () => string = randomNodeId,
): { commands: Command[]; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const commands: Command[] = [];
  const used = new Set(flow.nodes.map((n) => n.id));
  for (const n of flow.nodes) {
    if (!nodeIds.includes(n.id) || n.type === FLOW_INPUT_NODE_TYPE || n.type === FLOW_OUTPUT_NODE_TYPE) continue;
    let id = makeId();
    while (used.has(id)) id = makeId();
    used.add(id);
    ids.set(n.id, id);
    commands.push({
      op: "node.add",
      flowId: flow.id,
      id,
      type: n.type,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      ...(n.title !== undefined ? { title: n.title } : {}),
      ...(n.config !== undefined ? { config: n.config } : {}),
      ...(n.values !== undefined ? { values: n.values } : {}),
    });
  }
  for (const e of flow.edges) {
    const from = ids.get(e.from.node);
    const to = ids.get(e.to.node);
    if (from && to) commands.push({ op: "edge.connect", flowId: flow.id, from: { node: from, port: e.from.port }, to: { node: to, port: e.to.port } });
  }
  return { commands, ids };
}
