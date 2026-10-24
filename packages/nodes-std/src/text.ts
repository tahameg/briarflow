/**
 * Text nodes (docs/specs/node-api.md §9).
 */
import { cfg, defineNode, t, type PortMap, type TypeRef } from "@briarflow/core";
import { renderTemplate, templatePlaceholders } from "./text-utils.js";

/**
 * `text.template` (Template builder): `config.template` with `{{name}}` slots. Each distinct
 * name becomes an input: generic (type vars `T1`, `T2`, … by first appearance, rendered with
 * toText), or json when the template reads a field of it (`{{user.name}}`). `{{$(name)}}` reads a flow variable (else a global) at run start and
 * needs no input. `\{{` is a literal `{{`.
 */
export const textTemplate = defineNode({
  type: "text.template",
  pure: true,
  // {{$(name)}} reads variables, which are not part of the cache key.
  cache: false,
  title: "Template builder",
  category: "Text",
  icon: "text",
  color: "mint",
  description:
    "Builds text from a template. {{name}} adds an input for any value, {{name.field}} a JSON input, {{$(variable)}} reads a variable. Write \\{{ for literal braces.",
  config: { template: cfg.text({ multiline: true, title: "Template" }) },
  outputs: { text: t.text() },
  resolvePorts({ config, scope }) {
    const needs = templatePlaceholders(config.template);
    if ("error" in needs) return needs;
    for (const name of needs.variables) {
      if (!scope.flow.variables.some((v) => v.name === name) && !scope.globals.some((g) => g.name === name)) {
        return { error: { code: "text.unknown_variable", message: `{{$(${name})}} reads "${name}", which is neither a variable of this flow nor a global. Create it or fix the name.` } };
      }
    }
    const inputs: PortMap = {};
    needs.inputs.forEach(({ name, json }, i) => {
      inputs[name] = json ? t.json() : t.var(`T${i + 1}`);
    });
    return { inputs, outputs: { text: t.text() } };
  },
  run: ({ inputs, config, node, ctx }) => {
    const types: Record<string, TypeRef> = {};
    const needs = templatePlaceholders(config.template);
    if (!("error" in needs)) {
      needs.inputs.forEach(({ name }, i) => {
        const bound = node.typeBindings?.[`T${i + 1}`];
        if (bound) types[name] = bound;
      });
    }
    return { text: renderTemplate(config.template, inputs, types, (name) => {
      try {
        return ctx.variables.get(name);
      } catch {
        return ctx.globals.get(name);
      }
    }) };
  },
});

/** `text.join`: joins a list of text with a separator. */
export const textJoin = defineNode({
  type: "text.join",
  pure: true,
  title: "Join text",
  category: "Text",
  icon: "text",
  color: "mint",
  description: "Joins a list of text into one text, with an optional separator between items.",
  inputs: { items: t.list(t.text()), separator: { type: t.text(), default: "" } },
  outputs: { text: t.text() },
  run: ({ inputs }) => ({ text: inputs.items.join(inputs.separator) }),
});
