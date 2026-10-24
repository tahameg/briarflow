/**
 * Conversion nodes (node-api.md §3.4): pure nodes marked `conversion: true` that turn the
 * value on their first input into their one output. Editors use {@link findConversions} to
 * put one between two ports whose types do not fit.
 */
import { isAssignable, stripConstraints, typeEquals } from "../types/assignability.js";
import { bindTypeVars, collectOneOf, substituteTypeVars } from "../types/generics.js";
import type { GenericConnection } from "../types/generics.js";
import type { TypeRef } from "../types/ir.js";
import { containsVar } from "../types/walk.js";
import type { NodeCatalog } from "./catalog.js";
import { portParts } from "./define.js";

/** A conversion node that takes `from` and gives `to`. */
export interface ConversionMatch {
  /** Node type to add. */
  type: string;
  title: string;
  /** Input that takes the value. */
  input: string;
  /** Output that gives the converted value. */
  output: string;
}

/**
 * Conversion nodes of a catalog that turn a `from` value into a `to` value, best first: an
 * input of exactly `from` before a widening one, before a limited generic (`oneOf`), before
 * one that takes any type. Empty when none fits.
 *
 * @example
 * ```ts
 * findConversions(catalog, { kind: "primitive", name: "json" }, { kind: "primitive", name: "text" });
 * // [{ type: "convert.toText", title: "As text", input: "value", output: "text" }]
 * ```
 */
export function findConversions(catalog: NodeCatalog, from: TypeRef, to: TypeRef): ConversionMatch[] {
  if (containsVar(from) || containsVar(to)) return [];
  const found: { match: ConversionMatch; rank: number }[] = [];
  for (const pack of catalog.packs) {
    for (const def of pack.nodes) {
      if (def.conversion !== true) continue;
      const input = Object.entries(def.inputs)[0];
      const output = Object.entries(def.outputs)[0];
      const inType = input && portParts(input[1])?.spec.ref;
      const outType = output && portParts(output[1])?.spec.ref;
      if (!input || !output || !inType || !outType) continue;
      let inBound = inType;
      let outBound = outType;
      if (containsVar(inType) || containsVar(outType)) {
        const conns: GenericConnection[] = [{ port: input[0], direction: "input", pattern: inType, other: from }];
        if (containsVar(outType)) conns.push({ port: output[0], direction: "output", pattern: outType, other: to });
        const r = bindTypeVars(conns);
        if (!r.ok) continue;
        inBound = substituteTypeVars(inType, r.bindings);
        outBound = substituteTypeVars(outType, r.bindings);
        if (containsVar(inBound) || containsVar(outBound)) continue;
      }
      if (!isAssignable(from, inBound) || !isAssignable(outBound, to)) continue;
      const rank = !containsVar(inType)
        ? typeEquals(stripConstraints(from), stripConstraints(inType)) ? 0 : 1
        : collectOneOf(inType).size > 0 ? 2 : 3;
      found.push({ match: { type: def.type, title: def.title, input: input[0], output: output[0] }, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank || a.match.title.localeCompare(b.match.title)).map((f) => f.match);
}
