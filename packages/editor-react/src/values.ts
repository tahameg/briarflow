/**
 * Pure helpers for value widgets: which widget a type gets, starting values and short
 * previews.
 */
import { MEDIA_PRIMITIVE_NAMES, isMediaRef } from "@briarflow/core";
import type { MediaRef, TypeRef, TypeScope } from "@briarflow/core";

/** Widget kinds of the constant / input editors (design-system.md §7). */
export type WidgetKind = "text" | "int" | "float" | "boolean" | "json" | "secret" | "enum" | "media" | "struct" | "list" | "optional" | "unbound" | "unknown";

/** Widget kind of a type. */
export function widgetKind(type: TypeRef, scope: TypeScope | undefined): WidgetKind {
  switch (type.kind) {
    case "primitive":
      if ((MEDIA_PRIMITIVE_NAMES as readonly string[]).includes(type.name)) return "media";
      return type.name as "text" | "int" | "float" | "boolean" | "json" | "secret";
    case "named": {
      const decl = scope?.getType(type.id)?.decl;
      if (!decl) return "unknown";
      return decl.kind === "enum" ? "enum" : "struct";
    }
    case "list":
      return "list";
    case "optional":
      return "optional";
    case "var":
      return "unbound";
  }
}

/**
 * A reasonable starting value for a type (used when the user ticks an optional's "set" box
 * or adds a flow input default).
 */
export function initialValue(type: TypeRef, scope: TypeScope | undefined): unknown {
  switch (type.kind) {
    case "primitive":
      if (type.name === "text") return "";
      if (type.name === "int" || type.name === "float") return type.constraints?.min ?? 0;
      if (type.name === "boolean") return false;
      if (type.name === "json") return {};
      return null;
    case "named": {
      const decl = scope?.getType(type.id)?.decl;
      if (!decl) return null;
      if (decl.kind === "enum") return decl.members[0]?.value ?? null;
      const out: Record<string, unknown> = {};
      for (const f of decl.fields) out[f.name] = f.default !== undefined ? f.default : initialValue(f.type, scope);
      return out;
    }
    case "list":
      return [];
    case "optional":
      return null;
    case "var":
      return null;
  }
}

export { isMediaRef };

/** Browser URL of a media value (`mediaUrl(id)`; the server redirects links to the web). */
export function mediaHref(ref: MediaRef, mediaUrl: ((mediaId: string) => string) | undefined): string | undefined {
  return mediaUrl ? mediaUrl(ref.mediaId) : undefined;
}

/** One-line preview of a value (code font). */
export function previewValue(value: unknown, max = 60): string {
  let s: string;
  if (value === undefined) s = "—";
  else if (value === null) s = "none";
  else if (typeof value === "string") s = JSON.stringify(value);
  else if (isMediaRef(value)) s = `media ${value.mediaId}`;
  else s = JSON.stringify(value) ?? String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `1234` → `1.2 KB`. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `850` → `850ms`, `1234` → `1.2s`. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** "line 2, column 5" of the first JSON syntax error in `source`, or undefined when it parses. */
export function jsonErrorLocation(source: string): string | undefined {
  const offset = jsonErrorOffset(source);
  if (offset === undefined) return undefined;
  const lines = source.slice(0, offset).split("\n");
  return `line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1}`;
}

/** Offset of the first JSON syntax error (engines' messages do not always include one). */
function jsonErrorOffset(src: string): number | undefined {
  let i = 0;
  const ws = () => {
    while (i < src.length && " \t\n\r".includes(src[i] as string)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const literal = (word: string) => {
    if (src.startsWith(word, i)) i += word.length;
    else fail();
  };
  const string = () => {
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\n") fail();
      i += src[i] === "\\" ? 2 : 1;
    }
    if (i >= src.length) fail();
    i++;
  };
  const value = (): void => {
    ws();
    const c = src[i];
    if (c === "{") {
      i++;
      ws();
      if (src[i] === "}") return void i++;
      for (;;) {
        ws();
        if (src[i] !== '"') fail();
        string();
        ws();
        if (src[i] !== ":") fail();
        i++;
        value();
        ws();
        if (src[i] === ",") i++;
        else if (src[i] === "}") return void i++;
        else fail();
      }
    } else if (c === "[") {
      i++;
      ws();
      if (src[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (src[i] === ",") i++;
        else if (src[i] === "]") return void i++;
        else fail();
      }
    } else if (c === '"') string();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else {
      const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m || m[0] === "") fail();
      i += (m as RegExpExecArray)[0].length;
    }
  };
  try {
    value();
    ws();
    return i < src.length ? i : undefined;
  } catch (at) {
    return typeof at === "number" ? Math.min(at, src.length) : undefined;
  }
}
