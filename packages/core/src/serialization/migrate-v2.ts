/**
 * Format 1 → 2 (types.md §13): the primitives became `int float bool string binary`; text,
 * media, JSON, secrets and errors became built-in structs.
 *
 * - Type refs everywhere: `text` → `string` (its constraints are dropped: use a struct that
 *   extends Text for limits), `boolean` → `bool`, `image` … `file` → `Image` … `File`,
 *   `json` → `Json`, `secret` → `Secret` (`ApiKey` for kind apiKey), `error` → `Error`.
 * - Values whose type is known (struct field defaults, globals, flow input/output defaults,
 *   variable defaults) are wrapped: media `{ mediaId }` → `{ data: { mediaId }, mime: "" }`
 *   (the registry entry's mime is filled in when a node reads it), JSON → `{ text }`, secret
 *   names → `{ name }`.
 * - Node constants (`values`), whose port types belong to the node packs: only media values are
 *   recognised (by shape) and wrapped. Other constants are kept; validation reports any that no
 *   longer fit.
 */
import { BUILTIN } from "../types/builtins.js";
import { isPlainObject } from "../util/json.js";

type Json = Record<string, unknown>;

const MEDIA: Readonly<Record<string, string>> = {
  image: BUILTIN.Image,
  video: BUILTIN.Video,
  audio: BUILTIN.Audio,
  model3d: BUILTIN.Model3D,
  file: BUILTIN.File,
};

/** A format-1 type ref → format 2. Anything that is not a type ref is returned as it is. */
export function upgradeType(type: unknown): unknown {
  if (!isPlainObject(type)) return type;
  switch (type["kind"]) {
    case "primitive": {
      const name = type["name"];
      const c = isPlainObject(type["constraints"]) ? type["constraints"] : undefined;
      if (name === "text") return { kind: "primitive", name: "string" };
      if (name === "boolean") return { kind: "primitive", name: "bool" };
      if (name === "json") return { kind: "named", id: BUILTIN.Json };
      if (name === "secret") return { kind: "named", id: c?.["kind"] === "apiKey" ? BUILTIN.ApiKey : BUILTIN.Secret };
      if (name === "error") return { kind: "named", id: BUILTIN.Error };
      if (typeof name === "string" && MEDIA[name] !== undefined) return { kind: "named", id: MEDIA[name] };
      return type;
    }
    case "list":
    case "optional":
      return { ...type, of: upgradeType(type["of"]) };
    case "var":
      return Array.isArray(type["oneOf"]) ? { ...type, oneOf: type["oneOf"].map(upgradeType) } : type;
    default:
      return type;
  }
}

const isMediaShape = (v: unknown): v is Json => isPlainObject(v) && Object.keys(v).length === 1 && typeof v["mediaId"] === "string";
const wrapMedia = (v: Json): Json => ({ data: v, mime: "" });

/** A value of format-1 type `type` → its format-2 shape. Struct fields are found in `decls`. */
function upgradeValue(value: unknown, type: unknown, decls: ReadonlyMap<string, Json>, depth = 0): unknown {
  if (value === undefined || value === null || !isPlainObject(type) || depth > 32) return value;
  switch (type["kind"]) {
    case "primitive": {
      const name = type["name"];
      if (typeof name === "string" && MEDIA[name] !== undefined) return isMediaShape(value) ? wrapMedia(value) : value;
      if (name === "json") return { text: JSON.stringify(value) };
      if (name === "secret") return typeof value === "string" ? { name: value } : value;
      if (name === "error" && isPlainObject(value) && value["details"] !== undefined && !isPlainObject(value["details"])) {
        return { ...value, details: { text: JSON.stringify(value["details"]) } };
      }
      return value;
    }
    case "optional":
      return upgradeValue(value, type["of"], decls, depth + 1);
    case "list":
      return Array.isArray(value) ? value.map((v) => upgradeValue(v, type["of"], decls, depth + 1)) : value;
    case "named": {
      const decl = typeof type["id"] === "string" ? decls.get(type["id"]) : undefined;
      if (!decl || decl["kind"] !== "struct" || !isPlainObject(value) || !Array.isArray(decl["fields"])) return value;
      const out: Json = { ...value };
      for (const f of decl["fields"] as Json[]) {
        const name = f["name"];
        if (typeof name === "string" && name in out) out[name] = upgradeValue(out[name], f["type"], decls, depth + 1);
      }
      return out;
    }
    default:
      return value;
  }
}

