/**
 * toText rules and template parsing (docs/specs/node-api.md §9).
 */
import { canonicalJson, isValidFieldName, MEDIA_PRIMITIVE_NAMES, NodeError, type PortError, type TypeRef } from "@briarflow/core";

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

type Segment = { literal: string } | { placeholder: string };

function parseTemplate(template: string): Segment[] | PortError {
  const segments: Segment[] = [];
  let literal = "";
  let i = 0;
  while (i < template.length) {
    const ch = template[i];
    if (ch === "{" && template[i + 1] === "{") {
      literal += "{";
      i += 2;
      continue;
    }
    if (ch === "}" && template[i + 1] === "}") {
      literal += "}";
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = template.indexOf("}", i + 1);
      if (end < 0) return { error: { code: "text.invalid_template", message: `Unclosed "{" at position ${i}. Close it with "}" or write "{{" for a literal brace.` } };
      const name = template.slice(i + 1, end);
      if (!isValidFieldName(name)) {
        return {
          error: {
            code: "text.invalid_placeholder",
            message: `"{${name}}" is not a valid placeholder. Use letters, digits and _; start with a letter or _.`,
          },
        };
      }
      if (literal !== "") segments.push({ literal });
      literal = "";
      segments.push({ placeholder: name });
      i = end + 1;
      continue;
    }
    literal += ch;
    i += 1;
  }
  if (literal !== "") segments.push({ literal });
  return segments;
}

/**
 * Placeholders of a `text.template` template in order of first appearance. `{{` / `}}` are
 * literal braces. Returns a `PortError` (`text.invalid_template` for an unclosed brace,
 * `text.invalid_placeholder` for a bad name).
 *
 * @example
 * ```ts
 * templatePlaceholders("Draw {name} in {style} style, {name}!"); // ["name", "style"]
 * ```
 */
export function templatePlaceholders(template: string): string[] | PortError {
  const segments = parseTemplate(template);
  if (!Array.isArray(segments)) return segments;
  const names: string[] = [];
  for (const s of segments) if ("placeholder" in s && !names.includes(s.placeholder)) names.push(s.placeholder);
  return names;
}

/**
 * Renders a template: each `{name}` becomes `valueToText(values[name], types?.[name])`;
 * `{{` / `}}` become literal braces. Throws `NodeError("text.invalid_template")` for an
 * invalid template.
 *
 * @example
 * ```ts
 * renderTemplate("Hi {name} {{ok}}", { name: "Aria" }); // "Hi Aria {ok}"
 * ```
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
  types?: Readonly<Record<string, TypeRef>>,
): string {
  const segments = parseTemplate(template);
  if (!Array.isArray(segments)) throw new NodeError("text.invalid_template", segments.error.message);
  let out = "";
  for (const s of segments) out += "literal" in s ? s.literal : valueToText(values[s.placeholder], types?.[s.placeholder]);
  return out;
}
