/**
 * Internal: value checks of node inputs/outputs and run inputs.
 */
import { containsVar, formatType, normalizeValue, type Diagnostic, type FlowDocument, type TypeRef, type TypeScope } from "@briarflow/core";

/** Normalized value or diagnostics. Types with unbound generics are not checked. */
export function checkPortValue(
  value: unknown,
  type: TypeRef,
  scope: TypeScope,
  path: string,
  at: Diagnostic["path"],
): { ok: true; value: unknown } | { ok: false; diagnostics: Diagnostic[] } {
  if (containsVar(type)) return { ok: true, value: value === undefined ? null : value };
  return normalizeValue(value, type, scope, { path, at });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates and normalizes run inputs against the flow signature (runtime.md §2.1 step 3). */
export function normalizeRunInputs(
  flow: FlowDocument,
  inputs: unknown,
  scope: TypeScope,
): { ok: true; values: Record<string, unknown> } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const at = { flowId: flow.id };
  const invalid = (valuePath: string, message: string) =>
    diagnostics.push({ severity: "error", code: "value.invalid", message, path: { ...at, valuePath } });
  if (inputs !== undefined && !isPlainObject(inputs)) {
    invalid("inputs", "inputs must be an object of input name → value");
    return { ok: false, diagnostics };
  }
  const given = inputs ?? {};
  const known = flow.inputs.map((f) => f.name);
  for (const key of Object.keys(given)) {
    if (given[key] !== undefined && !known.includes(key)) {
      invalid(
        `inputs.${key}`,
        `inputs.${key} is not an input of flow "${flow.name}". ${known.length > 0 ? `Known inputs: ${known.join(", ")}` : "The flow has no inputs"}`,
      );
    }
  }
  const values: Record<string, unknown> = {};
  for (const field of flow.inputs) {
    let value = given[field.name];
    if (value === undefined) {
      if (field.default !== undefined) value = field.default;
      else if (field.type.kind === "optional") value = null;
      else {
        invalid(
          `inputs.${field.name}`,
          `inputs.${field.name} is required. Pass a value of type ${formatType(field.type, scope)} or give the input a default.`,
        );
        continue;
      }
    }
    const r = normalizeValue(value, field.type, scope, { path: `inputs.${field.name}`, at });
    if (r.ok) values[field.name] = r.value;
    else diagnostics.push(...r.diagnostics);
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, values };
}
