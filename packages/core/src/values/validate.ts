/**
 * Value validation and normalization (docs/specs/types.md §6–§8).
 */
import type { Diagnostic, DiagnosticPath } from "../validation/diagnostic.js";
import type { MediaPrimitiveName, PrimitiveTypeRef, TypeRef } from "../types/ir.js";
import { MEDIA_PRIMITIVE_NAMES } from "../types/ir.js";
import { compilePattern } from "../types/constraints.js";
import { describe, validateMediaRef } from "../types/media.js";
import type { TypeScope } from "../types/scope.js";
import { cloneJson } from "../util/json.js";
import { isValidSecretName } from "../util/names.js";

/** Options of {@link validateValue} / {@link normalizeValue}. */
export interface ValueCheckOptions {
  /** Root of the value path used in messages and `path.valuePath`, e.g. `"inputs.character"`. Default `"value"`. */
  path?: string;
  /** Extra keys merged into every diagnostic's `path` (e.g. `{ flowId, nodeId, port }`). */
  at?: DiagnosticPath;
  /** Check constraints (default `true`). `false` checks only the JSON shape and kinds. */
  constraints?: boolean;
}

/** Internal options: definition-time checks where named types / vars cannot be resolved yet. */
export interface InternalValueCheckOptions extends ValueCheckOptions {
  /** Accept any value for named ids the scope does not know (definition time). */
  lenientUnknownNamed?: boolean;
  /** Accept any value for `var` types (definition time). */
  lenientVars?: boolean;
}

/**
 * Validates a JSON value against a type. Returns all findings (empty = valid). Code
 * `value.invalid` (and `media.*` for media refs) with messages like
 * `inputs.character.age must be >= 0`. A `var` anywhere in `type` → `value.generic_unbound`.
 * Omitted optional/defaulted struct fields are valid (types.md Deviation 1).
 *
 * @example
 * ```ts
 * validateValue({ name: "Aria", age: -1 }, { kind: "named", id: "ty_char" }, scope, { path: "inputs.character" });
 * // [{ severity: "error", code: "value.invalid", message: "inputs.character.age must be >= 0", … }]
 * ```
 */
export function validateValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): Diagnostic[] {
  return checkValue(value, type, scope, options ?? {}).diagnostics;
}

/** Result of {@link normalizeValue}. */
export type NormalizeResult =
  | { ok: true; value: unknown }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Validates and returns the canonical form: every struct field present (omitted optional →
 * `null`, omitted defaulted → default), `undefined` optional → `null`. Never mutates `value`.
 *
 * @example
 * ```ts
 * normalizeValue({ name: "Aria" }, characterRef, scope);
 * // { ok: true, value: { name: "Aria", nickname: null, age: 30 } }
 * ```
 */
export function normalizeValue(value: unknown, type: TypeRef, scope: TypeScope, options?: ValueCheckOptions): NormalizeResult {
  const r = checkValue(value, type, scope, options ?? {});
  return r.diagnostics.length > 0 ? { ok: false, diagnostics: r.diagnostics } : { ok: true, value: r.value };
}

/** Internal: validation + normalization in one pass. */
export function checkValue(
  value: unknown,
  type: TypeRef,
  scope: TypeScope,
  options: InternalValueCheckOptions,
): { value: unknown; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const checker = new Checker(scope, options, diagnostics);
  const out = checker.check(value, type, options.path ?? "value");
  return { value: out, diagnostics };
}

class Checker {
  private readonly constraints: boolean;
  constructor(
    private readonly scope: TypeScope,
    private readonly options: InternalValueCheckOptions,
    private readonly diagnostics: Diagnostic[],
  ) {
    this.constraints = options.constraints !== false;
  }

  private report(code: string, message: string, path: string, details?: unknown): void {
    const d: Diagnostic = { severity: "error", code, message, path: { ...this.options.at, valuePath: path } };
    if (details !== undefined) d.details = details;
    this.diagnostics.push(d);
  }

  private invalid(path: string, suffix: string): void {
    this.report("value.invalid", `${path} ${suffix}`, path);
  }

  check(value: unknown, type: TypeRef, path: string): unknown {
    if (type.kind === "optional") {
      if (value === null || value === undefined) return null;
      return this.check(value, type.of, path);
    }
    if (type.kind === "var") {
      if (this.options.lenientVars) return value;
      this.report(
        "value.generic_unbound",
        `Cannot set a constant on "${path}" before its type is known. Connect an input first.`,
        path,
        { varName: type.name },
      );
      return value;
    }
    if (value === undefined) {
      this.invalid(path, "is required");
      return value;
    }
    switch (type.kind) {
      case "primitive":
        return this.primitive(value, type, path);
      case "list":
        return this.list(value, type, path);
      case "named":
        return this.named(value, type.id, path);
    }
  }

