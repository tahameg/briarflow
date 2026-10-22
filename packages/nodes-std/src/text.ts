/**
 * Text nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, t, type PortMap, type TypeRef } from "@briarflow/core";
import { renderTemplate, templatePlaceholders } from "./text-utils.js";

/**
 * `text.template`: `config.template` with `{placeholder}`s; one generic input per distinct
 * placeholder (type vars `T1`, `T2`, … by first appearance), values rendered with toText.
 */
export const textTemplate = defineNode({
  type: "text.template",
  title: "Text template",
  category: "Text",
  icon: "text",
  color: "mint",
  description: "Fills {placeholders} in a template. Each placeholder becomes an input; write {{ and }} for literal braces.",
  config: { template: cfg.text({ multiline: true, title: "Template" }) },
  outputs: { text: t.text() },
  resolvePorts({ config }) {
    const names = templatePlaceholders(config.template);
    if (!Array.isArray(names)) return names;
    const inputs: PortMap = {};
    names.forEach((name, i) => {
      inputs[name] = t.var(`T${i + 1}`);
    });
    return { inputs, outputs: { text: t.text() } };
  },
  run: ({ inputs, config, node }) => {
    const names = templatePlaceholders(config.template);
    const types: Record<string, TypeRef> = {};
    if (Array.isArray(names)) {
      names.forEach((name, i) => {
        const bound = node.typeBindings?.[`T${i + 1}`];
        if (bound) types[name] = bound;
      });
    }
    return { text: renderTemplate(config.template, inputs, types) };
  },
});

/** `text.join`: joins a list of text with a separator. */
export const textJoin = defineNode({
  type: "text.join",
  title: "Join text",
  category: "Text",
  icon: "text",
  color: "mint",
  description: "Joins a list of text into one text, with an optional separator between items.",
  inputs: { items: t.list(t.text()), separator: { type: t.text(), default: "" } },
  outputs: { text: t.text() },
  run: ({ inputs }) => ({ text: inputs.items.join(inputs.separator) }),
});
