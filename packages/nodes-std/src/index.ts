/**
 * @briarflow/nodes-std — the standard node pack `briar` (namespaces `text`, `list`,
 * `convert`). See docs/specs/node-api.md §9. `briar.input` / `briar.output` are core
 * built-ins and are not part of this pack.
 *
 * @example
 * ```ts
 * import { createCatalog } from "@briarflow/core";
 * import { stdPack } from "@briarflow/nodes-std";
 * const catalog = createCatalog([stdPack]);
 * ```
 */
import { definePack, type NodePack } from "@briarflow/core";
import { convertFloatToInt, convertParseFloat, convertParseInt, convertToText, RoundingMode } from "./convert.js";
import { constant, structBreak, structMake } from "./data.js";
import { listGet, listLength, listMake } from "./list.js";
import { textJoin, textTemplate } from "./text.js";
import { globalGet, globalSet, variableGet, variableSet } from "./variables.js";

export const PACKAGE_NAME = "@briarflow/nodes-std";

export { convertFloatToInt, convertParseFloat, convertParseInt, convertToText, RoundingMode } from "./convert.js";
export { constant, structBreak, structMake } from "./data.js";
export { listGet, listLength, listMake } from "./list.js";
export { textJoin, textTemplate } from "./text.js";
export { renderTemplate, templatePlaceholders, valueToText } from "./text-utils.js";
export { globalGet, globalSet, variableGet, variableSet } from "./variables.js";

/**
 * The standard pack: name `briar`, namespaces `briar`, `text`, `list`, `convert`, pack type
 * `briar.RoundingMode`.
 *
 * @example
 * ```ts
 * const engine = createEngine({ catalog: createCatalog([stdPack, mockPack]), media, secrets });
 * ```
 */
export const stdPack: NodePack = definePack({
  name: "briar",
  version: "1.0.0",
  title: "Briarflow standard nodes",
  description: "Variables, structs, constants, text, lists and conversions.",
  namespaces: ["text", "list", "convert"],
  types: [RoundingMode],
  nodes: [
    variableGet,
    variableSet,
    globalGet,
    globalSet,
    structMake,
    structBreak,
    constant,
    textTemplate,
    textJoin,
    listMake,
    listLength,
    listGet,
    convertToText,
    convertParseInt,
    convertParseFloat,
    convertFloatToInt,
  ],
});
