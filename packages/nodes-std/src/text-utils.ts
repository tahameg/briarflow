/**
 * toText rules and template parsing (docs/specs/node-api.md §9).
 */
import { canonicalJson, isValidFieldName, MEDIA_PRIMITIVE_NAMES, NodeError, type PortError, type TypeRef } from "@briarflow/core";
import { getAt, parsePath, type PathSegment } from "./json-path.js";

const MEDIA_REF_KEYS = new Set(["uri", "mime", "bytes", "hash", "meta"]);

function looksLikeMediaRef(value: object): value is { uri: string } {
  if (Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec["uri"] !== "string" || typeof rec["mime"] !== "string") return false;
  return Object.keys(rec).every((k) => MEDIA_REF_KEYS.has(k));
}

/**
 * Renders a value as text (node-api.md §9 toText rules): text as is, numbers via `String()`,
 * booleans `"true"`/`"false"`, enum → member value, `null` → `""`, media → its `uri`,
 * struct/list → canonical JSON (sorted keys, no spaces). Pass the value's type when known so
 * a struct that happens to look like a MediaRef is not mistaken for one.
 *
 * @example
 * ```ts
 * valueToText({ b: 1, a: "x" }); // '{"a":"x","b":1}'
 * valueToText(null);             // ""
 * ```
 */
export function valueToText(value: unknown, type?: TypeRef): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);
  const inner = type?.kind === "optional" ? type.of : type;
  if (inner?.kind === "primitive" && (MEDIA_PRIMITIVE_NAMES as readonly string[]).includes(inner.name)) {
    const uri = (value as { uri?: unknown }).uri;
    if (typeof uri === "string") return uri;
  }
  if ((inner === undefined || inner.kind === "var") && looksLikeMediaRef(value)) return value.uri;
  return canonicalJson(value);
}

/** A `{{…}}` slot: a node input (`{{name}}`, `{{name.path}}`) or a variable (`{{$(name)}}`). */
interface Slot {
  kind: "input" | "variable";
  name: string;
  path: PathSegment[];
}

type Segment = { literal: string } | { slot: Slot };

const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]*/;

function badSlot(expr: string, why: string): PortError {
  return { error: { code: "text.invalid_placeholder", message: `"{{${expr}}}" is not a valid placeholder: ${why}` } };
}

function parseSlot(raw: string): Slot | PortError {
  const expr = raw.trim();
  let kind: Slot["kind"];
  let name: string;
  let rest: string;
  if (expr.startsWith("$(")) {
    const close = expr.indexOf(")");
    if (close < 0) return badSlot(expr, 'close the variable name with ")", e.g. {{$(user)}}.');
    kind = "variable";
    name = expr.slice(2, close).trim();
    if (name === "") return badSlot(expr, "write a variable name inside $( ).");
    rest = expr.slice(close + 1).trim();
  } else {
    const m = INPUT_NAME.exec(expr);
    if (!m || !isValidFieldName(m[0])) return badSlot(expr, "use letters, digits and _; start with a letter or _. Variables are written {{$(name)}}.");
    kind = "input";
    name = m[0];
    rest = expr.slice(m[0].length).trim();
  }
  if (rest === "") return { kind, name, path: [] };
  if (rest[0] !== "." && rest[0] !== "[") return badSlot(expr, `unexpected "${rest}". A field path starts with "." or "[".`);
  const path = parsePath(rest[0] === "." ? rest.slice(1) : rest);
  if (!Array.isArray(path)) return badSlot(expr, path.problem);
  if (path.length === 0) return badSlot(expr, 'write a field name after ".".');
  return { kind, name, path };
}

function parseTemplate(template: string): Segment[] | PortError {
  const segments: Segment[] = [];
  let literal = "";
  let i = 0;
  while (i < template.length) {
    if (template.startsWith("\\{{", i)) {
      literal += "{{";
      i += 3;
      continue;
    }
    if (template.startsWith("{{", i)) {
      const end = template.indexOf("}}", i + 2);
      if (end < 0) {
        return { error: { code: "text.invalid_template", message: `Unclosed "{{" at position ${i}. Close it with "}}" or write \\{{ for literal braces.` } };
      }
      const slot = parseSlot(template.slice(i + 2, end));
      if ("error" in slot) return slot;
      if (literal !== "") segments.push({ literal });
      literal = "";
      segments.push({ slot });
      i = end + 2;
      continue;
    }
    literal += template[i];
    i += 1;
  }
  if (literal !== "") segments.push({ literal });
  return segments;
}

/** What a template needs: its input pins (in order of first appearance) and the variables it reads. */
export interface TemplateNeeds {
  /** `json` when the template reads a field path of it (`{{user.name}}`), else any type (rendered with toText). */
  inputs: { name: string; json: boolean }[];
  /** Names inside `{{$(…)}}`: flow variables first, then globals. */
  variables: string[];
}

/**
 * Inputs and variables of a Template builder template. `{{name}}` is an input of any type,
 * `{{name.field[0]}}` makes `name` a json input, `{{$(name)}}` reads a variable (no input),
 * `\{{` is a literal `{{`. Returns a `PortError` (`text.invalid_template` for an unclosed
 * `{{`, `text.invalid_placeholder` for a bad slot).
 *
 * @example
 * ```ts
 * templatePlaceholders("Hi {{name}} from {{user.city}} {{$(greeting)}}");
 * // { inputs: [{ name: "name", json: false }, { name: "user", json: true }], variables: ["greeting"] }
 * ```
 */
export function templatePlaceholders(template: string): TemplateNeeds | PortError {
  const segments = parseTemplate(template);
  if (!Array.isArray(segments)) return segments;
  const needs: TemplateNeeds = { inputs: [], variables: [] };
  for (const s of segments) {
    if (!("slot" in s)) continue;
    const { kind, name, path } = s.slot;
    if (kind === "variable") {
      if (!needs.variables.includes(name)) needs.variables.push(name);
      continue;
    }
    const known = needs.inputs.find((x) => x.name === name);
    if (known) known.json ||= path.length > 0;
    else needs.inputs.push({ name, json: path.length > 0 });
  }
  return needs;
}

/**
 * Renders a template with the toText rules. Input slots read `values` (with their bound
 * `types` when known), variable slots call `variable(name)`; a field path that does not exist
 * throws `NodeError("json.field_missing")`.
 * Throws `NodeError("text.invalid_template")` for an invalid template.
 *
 * @example
 * ```ts
 * renderTemplate("Hi {{name}}, {{user.age}} \\{{ok}}", { name: "Aria", user: { age: 9 } }); // "Hi Aria, 9 {{ok}}"
 * ```
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
  types?: Readonly<Record<string, TypeRef>>,
  variable: (name: string) => unknown = (name) => {
    throw new NodeError("variable.unknown", `Variable "${name}" is not available here.`);
  },
): string {
  const segments = parseTemplate(template);
  if (!Array.isArray(segments)) throw new NodeError("text.invalid_template", segments.error.message);
  let out = "";
  for (const s of segments) {
    if ("literal" in s) {
      out += s.literal;
      continue;
    }
    const { kind, name, path } = s.slot;
    if (path.length > 0) out += valueToText(getAt(kind === "variable" ? variable(name) : values[name], path));
    else out += kind === "variable" ? valueToText(variable(name)) : valueToText(values[name], types?.[name]);
  }
  return out;
}
