/**
 * JSON Schema export (docs/specs/types.md §9). Draft 2020-12.
 */
import type { ContextDocument, FieldDecl, TypeDecl } from "../documents/model.js";
import { TypeDefinitionError } from "../errors.js";
import type { MediaPrimitiveName, TypeRef } from "../types/ir.js";
import { formatToMime } from "../types/media.js";
import type { PackTypeSource, TypeOrigin, TypeScope } from "../types/scope.js";
import { scopeForFlow } from "../types/scope.js";

/** A JSON Schema object. */
export type JsonSchema = { [keyword: string]: unknown };

/** Options of {@link toJsonSchema}. */
export interface JsonSchemaOptions {
  /**
   * LLM structured-output mode: every property `required`, no `default`, no
   * `pattern`/`format`; optionals stay `anyOf [..., null]`.
   */
  strict?: boolean;
}

const SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";

const MIME_PATTERNS: Record<MediaPrimitiveName, string | undefined> = {
  image: "^image/",
  video: "^video/",
  audio: "^audio/",
  model3d: "^(model/|application/octet-stream$)",
  file: undefined,
};

/**
 * Compiles a type to one schema with `$schema` and `$defs` (named types; `MediaRef` once when
 * media is used). Throws `TypeDefinitionError("type.var_not_allowed")` for vars and
 * `TypeDefinitionError("type.unknown_id")` for unknown ids.
 *
 * @example
 * ```ts
 * toJsonSchema({ kind: "list", of: { kind: "primitive", name: "text" } }, scope);
 * // { $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", items: { type: "string" } }
 * ```
 */
export function toJsonSchema(type: TypeRef, scope: TypeScope, options: JsonSchemaOptions = {}): JsonSchema {
  const c = new SchemaCompiler(scope, options.strict === true);
  c.plan([type]);
  return c.root(c.compile(type));
}

/** Signature schemas of a flow: two object schemas (`required` = non-optional, no default). */
export interface FlowSignatureSchema {
  inputs: JsonSchema;
  outputs: JsonSchema;
}

/**
 * Compiles a flow's input/output signature (used by `GET /flows/:id` and OpenAPI).
 * Throws `BriarError("flow.not_found")` for an unknown flow.
 *
 * @example
 * ```ts
 * const { inputs, outputs } = flowSignatureSchema(doc, "flow_p", catalog);
 * ```
 */
export function flowSignatureSchema(
  doc: ContextDocument,
  flowId: string,
  packTypes?: PackTypeSource,
  options: JsonSchemaOptions = {},
): FlowSignatureSchema {
  const scope = scopeForFlow(doc, flowId, packTypes);
  const flow = doc.flows.find((f) => f.id === flowId);
  const build = (fields: readonly FieldDecl[]): JsonSchema => {
    const c = new SchemaCompiler(scope, options.strict === true);
    c.plan(fields.map((f) => f.type));
    return c.root(c.object(fields));
  };
  return { inputs: build(flow?.inputs ?? []), outputs: build(flow?.outputs ?? []) };
}

class SchemaCompiler {
  private readonly defs = new Map<string, JsonSchema>();
  private readonly keys = new Map<string, string>();
  private media = false;

  constructor(
    private readonly scope: TypeScope,
    private readonly strict: boolean,
  ) {}

  /** Assigns `$defs` keys to every reachable named type (collisions → `Name__id`). */
  plan(types: readonly TypeRef[]): void {
    const reached = new Map<string, { decl: TypeDecl; origin: TypeOrigin }>();
    const visit = (t: TypeRef): void => {
      if (t.kind === "list" || t.kind === "optional") return visit(t.of);
      if (t.kind !== "named" || reached.has(t.id)) return;
      const entry = this.scope.getType(t.id);
      if (!entry) return;
      reached.set(t.id, entry);
      if (entry.decl.kind === "struct") for (const f of entry.decl.fields) visit(f.type);
    };
    types.forEach(visit);
    const byKey = new Map<string, string[]>();
    for (const [id, { decl, origin }] of reached) {
      const key = origin === "pack" ? decl.id : decl.name;
      byKey.set(key, [...(byKey.get(key) ?? []), id]);
    }
    for (const [key, ids] of byKey) {
      if (ids.length === 1) {
        this.keys.set(ids[0] as string, key);
        continue;
      }
      // The widest-scope one keeps the plain name; narrower ones get Name__id.
      const rank = (id: string) => ({ pack: 0, global: 1, local: 2 })[reached.get(id)?.origin ?? "local"];
      const sorted = [...ids].sort((a, b) => rank(a) - rank(b));
      sorted.forEach((id, i) => this.keys.set(id, i === 0 ? key : `${key}__${id}`));
    }
  }

