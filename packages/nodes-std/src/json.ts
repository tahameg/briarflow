/**
 * JSON nodes. A `Json` value holds a JSON document as text (`{ text }`): Get field reads a part
 * of it (still Json). Turning Json into other types is the job of the conversion nodes (As
 * text, As int, …, convert.ts). The text is parsed only when a field is read or written.
 */
import { defineNode, jsonText, NodeError, t } from "@briarflow/core";
import { getAt, hasAt, openJson, pathOrThrow, setAt, showPath } from "./json-path.js";

const json = (value: unknown) => jsonText(value);
const open = (value: { text: string }, here = "The JSON") => openJson(value, here);

const PATH_DESCRIPTION = "Field path such as user.name or items[0].id. Empty = the whole value.";

/** `json.construct`: a JSON value typed in the JSON editor. */
export const jsonConstruct = defineNode({
  type: "json.construct",
  pure: true,
  title: "Construct JSON",
  category: "JSON",
  icon: "braces",
  color: "yellow",
  description: "A JSON value you write by hand: an object, an array or a single value.",
  inputs: { value: { type: t.json(), default: { text: "{}" } } },
  outputs: { json: t.json() },
  run: ({ inputs }) => ({ json: inputs.value }),
});

/** `json.getField`: the value at a path; a missing field fails with `json.field_missing`. */
export const jsonGetField = defineNode({
  type: "json.getField",
  pure: true,
  title: "Get field",
  category: "JSON",
  icon: "braces",
  color: "yellow",
  description: "Reads a field of a JSON value. The result is JSON too: use As string, As int, … to turn it into another type. Fails when the field does not exist or the JSON text is not valid.",
  inputs: { json: t.json(), path: { type: t.string(), description: PATH_DESCRIPTION } },
  outputs: { value: t.json() },
  run: ({ inputs }) => ({ value: json(getAt(open(inputs.json), pathOrThrow(inputs.path))) }),
});

/** `json.setField`: writes a field, creating missing objects on the way. */
export const jsonSetField = defineNode({
  type: "json.setField",
  pure: true,
  title: "Set field",
  category: "JSON",
  icon: "braces",
  color: "yellow",
  description: "Writes a field of a JSON value: replaces it when it exists, adds it when it does not. Missing objects on the way are created.",
  inputs: { json: t.json(), path: { type: t.string(), description: PATH_DESCRIPTION }, value: t.json() },
  outputs: { json: t.json() },
  run: ({ inputs }) => ({ json: json(setAt(open(inputs.json), pathOrThrow(inputs.path), open(inputs.value, "The value"))) }),
});

/** `json.addField`: adds a field; an existing one fails with `json.field_exists` unless `overwrite`. */
export const jsonAddField = defineNode({
  type: "json.addField",
  pure: true,
  title: "Add field",
  category: "JSON",
  icon: "braces",
  color: "yellow",
  description: "Adds a new field to a JSON value. Fails when the field already exists, unless Overwrite is on.",
  inputs: {
    json: t.json(),
    path: { type: t.string(), description: PATH_DESCRIPTION },
    value: t.json(),
    overwrite: { type: t.bool(), default: false, description: "Replace the field when it already exists instead of failing." },
  },
  outputs: { json: t.json() },
  run: ({ inputs }) => {
    const path = pathOrThrow(inputs.path);
    const doc = open(inputs.json);
    if (!inputs.overwrite && hasAt(doc, path)) {
      throw new NodeError("json.field_exists", `Field ${showPath(path)} already exists. Turn on Overwrite or use Set field.`, {
        details: { path: showPath(path) },
      });
    }
    return { json: json(setAt(doc, path, open(inputs.value, "The value"))) };
  },
});
