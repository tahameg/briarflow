/**
 * Structured output schema (phase-8.md §4.3): a provider-safe JSON Schema for a struct type,
 * built with core `toJsonSchema` over a `TypeScope` adapter of `ctx.resolveType`.
 */
import { NodeError, toJsonSchema, type TypeDecl, type TypeRef, type TypeScope } from "@briarflow/core";

type Json = Record<string, unknown>;

/** Keywords the structured-output API rejects; kept as a description hint instead. */
const HINT_KEYWORDS = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern"];
const DROP_KEYWORDS = ["$schema", "default", "format", "$id"];

/** A `TypeScope` that only knows `getType`, backed by the engine's type lookup. */
export function scopeFromResolver(resolve: (id: string) => TypeDecl | undefined): TypeScope {
  return {
    flowId: undefined,
    getType: (id) => {
      const decl = resolve(id);
      return decl ? { decl, origin: "global" } : undefined;
    },
    resolveName: () => ({ ok: false, code: "type.unknown", candidates: [] }),
    all: () => [],
  };
}

/** Throws `anthropic.unsupported_type` when the type contains media anywhere. */
export function assertNoMedia(type: TypeRef, scope: TypeScope, path = "value", seen = new Set<string>()): void {
  switch (type.kind) {
    case "primitive":
      if (["image", "video", "audio", "model3d", "file"].includes(type.name)) {
        throw new NodeError(
          "anthropic.unsupported_type",
          `Claude cannot produce ${type.name} values (field ${path}). Use text fields (e.g. a prompt or a URL) instead.`,
          { retryable: false, details: { path } },
        );
      }
      return;
    case "optional":
      return assertNoMedia(type.of, scope, path, seen);
    case "list":
      return assertNoMedia(type.of, scope, `${path}[]`, seen);
    case "named": {
      if (seen.has(type.id)) return;
      seen.add(type.id);
      const decl = scope.getType(type.id)?.decl;
      if (decl?.kind === "struct") for (const f of decl.fields) assertNoMedia(f.type, scope, `${path}.${f.name}`, seen);
      return;
    }
    default:
      return;
  }
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (typeof node !== "object" || node === null) return node;
  const out: Json = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node as Json)) {
    if (key.startsWith("x-") || DROP_KEYWORDS.includes(key)) continue;
    if (HINT_KEYWORDS.includes(key)) {
      hints.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    out[key] = clean(value);
  }
  if (hints.length > 0) {
    const prefix = typeof out["description"] === "string" ? `${out["description"]} ` : "";
    out["description"] = `${prefix}(${hints.join(", ")})`;
  }
  return out;
}

/** Inlines a root `$ref` into `#/$defs/…` so the root schema is an object. */
function inlineRoot(schema: Json): Json {
  const ref = schema["$ref"];
  const defs = schema["$defs"] as Record<string, Json> | undefined;
  if (typeof ref !== "string" || !defs) return schema;
  const name = ref.replace(/^#\/\$defs\//, "");
  const target = defs[name];
  if (!target) return schema;
  const { $ref: _ref, ...rest } = schema;
  return { ...rest, ...target };
}

/**
 * JSON Schema for the struct `typeId`, safe for `output_config.format`.
 *
 * @example
 * ```ts
 * const schema = structuredSchema("ty_char", (id) => ctx.resolveType(id));
 * ```
 */
export function structuredSchema(typeId: string, resolve: (id: string) => TypeDecl | undefined): { schema: Json; scope: TypeScope; type: TypeRef } {
  const decl = resolve(typeId);
  if (!decl || decl.kind !== "struct") {
    throw new NodeError("anthropic.unknown_type", `Struct type "${typeId}" does not exist in this flow. Pick a struct type in the node config.`, {
      retryable: false,
      details: { typeId },
    });
  }
  const scope = scopeFromResolver(resolve);
  const type: TypeRef = { kind: "named", id: decl.id };
  assertNoMedia(type, scope);
  const schema = inlineRoot(clean(toJsonSchema(type, scope, { strict: true })) as Json);
  return { schema, scope, type };
}
