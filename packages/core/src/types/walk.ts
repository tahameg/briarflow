/**
 * Internal helpers to traverse and rewrite type IR.
 */
import type { TypeRef } from "./ir.js";

/** Rewrites every named ref with `fn(id)`; returns the same object when nothing changed. */
export function mapNamedIds(type: TypeRef, fn: (id: string) => string): TypeRef {
  switch (type.kind) {
    case "named": {
      const id = fn(type.id);
      return id === type.id ? type : { kind: "named", id };
    }
    case "list": {
      const of = mapNamedIds(type.of, fn);
      return of === type.of ? type : { ...type, of };
    }
    case "optional": {
      const of = mapNamedIds(type.of, fn);
      return of === type.of ? type : { kind: "optional", of };
    }
    default:
      return type;
  }
}

/** Named ids referenced by a type, in order, without duplicates. */
export function collectNamedIds(type: TypeRef, out: string[] = []): string[] {
  switch (type.kind) {
    case "named":
      if (!out.includes(type.id)) out.push(type.id);
      break;
    case "list":
    case "optional":
      collectNamedIds(type.of, out);
      break;
    default:
      break;
  }
  return out;
}

/** True when the type contains a `var` anywhere. */
export function containsVar(type: TypeRef): boolean {
  switch (type.kind) {
    case "var":
      return true;
    case "list":
    case "optional":
      return containsVar(type.of);
    default:
      return false;
  }
}

/** True when a named id is a bare (unqualified, non-document) name like `Role`. */
export function isBareName(id: string): boolean {
  return !id.includes(".") && /^[A-Z]/.test(id);
}

/** Structural validity of an unknown value as TypeRef (shape only). Returns a problem or undefined. */
export function typeRefShapeProblem(value: unknown, path: string): { path: string; reason: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { path, reason: "must be a type object" };
  }
  const v = value as Record<string, unknown>;
  switch (v["kind"]) {
    case "primitive": {
      const names = ["text", "int", "float", "boolean", "json", "secret", "image", "video", "audio", "model3d", "file", "error"];
      if (typeof v["name"] !== "string" || !names.includes(v["name"])) {
        return { path: `${path}.name`, reason: "must be a primitive name" };
      }
      const c = v["constraints"];
      if (c !== undefined && (typeof c !== "object" || c === null || Array.isArray(c))) {
        return { path: `${path}.constraints`, reason: "must be an object" };
      }
      return undefined;
    }
    case "named":
      if (typeof v["id"] !== "string" || v["id"] === "") return { path: `${path}.id`, reason: "must be a string" };
      return undefined;
    case "list":
      for (const k of ["minItems", "maxItems"]) {
        if (v[k] !== undefined && typeof v[k] !== "number") return { path: `${path}.${k}`, reason: "must be a number" };
      }
      return typeRefShapeProblem(v["of"], `${path}.of`);
    case "optional":
      return typeRefShapeProblem(v["of"], `${path}.of`);
    case "var": {
      if (typeof v["name"] !== "string") return { path: `${path}.name`, reason: "must be a string" };
      const oneOf = v["oneOf"];
      if (oneOf === undefined) return undefined;
      if (!Array.isArray(oneOf) || oneOf.length === 0) return { path: `${path}.oneOf`, reason: "must be a non-empty list of types" };
      for (const [i, o] of oneOf.entries()) {
        const p = typeRefShapeProblem(o, `${path}.oneOf[${i}]`);
        if (p) return p;
      }
      return undefined;
    }
    default:
      return { path: `${path}.kind`, reason: "must be one of primitive, named, list, optional, var" };
  }
}
