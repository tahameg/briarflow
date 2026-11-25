/**
 * Flow control nodes (docs/specs/execution.md §7): Branch and Switch pick the execution output
 * the line follows; For each and For range run their body once per iteration.
 */
import { cfg, defineLoop, defineNode, NodeError, t, type TypeDecl, type TypeRef } from "@briarflow/core";
import { truthOf } from "./convert.js";

/** `briar.branch`: follows `true` or `false` by the condition's truth (types.md §7.1). */
export const branch = defineNode({
  type: "briar.branch",
  title: "Branch",
  category: "Flow",
  icon: "git-branch",
  color: "yellow",
  cache: false,
  description: "Follows true or false. False: false, 0, empty text, an empty list, no value. Everything else is true.",
  inputs: { condition: t.var("T") },
  control: {
    kind: "route",
    outputs: ["true", "false"],
    route: ({ inputs, node, ctx }) => (truthOf(inputs["condition"], node.typeBindings?.["T"], (id) => ctx.resolveType(id)) ? "true" : "false"),
  },
  run: () => ({}),
});

const SWITCH_DEFAULT = "default";
const STRING: TypeRef = { kind: "primitive", name: "string" };

/** The cases of a Switch: an enum's members, else the config's lines (trimmed, no duplicates). */
function switchCases(type: TypeRef, casesText: string, resolveType: (id: string) => TypeDecl | undefined): string[] {
  const decl = type.kind === "named" ? resolveType(type.id) : undefined;
  if (decl?.kind === "enum") return decl.members.map((m) => m.value);
  const out: string[] = [];
  for (const line of casesText.split("\n")) {
    const c = line.trim();
    if (c !== "" && c !== SWITCH_DEFAULT && c !== "in" && c !== "failed" && !out.includes(c)) out.push(c);
  }
  return out;
}

const switchConfig = {
  type: cfg.type({ optional: true, title: "Type", description: "What the value is: an enum (its members are the cases), string or int. Default string." }),
  cases: cfg.text({ default: "", multiline: true, title: "Cases", description: "One case per line (string and int values). An enum uses its members." }),
};

/** `briar.switch`: follows the output named after the value, else `default`. */
export const switchNode = defineNode({
  type: "briar.switch",
  title: "Switch",
  category: "Flow",
  icon: "split",
  color: "yellow",
  cache: false,
  description: "Follows the execution output of the case the value equals, else default. An enum's members are its cases; for string or int values, list the cases in the node's config.",
  config: switchConfig,
  resolvePorts: ({ config }) => ({ inputs: { value: t.fromRef(config.type ?? STRING) } }),
  control: {
    kind: "route",
    outputs: ({ config, resolveType }) => [
      ...switchCases((config["type"] as TypeRef | undefined) ?? STRING, typeof config["cases"] === "string" ? config["cases"] : "", resolveType),
      SWITCH_DEFAULT,
    ],
    route: ({ inputs, config, ctx }) => {
      const value = inputs["value"];
      const cases = switchCases((config["type"] as TypeRef | undefined) ?? STRING, typeof config["cases"] === "string" ? config["cases"] : "", (id) => ctx.resolveType(id));
      const key = typeof value === "string" || typeof value === "number" ? String(value) : undefined;
      return key !== undefined && cases.includes(key) ? key : SWITCH_DEFAULT;
    },
  },
  run: () => ({}),
});

/** Most iterations a loop may have. */
export const MAX_ITERATIONS = 100_000;

const tooMany = (title: string, n: number) =>
  new NodeError("loop.too_many_iterations", `${title} would run ${n} times; at most ${MAX_ITERATIONS} iterations are allowed.`, { details: { iterations: n, max: MAX_ITERATIONS } });

/** `briar.forEach`: runs the body once per list item. */
export const forEach = defineLoop({
  type: "briar.forEach",
  title: "For each",
  category: "Flow",
  icon: "repeat",
  color: "yellow",
  cache: false,
  description: "Runs the body once per item of the list, in order, then completed. Inside the body: the item, its index, and whether it is the first or the last.",
  inputs: { list: t.list(t.var("T")) },
  outputs: { item: t.var("T"), index: t.int(), isFirst: t.bool(), isLast: t.bool() },
  iterations: ({ inputs }) => {
    const list = Array.isArray(inputs.list) ? inputs.list : [];
    if (list.length > MAX_ITERATIONS) throw tooMany("For each", list.length);
    return list.map((item, index) => ({ item, index, isFirst: index === 0, isLast: index === list.length - 1 }));
  },
});

/** `briar.forRange`: runs the body for every index from first to last (both included). */
export const forRange = defineLoop({
  type: "briar.forRange",
  title: "For range",
  category: "Flow",
  icon: "repeat",
  color: "yellow",
  cache: false,
  description: "Runs the body for every whole number from first to last, both included, then completed. Last below first: no iterations.",
  inputs: { first: { type: t.int(), default: 0 }, last: { type: t.int(), default: 0 } },
  outputs: { index: t.int(), isFirst: t.bool(), isLast: t.bool() },
  iterations: ({ inputs }) => {
    const n = inputs.last - inputs.first + 1;
    if (n <= 0) return [];
    if (n > MAX_ITERATIONS) throw tooMany("For range", n);
    return Array.from({ length: n }, (_, i) => ({ index: inputs.first + i, isFirst: i === 0, isLast: i === n - 1 }));
  },
});
