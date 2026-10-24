/**
 * Conversion nodes (docs/specs/node-api.md §9): pure, `conversion: true`, so the editor
 * inserts them when a wire joins two types they convert between.
 *
 * - As text and As boolean take any value and never fail.
 * - As JSON takes text and does not parse it (fields are parsed when read).
 * - As int, As float and As JSON array take text or json and fail when it does not read.
 */
import { defineEnum, defineNode, NodeError, t, type JsonValue } from "@briarflow/core";
import { jsonToText, openJson } from "./json-path.js";
import { valueToText } from "./text-utils.js";

const TEXT_OR_JSON = { oneOf: [t.text(), t.json()] };

/** Pack enum `briar.RoundingMode`. */
export const RoundingMode = defineEnum("RoundingMode", ["round", "floor", "ceil", "trunc"], {
  description: "How a number with a fraction becomes a whole number. round = half away from zero.",
});

/** `convert.toText` (As text): any value → text (toText rules); never fails. */
export const convertToText = defineNode({
  type: "convert.toText",
  pure: true,
  conversion: true,
  title: "As text",
  category: "Convert",
  icon: "type",
  color: "peach",
  description: "Turns any value into text and never fails. A JSON string becomes its text, lists, structs and other JSON become compact JSON, media becomes its URI.",
  inputs: { value: t.var("T") },
  outputs: { text: t.text() },
  run: ({ inputs, node }) => ({ text: valueToText(inputs.value, node.typeBindings?.["T"]) }),
});

const INT_PATTERN = /^[+-]?\d+$/;
const FLOAT_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function invalidNumber(text: string, what: string): NodeError {
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return new NodeError("convert.invalid_number", `"${shown}" is not ${what}. Check the text that feeds this node.`, {
    details: { text: text.slice(0, 200) },
  });
}

function readNumber(value: unknown, what: string, pattern: RegExp, ok: (n: number) => boolean): number {
  const text = jsonToText(value);
  const s = text.trim();
  const n = Number(s);
  if (!pattern.test(s) || !ok(n)) throw invalidNumber(text, what);
  return n === 0 ? 0 : n;
}

/** `convert.asInt`: text or json → whole number; anything else fails with `convert.invalid_number`. */
export const convertAsInt = defineNode({
  type: "convert.asInt",
  pure: true,
  conversion: true,
  title: "As int",
  category: "Convert",
  icon: "hash",
  color: "peach",
  description: "Reads a whole number such as 42 or -7 from text or JSON. Fails when it is not one.",
  inputs: { value: t.var("T", TEXT_OR_JSON) },
  outputs: { value: t.int() },
  run: ({ inputs }) => ({ value: readNumber(inputs.value, "a whole number", INT_PATTERN, Number.isSafeInteger) }),
});

/** `convert.asFloat`: text or json → number; anything else fails with `convert.invalid_number`. */
export const convertAsFloat = defineNode({
  type: "convert.asFloat",
  pure: true,
  conversion: true,
  title: "As float",
  category: "Convert",
  icon: "hash",
  color: "peach",
  description: "Reads a number such as 3.14, -2 or 1e3 from text or JSON. Fails when it is not one.",
  inputs: { value: t.var("T", TEXT_OR_JSON) },
  outputs: { value: t.float() },
  run: ({ inputs }) => ({ value: readNumber(inputs.value, "a number", FLOAT_PATTERN, Number.isFinite) }),
});

const FALSE_TEXT = new Set(["", "false", "0", "no", "off", "null"]);

/** Truth of any value: no value, false, 0 and "false"-like text are false; the rest is true. */
export function truthOf(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return !FALSE_TEXT.has(value.trim().toLowerCase());
  return true;
}

/** `convert.asBoolean`: any value → boolean; never fails. */
export const convertAsBoolean = defineNode({
  type: "convert.asBoolean",
  pure: true,
  conversion: true,
  title: "As boolean",
  category: "Convert",
  icon: "toggle-left",
  color: "peach",
  description: 'Turns any value into true or false and never fails. False: no value (null), 0, and text such as "", "false", "0", "no", "off". Everything else is true.',
  inputs: { value: t.var("T") },
  outputs: { value: t.boolean() },
  run: ({ inputs }) => ({ value: truthOf(inputs.value) }),
});

/** `convert.asJson`: text → json, as it is (no parsing; fields are parsed when read). */
export const convertAsJson = defineNode({
  type: "convert.asJson",
  pure: true,
  conversion: true,
  title: "As JSON",
  category: "Convert",
  icon: "braces",
  color: "peach",
  description: 'Treats text as JSON, e.g. {"name": "Aria"}. It does not check the text: Get field reads it and fails when it is not valid JSON.',
  inputs: { text: t.text() },
  outputs: { json: t.json() },
  run: ({ inputs }) => ({ json: inputs.text }),
});

/** `convert.asJsonArray`: text or json holding an array → list of json. */
export const convertAsJsonArray = defineNode({
  type: "convert.asJsonArray",
  pure: true,
  conversion: true,
  title: "As JSON array",
  category: "Convert",
  icon: "brackets",
  color: "peach",
  description: "Reads a JSON array from text or JSON as a list of JSON values. Fails when it is not an array.",
  inputs: { value: t.var("T", TEXT_OR_JSON) },
  outputs: { items: t.list(t.json()) },
  run: ({ inputs }) => {
    const value = openJson(inputs.value, "The value");
    if (!Array.isArray(value)) {
      throw new NodeError("json.wrong_kind", `The value is ${value === null ? "null" : typeof value === "object" ? "an object" : `a ${typeof value}`}, not a JSON array.`, {
        details: { wanted: "array" },
      });
    }
    return { items: value as readonly JsonValue[] };
  },
});

function roundNumber(value: number, mode: string): number {
  switch (mode) {
    case "floor":
      return Math.floor(value);
    case "ceil":
      return Math.ceil(value);
    case "trunc":
      return Math.trunc(value);
    default:
      return Math.sign(value) * Math.round(Math.abs(value));
  }
}

/** `convert.floatToInt`: rounds with `briar.RoundingMode` (default `round`, half away from zero). */
export const convertFloatToInt = defineNode({
  type: "convert.floatToInt",
  pure: true,
  conversion: true,
  title: "Float to int",
  category: "Convert",
  icon: "hash",
  color: "peach",
  description: "Turns a number into a whole number by rounding, flooring, ceiling or truncating.",
  inputs: { value: t.float(), mode: { type: t.ref(RoundingMode), default: "round" } },
  outputs: { value: t.int() },
  run: ({ inputs }) => {
    const n = roundNumber(inputs.value, inputs.mode);
    if (!Number.isSafeInteger(n)) {
      throw new NodeError("convert.invalid_number", `${inputs.value} is too large to be a whole number.`, { details: { value: inputs.value } });
    }
    return { value: n === 0 ? 0 : n };
  },
});