/** Every type ref inside a node config (found by shape) → format 2. */
function upgradeConfig(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => upgradeConfig(v, depth + 1));
  if (!isPlainObject(value)) return value;
  if (value["kind"] === "primitive" && typeof value["name"] === "string") return upgradeType(value);
  if ((value["kind"] === "list" || value["kind"] === "optional") && isPlainObject(value["of"])) return upgradeType(value);
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = upgradeConfig(v, depth + 1);
  return out;
}

function upgradeFields(fields: unknown, decls: ReadonlyMap<string, Json>): unknown {
  if (!Array.isArray(fields)) return fields;
  return fields.map((f: unknown) => {
    if (!isPlainObject(f)) return f;
    const out: Json = { ...f, type: upgradeType(f["type"]) };
    if (f["default"] !== undefined) out["default"] = upgradeValue(f["default"], f["type"], decls);
    return out;
  });
}

function upgradeDecls(types: unknown, decls: ReadonlyMap<string, Json>): unknown {
  if (!Array.isArray(types)) return types;
  return types.map((t: unknown) => (isPlainObject(t) && t["kind"] === "struct" ? { ...t, fields: upgradeFields(t["fields"], decls) } : t));
}

const declMap = (...lists: unknown[]): Map<string, Json> => {
  const m = new Map<string, Json>();
  for (const list of lists) if (Array.isArray(list)) for (const t of list) if (isPlainObject(t) && typeof t["id"] === "string") m.set(t["id"], t);
  return m;
};

/** The migration from format 1 to 2. Receives a private deep copy. */
export function migrateV1ToV2(doc: Json): Json {
  const globalDecls = declMap(doc["types"]);
  const out: Json = { ...doc, types: upgradeDecls(doc["types"], globalDecls) };
  if (Array.isArray(doc["globals"])) {
    out["globals"] = doc["globals"].map((g: unknown) => {
      if (!isPlainObject(g)) return g;
      const next: Json = { ...g, type: upgradeType(g["type"]) };
      if (g["value"] !== undefined) next["value"] = upgradeValue(g["value"], g["type"], globalDecls);
      return next;
    });
  }
  if (Array.isArray(doc["flows"])) {
    out["flows"] = doc["flows"].map((f: unknown) => {
      if (!isPlainObject(f)) return f;
      const decls = declMap(doc["types"], f["types"]);
      const next: Json = {
        ...f,
        types: upgradeDecls(f["types"], decls),
        inputs: upgradeFields(f["inputs"], decls),
        outputs: upgradeFields(f["outputs"], decls),
      };
      if (Array.isArray(f["variables"])) {
        next["variables"] = f["variables"].map((v: unknown) => {
          if (!isPlainObject(v)) return v;
          const nv: Json = { ...v, type: upgradeType(v["type"]) };
          if (v["default"] !== undefined) nv["default"] = upgradeValue(v["default"], v["type"], decls);
          return nv;
        });
      }
      if (Array.isArray(f["nodes"])) {
        next["nodes"] = f["nodes"].map((n: unknown) => {
          if (!isPlainObject(n)) return n;
          const nn: Json = { ...n };
          if (n["config"] !== undefined) nn["config"] = upgradeConfig(n["config"]);
          if (isPlainObject(n["typeBindings"])) {
            nn["typeBindings"] = Object.fromEntries(Object.entries(n["typeBindings"]).map(([k, t]) => [k, upgradeType(t)]));
          }
          if (isPlainObject(n["values"])) {
            nn["values"] = Object.fromEntries(
              Object.entries(n["values"]).map(([k, v]) => [k, isMediaShape(v) ? wrapMedia(v) : Array.isArray(v) ? v.map((x) => (isMediaShape(x) ? wrapMedia(x) : x)) : v]),
            );
          }
          return nn;
        });
      }
      return next;
    });
  }
  return out;
}
