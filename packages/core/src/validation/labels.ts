/**
 * Internal: human labels of nodes in diagnostics (types.md §11).
 */
import type { NodeInstance } from "../documents/model.js";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "../documents/model.js";
import type { AnyNodeDefinition } from "../nodes/define.js";
import { titleFromNodeType } from "../util/titles.js";

/** Node title, or `<definition title> (<id>)` when the title is empty: `Text template (n_tpl1)`. */
export function nodeLabel(node: NodeInstance, def: AnyNodeDefinition | undefined): string {
  if (node.title !== undefined && node.title.trim() !== "") return node.title;
  let title: string;
  if (node.type === FLOW_INPUT_NODE_TYPE) title = "Input";
  else if (node.type === FLOW_OUTPUT_NODE_TYPE) title = "Output";
  else title = def?.title ?? titleFromNodeType(node.type);
  return `${title} (${node.id})`;
}
