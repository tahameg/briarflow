/**
 * Rules of one struct declaration (types.md §1.3): its `extends`, its static fields and the
 * limits they set. Used by validation and by the authoring commands, so both say the same.
 */
import type { StructDecl } from "../documents/model.js";
import { constraintMessage } from "../types/constraints.js";
import { extendsProblems, structLayout, type ExtendsProblem } from "../types/layout.js";
import { limitProblems } from "../types/limits.js";
import type { TypeScope } from "../types/scope.js";
import type { Diagnostic, DiagnosticPath } from "./diagnostic.js";

/**
 * Problems with `extends`, static fields without a value, and Text / media limits that cannot
 * hold. Limits are checked only when `extends` is fine.
 *
 * @example
 * ```ts
 * structProblems(shortText, scope, { typeId: shortText.id }); // [] when maxLength is fine
 * ```
 */
export function structProblems(t: StructDecl, scope: TypeScope, at: DiagnosticPath): Diagnostic[] {
  const out: Diagnostic[] = [];
  const resolve = (id: string) => scope.getType(id)?.decl;
  const issues = extendsProblems(t, resolve);
  for (const p of issues) out.push(extendsDiagnostic(p, t, at, scope));
  for (const f of t.fields) {
    if (f.static && f.default === undefined && f.type.kind !== "optional") {
      out.push({
        severity: "error",
        code: "type.static_without_value",
        message: `Static field "${t.name}.${f.name}" has no value. Give it one, or make its type optional.`,
        path: { ...at, field: f.name },
      });
    }
  }
  if (issues.length === 0) {
    for (const p of limitProblems(structLayout(t, resolve))) {
      out.push({
        severity: "error",
        code: "type.invalid_constraint",
        message: constraintMessage(p, `"${t.name}"`),
        path: { ...at, field: p.constraint },
        details: { constraint: p.constraint },
      });
    }
  }
  return out;
}

function extendsDiagnostic(p: ExtendsProblem, t: StructDecl, at: DiagnosticPath, scope: TypeScope): Diagnostic {
  const target = p.target === undefined ? "" : (scope.getType(p.target)?.decl.name ?? p.target);
  const message = {
    "type.extends_unknown": `"${t.name}" extends type id ${p.target ?? ""}, which no longer exists. Pick another struct.`,
    "type.extends_not_struct": `"${t.name}" extends "${target}", which is not a struct. Only structs can be extended.`,
    "type.extends_cycle": `"${t.name}" extends itself through ${(p.chain ?? []).map((id) => scope.getType(id)?.decl.name ?? id).join(" → ")}.`,
    "type.extends_instance_field": `"${t.name}.${p.field ?? ""}" is not static. A struct that extends another may only add or set static fields.`,
    "type.extends_override": `"${t.name}.${p.field ?? ""}" sets an inherited static field with another type. Keep the type it has in the base.`,
  }[p.code];
  return {
    severity: "error",
    code: p.code,
    message,
    path: p.field === undefined ? at : { ...at, field: p.field },
    ...(p.target === undefined ? {} : { details: { id: p.target } }),
  };
}