  private list(value: unknown, type: Extract<TypeRef, { kind: "list" }>, path: string): unknown {
    if (!Array.isArray(value)) {
      this.invalid(path, `must be a list (got ${describe(value)})`);
      return value;
    }
    if (this.constraints) {
      if (type.minItems !== undefined && value.length < type.minItems) this.invalid(path, `must have at least ${type.minItems} items`);
      if (type.maxItems !== undefined && value.length > type.maxItems) this.invalid(path, `must have at most ${type.maxItems} items`);
    }
    let changed = false;
    const out = value.map((item, i) => {
      const n = this.check(item, type.of, `${path}[${i}]`);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : value;
  }

  private named(value: unknown, id: string, path: string): unknown {
    const entry = this.scope.getType(id);
    if (!entry) {
      if (this.options.lenientUnknownNamed) return value;
      this.report("type.unknown_id", `${path} refers to type id ${id}, which no longer exists. Pick another type.`, path, { id });
      return value;
    }
    const decl = entry.decl;
    if (decl.kind === "enum") {
      const values = decl.members.map((m) => m.value);
      if (typeof value !== "string" || !values.includes(value)) {
        this.invalid(path, `must be one of ${values.join(", ")} (got ${describe(value)})`);
      }
      return value;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.invalid(path, `must be an object with the fields of ${decl.name} (got ${describe(value)})`);
      return value;
    }
    const obj = value as Record<string, unknown>;
    const known = decl.fields.map((f) => f.name);
    for (const key of Object.keys(obj)) {
      if (obj[key] !== undefined && !known.includes(key)) {
        this.invalid(`${path}.${key}`, `is not a field of ${decl.name}. Known fields: ${known.join(", ")}`);
      }
    }
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const field of decl.fields) {
      const fieldPath = `${path}.${field.name}`;
      const present = Object.prototype.hasOwnProperty.call(obj, field.name) && obj[field.name] !== undefined;
      if (!present) {
        changed = true;
        if (Object.prototype.hasOwnProperty.call(field, "default") && field.default !== undefined) {
          out[field.name] = cloneJson(field.default);
        } else if (field.type.kind === "optional") {
          out[field.name] = null;
        } else {
          this.invalid(fieldPath, "is required");
        }
        continue;
      }
      const v = obj[field.name];
      const n = this.check(v, field.type, fieldPath);
      if (n !== v) changed = true;
      out[field.name] = n;
    }
    if (!changed && Object.keys(obj).length === decl.fields.length) return value;
    return out;
  }

  private primitive(value: unknown, type: PrimitiveTypeRef, path: string): unknown {
    const c = (this.constraints ? type.constraints : undefined) as Record<string, unknown> | undefined;
    switch (type.name) {
      case "text": {
        if (typeof value !== "string") {
          this.invalid(path, `must be text (got ${describe(value)})`);
          return value;
        }
        if (c) {
          const length = [...value].length;
          const min = c["minLength"];
          const max = c["maxLength"];
          if (typeof min === "number" && length < min) this.invalid(path, `must be at least ${min} characters long`);
          if (typeof max === "number" && length > max) this.invalid(path, `must be at most ${max} characters long`);
          const pattern = c["pattern"];
          if (typeof pattern === "string") {
            const re = compilePattern(pattern);
            if (re && !re.test(value)) this.invalid(path, `must match the pattern ${pattern}`);
          }
        }
        return value;
      }
      case "int":
      case "float": {
        if (type.name === "int" ? !Number.isSafeInteger(value) : typeof value !== "number" || !Number.isFinite(value)) {
          this.invalid(path, `${type.name === "int" ? "must be a whole number" : "must be a number"} (got ${describe(value)})`);
          return value;
        }
        if (c) {
          const n = value as number;
          const min = c["min"];
          const max = c["max"];
          if (typeof min === "number" && n < min) this.invalid(path, `must be >= ${min}`);
          if (typeof max === "number" && n > max) this.invalid(path, `must be <= ${max}`);
        }
        return value;
      }
      case "boolean":
        if (typeof value !== "boolean") this.invalid(path, `must be true or false (got ${describe(value)})`);
        return value;
      case "json": {
        const problem = jsonProblem(value);
        if (problem !== undefined) this.invalid(path, `must be JSON: ${problem}`);
        return value;
      }
      case "secret":
        if (typeof value !== "string" || !isValidSecretName(value)) this.invalid(path, `must be the name of a secret (got ${describe(value)})`);
        return value;
      case "error": {
        const e = value as Record<string, unknown> | null;
        if (typeof e !== "object" || e === null || Array.isArray(e) || typeof e["code"] !== "string" || typeof e["message"] !== "string") {
          this.invalid(path, `must be an error { code, message } (got ${describe(value)})`);
        }
        return value;
      }
      default:
        return this.media(value, type.name, path);
    }
  }

  /** Shape only: the entry's mime and the constraints are checked when a node reads it (media.md §4). */
  private media(value: unknown, kind: MediaPrimitiveName, path: string): unknown {
    if (!MEDIA_PRIMITIVE_NAMES.includes(kind)) return value;
    for (const p of validateMediaRef(value, kind, path)) this.diagnostics.push({ ...p, path: { ...this.options.at, ...p.path } });
    return value;
  }
}

/** Why a value is not plain JSON (undefined, functions, non-finite numbers, cycles…), or undefined. */
function jsonProblem(value: unknown, seen: Set<object> = new Set()): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${String(value)} is not a JSON number`;
  if (typeof value !== "object") return `${typeof value} is not a JSON value`;
  if (seen.has(value)) return "it contains a circular reference";
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    const p = jsonProblem(item, seen);
    if (p !== undefined) return p;
  }
  seen.delete(value);
  return undefined;
}
