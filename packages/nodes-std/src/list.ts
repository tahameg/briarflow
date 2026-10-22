/**
 * List nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, t, type PortMap } from "@briarflow/core";

/** `list.make`: `item1 … itemN` (N = `config.count`, 0–32) → `list<$T>`. */
export const listMake = defineNode({
  type: "list.make",
  pure: true,
  title: "Make list",
  category: "List",
  icon: "list",
  color: "yellow",
  description: "Builds a list from a fixed number of items.",
  config: { count: cfg.int({ min: 0, max: 32, default: 2, title: "Items" }) },
  outputs: { list: t.list(t.var("T")) },
  resolvePorts({ config }) {
    const inputs: PortMap = {};
    for (let i = 1; i <= config.count; i++) inputs[`item${i}`] = t.var("T");
    return { inputs, outputs: { list: t.list(t.var("T")) } };
  },
  run: ({ inputs, config }) => {
    const list = [];
    for (let i = 1; i <= config.count; i++) list.push(inputs[`item${i}`] ?? null);
    return { list };
  },
});

/** `list.length`: number of items. */
export const listLength = defineNode({
  type: "list.length",
  pure: true,
  title: "List length",
  category: "List",
  icon: "list",
  color: "yellow",
  description: "Counts the items of a list.",
  inputs: { list: t.list(t.var("T")) },
  outputs: { length: t.int() },
  run: ({ inputs }) => ({ length: inputs.list.length }),
});

/** `list.get`: item at `index`; negative counts from the end; out of range → `null`. */
export const listGet = defineNode({
  type: "list.get",
  pure: true,
  title: "Get item",
  category: "List",
  icon: "list",
  color: "yellow",
  description: "Picks one item by position. -1 is the last item; a position outside the list gives nothing (null).",
  inputs: { list: t.list(t.var("T")), index: t.int() },
  outputs: { item: t.optional(t.var("T")) },
  run: ({ inputs }) => {
    const { list, index } = inputs;
    const i = index < 0 ? list.length + index : index;
    return { item: i >= 0 && i < list.length ? (list[i] ?? null) : null };
  },
});
