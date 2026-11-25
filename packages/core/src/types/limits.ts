/**
 * Checks of the limits that built-in structs keep in static fields (types.md §6): a struct that
 * extends Text or a media struct must give them sensible values.
 */
import { BUILTIN, mediaKindOfBuiltin } from "./builtins.js";
import { compilePattern, type ConstraintProblem } from "./constraints.js";
import type { StructLayout } from "./layout.js";

const count = (out: ConstraintProblem[], on: string, key: string, v: unknown) => {
  if (v === null || v === undefined) return;
  if (!Number.isSafeInteger(v) || (v as number) < 0) out.push({ constraint: key, on, reason: "it must be a whole number >= 0" });
};
const order = (out: ConstraintProblem[], on: string, minKey: string, maxKey: string, min: unknown, max: unknown) => {
  if (typeof min === "number" && typeof max === "number" && min > max) out.push({ constraint: minKey, on, reason: `${minKey} (${min}) is greater than ${maxKey} (${max})` });
};

/** Problems with the limits (static field values) of a struct extending Text or a media struct. */
export function limitProblems(layout: StructLayout): ConstraintProblem[] {
  const out: ConstraintProblem[] = [];
  const v = (k: string) => layout.statics.get(k)?.value;
  if (layout.root === BUILTIN.Text) {
    const on = "Text";
    count(out, on, "minLength", v("minLength"));
    count(out, on, "maxLength", v("maxLength"));
    order(out, on, "minLength", "maxLength", v("minLength"), v("maxLength"));
    const p = v("pattern");
    if (typeof p === "string" && compilePattern(p) === undefined) out.push({ constraint: "pattern", on, reason: `the regular expression ${p} does not compile` });
    return out;
  }
  const kind = mediaKindOfBuiltin(layout.root);
  if (kind === undefined) return out;
  const formats = v("formats");
  if (formats !== undefined && (!Array.isArray(formats) || formats.some((f) => typeof f !== "string" || f.trim() === ""))) {
    out.push({ constraint: "formats", on: kind, reason: "it must be a list of format names or mime types" });
  }
  count(out, kind, "maxBytes", v("maxBytes"));
  for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) count(out, kind, k, v(k));
  order(out, kind, "minWidth", "maxWidth", v("minWidth"), v("maxWidth"));
  order(out, kind, "minHeight", "maxHeight", v("minHeight"), v("maxHeight"));
  const d = v("maxDuration");
  if (d !== null && d !== undefined && (typeof d !== "number" || !Number.isFinite(d) || d < 0)) out.push({ constraint: "maxDuration", on: kind, reason: "it must be a number >= 0" });
  return out;
}