  root(schema: JsonSchema): JsonSchema {
    const out: JsonSchema = { $schema: SCHEMA_URI, ...schema };
    if (this.media) this.defs.set("MediaRef", this.mediaRefDef());
    if (this.defs.size > 0) {
      const defs: JsonSchema = {};
      for (const key of [...this.defs.keys()].sort()) defs[key] = this.defs.get(key);
      out["$defs"] = defs;
    }
    return out;
  }

  compile(type: TypeRef): JsonSchema {
    switch (type.kind) {
      case "var":
        throw new TypeDefinitionError("type.var_not_allowed", `Generic type "$${type.name}" can only be used in node definitions.`);
      case "optional":
        return { anyOf: [this.compile(type.of), { type: "null" }] };
      case "list": {
        const s: JsonSchema = { type: "array", items: this.compile(type.of) };
        if (type.minItems !== undefined) s["minItems"] = type.minItems;
        if (type.maxItems !== undefined) s["maxItems"] = type.maxItems;
        return s;
      }
      case "named":
        return this.named(type.id);
      case "primitive": {
        const c = (type.constraints ?? {}) as Record<string, unknown>;
        switch (type.name) {
          case "text": {
            const s: JsonSchema = { type: "string" };
            if (c["minLength"] !== undefined) s["minLength"] = c["minLength"];
            if (c["maxLength"] !== undefined) s["maxLength"] = c["maxLength"];
            if (c["pattern"] !== undefined && !this.strict) s["pattern"] = `^(?:${String(c["pattern"])})$`;
            return s;
          }
          case "int":
          case "float": {
            const s: JsonSchema = { type: type.name === "int" ? "integer" : "number" };
            if (c["min"] !== undefined) s["minimum"] = c["min"];
            if (c["max"] !== undefined) s["maximum"] = c["max"];
            return s;
          }
          case "boolean":
            return { type: "boolean" };
          case "error":
            return {
              type: "object",
              required: ["code", "message"],
              properties: { code: { type: "string" }, message: { type: "string" }, nodeId: { type: "string" }, node: { type: "string" }, details: {} },
            };
          default: {
            this.media = true;
            const ref = { $ref: "#/$defs/MediaRef" };
            const formats = c["formats"];
            if (Array.isArray(formats) && formats.length > 0) {
              const mimes = [...new Set(formats.map((f) => formatToMime(String(f))))];
              return { allOf: [ref, { properties: { mime: { enum: mimes } } }] };
            }
            const pattern = MIME_PATTERNS[type.name];
            if (pattern === undefined || this.strict) return ref;
            return { allOf: [ref, { properties: { mime: { pattern } } }] };
          }
        }
      }
    }
  }

  private named(id: string): JsonSchema {
    const entry = this.scope.getType(id);
    if (!entry) {
      throw new TypeDefinitionError("type.unknown_id", `The schema refers to type id ${id}, which no longer exists. Pick another type.`, {
        details: { id },
      });
    }
    let key = this.keys.get(id);
    if (key === undefined) {
      key = entry.origin === "pack" ? entry.decl.id : entry.decl.name;
      this.keys.set(id, key);
    }
    if (!this.defs.has(key)) {
      this.defs.set(key, {}); // placeholder (recursive types)
      const decl = entry.decl;
      let def: JsonSchema;
      if (decl.kind === "enum") {
        def = { type: "string", enum: decl.members.map((m) => m.value), title: decl.name };
        if (decl.description !== undefined) def["description"] = decl.description;
        const labels: Record<string, string> = {};
        for (const m of decl.members) if (m.label !== undefined) labels[m.value] = m.label;
        if (Object.keys(labels).length > 0) def["x-briar-labels"] = labels;
      } else {
        def = { ...this.object(decl.fields), title: decl.name };
        if (decl.description !== undefined) def["description"] = decl.description;
      }
      this.defs.set(key, def);
    }
    return { $ref: `#/$defs/${key}` };
  }

  object(fields: readonly FieldDecl[]): JsonSchema {
    const properties: JsonSchema = {};
    const required: string[] = [];
    for (const f of fields) {
      const s = { ...this.compile(f.type) };
      if (f.description !== undefined) s["description"] = f.description;
      const hasDefault = f.default !== undefined;
      if (hasDefault && !this.strict) s["default"] = f.default;
      properties[f.name] = s;
      if (this.strict || (f.type.kind !== "optional" && !hasDefault)) required.push(f.name);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }

  private mediaRefDef(): JsonSchema {
    if (this.strict) {
      return {
        type: "object",
        title: "MediaRef",
        properties: { uri: { type: "string" }, mime: { type: "string" } },
        required: ["uri", "mime"],
        additionalProperties: false,
      };
    }
    return {
      type: "object",
      title: "MediaRef",
      properties: {
        uri: { type: "string" },
        mime: { type: "string", pattern: "^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$" },
        bytes: { type: "integer", minimum: 0 },
        hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        meta: { type: "object" },
      },
      required: ["uri", "mime"],
      additionalProperties: false,
    };
  }
}
