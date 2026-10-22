/**
 * Node packs (docs/specs/node-api.md §7).
 */
import type { TypeDecl } from "../documents/model.js";
import { PackDefinitionError } from "../errors.js";
import type { EnumType, StructType } from "../types/builder.js";
import { isTypeSpec } from "../types/builder.js";
import type { TypeRef } from "../types/ir.js";
import { createTypeScope } from "../types/scope.js";
import { collectNamedIds, mapNamedIds } from "../types/walk.js";
import { isValidPackName, PACK_NAME_PATTERN } from "../util/names.js";
import { checkValue } from "../values/validate.js";
import type { AnyNodeDefinition, PortMap } from "./define.js";
import { portParts } from "./define.js";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Everything a developer writes in `definePack`. */
export interface PackDefinitionInput {
  /** `^[a-z][a-z0-9_]*$`, ≤ 32. Also the default node-type namespace. */
  name: string;
  /** Semver; part of cache keys. */
  version: string;
  title?: string;
  description?: string;
  /** Extra node-type namespaces this pack claims (e.g. `briar` claims `text`, `list`, `convert`). */
  namespaces?: readonly string[];
  /** Pack types from `defineStruct` / `defineEnum`. Ids become `<name>.<TypeName>`. */
  types?: readonly (StructType | EnumType)[];
  nodes: readonly AnyNodeDefinition[];
}

/** A validated pack. Type ids and named refs in node ports are qualified. */
export interface NodePack {
  readonly kind: "nodePack";
  readonly name: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  /** Always includes `name`. */
  readonly namespaces: readonly string[];
  readonly types: readonly TypeDecl[];
  readonly nodes: readonly AnyNodeDefinition[];
}

/**
 * Bundles nodes and types. Qualifies type ids (`Role` → `openai.Role`) and bare named refs in
 * node ports and struct fields. Throws `PackDefinitionError` (`pack.invalid`) for: invalid
 * name/version, node type outside the pack's namespaces, duplicate node types, duplicate type
 * names, unresolved refs, refs to types of other packs inside pack types.
 *
 * @example
 * ```ts
 * export const wordsPack = definePack({ name: "words", version: "0.1.0", types: [Tone, Stats], nodes: [shout, count] });
 * ```
 */
