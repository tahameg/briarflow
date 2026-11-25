/**
 * Internal: validation of constraint definitions (types.md §6, `type.invalid_constraint`).
 */
import type { TypeRef } from "./ir.js";
import type { Diagnostic, DiagnosticPath } from "../validation/diagnostic.js";

/** One invalid constraint. */
export interface ConstraintProblem {
  /** Constraint key, e.g. `"min"`, `"pattern"`, `"minItems"`. */
  constraint: string;
  /** Short reason, e.g. `"min (5) is greater than max (1)"`. */
  reason: string;
  /** Short description of the type the constraint is on, e.g. `"int"`, `"list"`. */
  on: string;
}

const ALLOWED: Record<string, readonly string[]> = {
  int: ["min", "max"],
  float: ["min", "max"],
};

/** Compiles a Text `pattern` (anchored, `u` flag). Returns `undefined` when it does not compile. */
export function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "u");
  } catch {
    return undefined;
  }
}

/**
 * Problems of the constraints directly on `type` (not recursive). Only `int` / `float` (min,
 * max) and lists (minItems, maxItems) take constraints; what used to be text and media
 * constraints are static fields of the built-in structs.
 */
export function constraintProblems(type: TypeRef): ConstraintProblem[] {
  const out: ConstraintProblem[] = [];
  if (type.kind === "list") {
    checkCount(out, "list", "minItems", type.minItems);
    checkCount(out, "list", "maxItems", type.maxItems);
    checkOrder(out, "list", "minItems", "maxItems", type.minItems, type.maxItems);
    return out;
  }
  if (type.kind !== "primitive") return out;
  const on = type.name;
  const c = (type.constraints ?? {}) as Record<string, unknown>;
  const allowed = ALLOWED[on] ?? [];
  for (const key of Object.keys(c)) {
    if (c[key] === undefined) continue;
    if (!allowed.includes(key)) out.push({ constraint: key, on, reason: `${on} has no constraint "${key}"` });
  }
  if (on === "int") {
    for (const k of ["min", "max"]) {
      const v = c[k];
      if (v !== undefined && !Number.isSafeInteger(v)) out.push({ constraint: k, on, reason: "it must be a whole number" });
    }
    checkOrder(out, on, "min", "max", c["min"], c["max"]);
  }
  if (on === "float") {
    for (const k of ["min", "max"]) {
      const v = c[k];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) out.push({ constraint: k, on, reason: "it must be a finite number" });
    }
    checkOrder(out, on, "min", "max", c["min"], c["max"]);
  }
  return out;
}

/** Problems anywhere inside `type` (recursive). */
export function constraintProblemsDeep(type: TypeRef): ConstraintProblem[] {
  const own = constraintProblems(type);
  if (type.kind === "list" || type.kind === "optional") return [...own, ...constraintProblemsDeep(type.of)];
  return own;
}

/** Message of `type.invalid_constraint` (types.md §11). */
export function constraintMessage(problem: ConstraintProblem, where?: string): string {
  return `Constraint ${problem.constraint} on ${where ?? problem.on} is invalid: ${problem.reason}.`;
}

function checkCount(out: ConstraintProblem[], on: string, key: string, value: unknown): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    out.push({ constraint: key, on, reason: "it must be a whole number >= 0" });
  }
}

function checkOrder(out: ConstraintProblem[], on: string, minKey: string, maxKey: string, min: unknown, max: unknown): void {
  if (typeof min === "number" && typeof max === "number" && min > max) {
    out.push({ constraint: minKey, on, reason: `${minKey} (${min}) is greater than ${maxKey} (${max})` });
  }
}

/**
 * `type.invalid_constraint` diagnostics for every invalid constraint anywhere inside `type`
 * (types.md §6). `where` names the place in messages, e.g. `field "Character.age"`.
 *
 * @example
 * ```ts
 * typeConstraintDiagnostics({ kind: "primitive", name: "int", constraints: { min: 5, max: 1 } }, 'global "limit"');
 * // [{ code: "type.invalid_constraint", message: 'Constraint min on global "limit" is invalid: …' }]
 * ```
 */
export function typeConstraintDiagnostics(type: TypeRef, where: string, at: DiagnosticPath = {}): Diagnostic[] {
  return constraintProblemsDeep(type).map((p) => ({
    severity: "error" as const,
    code: "type.invalid_constraint",
    message: constraintMessage(p, where),
    path: at,
    details: { constraint: p.constraint },
  }));
}
