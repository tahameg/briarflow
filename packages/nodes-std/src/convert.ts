/**
 * Conversion nodes (docs/specs/node-api.md §9).
 */
import { defineEnum, defineNode, NodeError, t } from "@briarflow/core";
import { valueToText } from "./text-utils.js";

/** Pack enum `briar.RoundingMode`. */
export const RoundingMode = defineEnum("RoundingMode", ["round", "floor", "ceil", "trunc"], {
  description: "How a number with a fraction becomes a whole number. round = half away from zero.",
});

/** `convert.toText`: any value → text (toText rules). */
export const convertToText = defineNode({
  type: "convert.toText",
  pure: true,
  title: "To text",
  category: "Convert",
  icon: "type",
  color: "peach",
  description: "Turns any value into text. Lists and structs become compact JSON; media becomes its URI.",
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

/** `convert.parseInt`: trimmed decimal whole number; invalid → `convert.invalid_number`. */
export const convertParseInt = defineNode({
  type: "convert.parseInt",
  pure: true,
  title: "Parse whole number",
  category: "Convert",
  icon: "hash",
  color: "peach",
  description: "Reads a whole number such as 42 or -7 from text.",
  inputs: { text: t.text() },
  outputs: { value: t.int() },
  run: ({ inputs }) => {
    const s = inputs.text.trim();
    const n = Number(s);
    if (!INT_PATTERN.test(s) || !Number.isSafeInteger(n)) throw invalidNumber(inputs.text, "a whole number");
    return { value: n === 0 ? 0 : n };
  },
});

/** `convert.parseFloat`: trimmed decimal number; invalid → `convert.invalid_number`. */
export const convertParseFloat = defineNode({
  type: "convert.parseFloat",
  pure: true,
  title: "Parse number",
  category: "Convert",
  icon: "hash",
  color: "peach",
  description: "Reads a number such as 3.14, -2 or 1e3 from text.",
  inputs: { text: t.text() },
  outputs: { value: t.float() },
  run: ({ inputs }) => {
    const s = inputs.text.trim();
    const n = Number(s);
    if (!FLOAT_PATTERN.test(s) || !Number.isFinite(n)) throw invalidNumber(inputs.text, "a number");
    return { value: n === 0 ? 0 : n };
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