export function definePack(input: PackDefinitionInput): NodePack {
  const name = input.name;
  if (typeof name !== "string" || !isValidPackName(name)) {
    throw new PackDefinitionError(
      `definePack: "${String(name)}" is not a valid pack name (lowercase letters, digits and _, starting with a letter, at most 32 characters).`,
    );
  }
  const fail = (what: string): never => {
    throw new PackDefinitionError(`definePack "${name}": ${what}`);
  };
  if (typeof input.version !== "string" || !SEMVER.test(input.version)) fail(`version "${String(input.version)}" is not a semantic version like 1.0.0.`);
  const namespaces = [name];
  for (const ns of input.namespaces ?? []) {
    if (typeof ns !== "string" || ns.length > 32 || !PACK_NAME_PATTERN.test(ns)) fail(`namespace "${String(ns)}" is not valid (lowercase letters, digits and _).`);
    if (!namespaces.includes(ns)) namespaces.push(ns);
  }

  // Pack types: qualify ids and refs.
  const rawTypes = input.types ?? [];
  const byName = new Map<string, string>();
  for (const t of rawTypes) {
    if (typeof t !== "object" || t === null || (t.kind !== "structType" && t.kind !== "enumType")) {
      fail("types must be values from defineStruct / defineEnum.");
    }
    const declName = t.decl.name;
    const existing = [...byName.keys()].find((n) => n.toLowerCase() === declName.toLowerCase());
    if (existing !== undefined) fail(`two types are named "${existing}" and "${declName}". Type names must be unique (ignoring case).`);
    if (t.decl.id !== declName && t.decl.id !== `${name}.${declName}`) fail(`type "${declName}" already belongs to another pack (${t.decl.id}).`);
    byName.set(declName, `${name}.${declName}`);
  }
  const ownIds = new Set(byName.values());
  const qualify = (id: string, where: string, allowForeign: boolean): string => {
    if (!id.includes(".")) {
      const q = byName.get(id);
      if (q !== undefined) return q;
      if (allowForeign && id.startsWith("ty_")) return id;
      return fail(`${where} refers to type "${id}", which is not a type of this pack. Add it to types or use its qualified id (pack.Name).`);
    }
    if (id.startsWith(`${name}.`)) {
      if (!ownIds.has(id)) fail(`${where} refers to "${id}", which is not a type of this pack.`);
      return id;
    }
    if (!allowForeign) fail(`${where} refers to "${id}" from another pack. Pack types may only use primitives and types of the same pack.`);
    return id;
  };
  const qualifyRef = (ref: TypeRef, where: string, allowForeign: boolean) => mapNamedIds(ref, (id) => qualify(id, where, allowForeign));

  const types: TypeDecl[] = rawTypes.map((t) => {
    const id = `${name}.${t.decl.name}`;
    if (t.decl.kind === "enum") return { ...t.decl, id };
    return {
      ...t.decl,
      id,
      fields: t.decl.fields.map((f) => ({ ...f, type: qualifyRef(f.type, `type ${t.decl.name}, field "${f.name}"`, false) })),
    };
  });
  const scope = createTypeScope({ packTypes: types });
  for (const t of types) {
    if (t.kind !== "struct") continue;
    const chain = findCycle(t.id, types);
    if (chain) fail(`type "${t.name}" contains itself through ${chain}. Recursive types are not supported.`);
    for (const f of t.fields) {
      if (f.default === undefined) continue;
      const r = checkValue(f.default, f.type, scope, { path: "default" });
      const first = r.diagnostics[0];
      if (first) fail(`type ${t.name}, field "${f.name}" has an invalid default: ${first.message}.`);
    }
  }

  // Nodes.
  const nodeTypes = new Set<string>();
  const nodes = (input.nodes ?? []).map((def) => {
    if (typeof def !== "object" || def === null || def.kind !== "nodeDefinition") fail("nodes must be values from defineNode.");
    const ns = def.type.split(".")[0] ?? "";
    if (!namespaces.includes(ns)) {
      fail(`node type "${def.type}" is outside this pack's namespaces (${namespaces.join(", ")}). Rename it to "${name}.…" or add "${ns}" to namespaces.`);
    }
    if (nodeTypes.has(def.type)) fail(`node type "${def.type}" is defined twice.`);
    nodeTypes.add(def.type);
    const mapPorts = (ports: PortMap, side: string): PortMap => {
      const out: PortMap = {};
      for (const [portName, port] of Object.entries(ports)) {
        const parts = portParts(port);
        if (!parts) {
          out[portName] = port;
          continue;
        }
        const where = `node "${def.type}" ${side} "${portName}"`;
        const ref = qualifyRef(parts.spec.ref, where, true);
        const spec = ref === parts.spec.ref ? parts.spec : { kind: "typeSpec" as const, ref };
        out[portName] = isTypeSpec(port) ? spec : { ...(port as object), type: spec };
        if (!isTypeSpec(port) && parts.default !== undefined && collectNamedIds(ref).some((id) => ownIds.has(id))) {
          const r = checkValue(parts.default, ref, scope, { path: "default", lenientUnknownNamed: true, lenientVars: true });
          const first = r.diagnostics[0];
          if (first) fail(`${where} has an invalid default: ${first.message}.`);
        }
      }
      return out;
    };
    const inputs = mapPorts(def.inputs, "input");
    const outputs = mapPorts(def.outputs, "output");
    return { ...def, inputs, outputs } as AnyNodeDefinition;
  });

  return {
    kind: "nodePack",
    name,
    version: input.version,
    title: input.title ?? name,
    description: input.description ?? "",
    namespaces,
    types,
    nodes,
  };
}

/** Internal: a `A.field → B.field → A` chain when struct `id` contains itself, else undefined. */
export function findCycle(startId: string, types: readonly TypeDecl[]): string | undefined {
  const byId = new Map(types.map((t) => [t.id, t]));
  const visit = (id: string, chain: string[], seen: Set<string>): string[] | undefined => {
    const decl = byId.get(id);
    if (!decl || decl.kind !== "struct") return undefined;
    for (const f of decl.fields) {
      for (const ref of collectNamedIds(f.type)) {
        const step = [...chain, `${decl.name}.${f.name}`];
        if (ref === startId) return step;
        if (seen.has(ref)) continue;
        seen.add(ref);
        const found = visit(ref, step, seen);
        if (found) return found;
      }
    }
    return undefined;
  };
  const chain = visit(startId, [], new Set([startId]));
  const start = byId.get(startId);
  return chain && start ? `${chain.join(" → ")} → ${start.name}` : undefined;
}
