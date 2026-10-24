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
import { convertAsBoolean, convertAsFloat, convertAsInt, convertAsJson, convertAsJsonArray, convertFloatToInt, convertToText, RoundingMode } from "./convert.js";
import { constant, errorBreak, memberGet, memberSet, structBreak, structMake } from "./data.js";
import { debugPrint } from "./debug.js";
import { jsonAddField, jsonConstruct, jsonGetField, jsonSetField } from "./json.js";
import { listGet, listLength, listMake } from "./list.js";
import { textJoin, textTemplate } from "./text.js";
import { globalGet, globalSet, variableGet, variableSet } from "./variables.js";

export const PACKAGE_NAME = "@briarflow/nodes-std";

export { convertAsBoolean, convertAsFloat, convertAsInt, convertAsJson, convertAsJsonArray, convertFloatToInt, convertToText, RoundingMode, truthOf } from "./convert.js";
export { constant, errorBreak, memberGet, memberSet, structBreak, structMake } from "./data.js";
export { debugPrint } from "./debug.js";
export { jsonAddField, jsonConstruct, jsonGetField, jsonSetField } from "./json.js";
export { listGet, listLength, listMake } from "./list.js";
export { textJoin, textTemplate } from "./text.js";
export { renderTemplate, templatePlaceholders, valueToText, type TemplateNeeds } from "./text-utils.js";
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
  description: "Variables, structs, constants, text, JSON, lists and conversions.",
  namespaces: ["text", "list", "convert", "debug", "json"],
  types: [RoundingMode],
  nodes: [
    variableGet,
    variableSet,
    globalGet,
    globalSet,
    structMake,
    structBreak,
    constant,
    errorBreak,
    memberGet,
    memberSet,
    textTemplate,
    jsonConstruct,
    jsonGetField,
    jsonSetField,
    jsonAddField,
    textJoin,
    listMake,
    listLength,
    listGet,
    convertToText,
    convertAsJson,
    convertAsInt,
    convertAsFloat,
    convertAsBoolean,
    convertAsJsonArray,
    convertFloatToInt,
    debugPrint,
  ],
});
