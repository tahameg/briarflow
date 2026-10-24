/**
 * The reverse of `toNodeDescriptor`: builds run-less node definitions, packs and a catalog
 * from JSON descriptors (`GET /node-types`, the Python manifest). Used by the editor to apply
 * commands and validate flows locally without the packs' code.
 */
import type { TypeDecl } from "../documents/model.js";
import { NodeError } from "../errors.js";
import { cloneJson } from "../util/json.js";
import type { NodeCatalog } from "./catalog.js";
import { createCatalog } from "./catalog.js";
import type { ConfigField, ConfigMap } from "./config.js";
import type { AnyNodeDefinition, PortMap, PortOptions, VariantOption } from "./define.js";
import { linkVariants } from "./define.js";
import type { ConfigDescriptor, NodeDescriptor, PortDescriptor } from "./descriptor.js";
import type { NodePack, PackSetting } from "./pack.js";

/** Pack metadata as listed by `GET /node-types` (`packs[]`). */
export interface PackDescriptor {
  name: string;
  version: string;
  title?: string;
  description?: string;
  /** Settings the pack declares. */
  settings?: PackSetting[];
}

/** What `GET /node-types` returns: packs, node descriptors and pack types. */
export interface NodeTypesDescriptors {
  packs: readonly PackDescriptor[];
  nodes: readonly NodeDescriptor[];
  /** Pack types, ids `<pack>.<Name>`. */
  types: readonly TypeDecl[];
}

/** Options of {@link createCatalogFromDescriptors}. */
export interface CatalogFromDescriptorsOptions {
  /**
   * Packs whose code is available locally (e.g. `stdPack`). Each one replaces the
   * descriptor-built pack of the same name, so `resolvePorts` (dynamic ports) works.
   */
  localPacks?: readonly NodePack[];
}

/** A catalog built from descriptors. */
export interface DescriptorCatalog extends NodeCatalog {
  /**
   * Node types with `dynamicPorts: true` that came from descriptors only (no local pack):
   * they have just their static ports, so local port checks may differ from the server.
   */
  readonly approximateTypes: readonly string[];
}

/**
 * Rebuilds a node definition from its descriptor: static ports and config, no
 * `resolvePorts`. Its `run` throws `NodeError("node.descriptor_only")`: descriptors describe
 * nodes, they cannot execute them.
 *
 * @example
 * ```ts
 * const def = definitionFromDescriptor(descriptor);
 * def.inputs.prompt; // { type: TypeSpec, title: "Prompt", … }
 * ```
 */
export function definitionFromDescriptor(d: NodeDescriptor): AnyNodeDefinition {
  const run = () => {
    throw new NodeError(
      "node.descriptor_only",
      `Node type "${d.type}" was loaded from a descriptor and cannot run here. Run the flow where pack "${d.pack.name}" is loaded (e.g. on the server).`,
      { details: { nodeType: d.type, pack: d.pack.name } },
    );
  };
  const def: AnyNodeDefinition = {
    kind: "nodeDefinition",
    type: d.type,
    title: d.title,
    description: d.description,
    category: d.category,
    ...(d.icon === null ? {} : { icon: d.icon }),
    ...(d.color === null ? {} : { color: d.color }),
    inputs: portMap(d.inputs),
    outputs: portMap(d.outputs),
    config: configMap(d.config),
    secrets: [...d.secrets],
    cache: d.cache,
    cacheVersion: "1",
    timeoutMs: d.timeoutMs,
    retry: cloneJson(d.retry),
    ...(d.concurrency === null ? {} : { concurrency: d.concurrency }),
    ...(d.deprecated === null ? {} : { deprecated: d.deprecated }),
    ...(d.frontend === true ? { frontend: true as const } : {}),
    ...(d.pure === true ? { pure: true as const } : {}),
    ...(d.canFail === true ? { canFail: true as const } : {}),
    ...(d.conversion === true ? { conversion: true as const } : {}),
    run,
  };
  if (!d.variants) return def;
  const { inputs: _i, outputs: _o, config: _c, run: _r, conversion: _v, ...base } = def;
  const options: VariantOption[] = d.variants.options.map((o) => ({
    name: o.name,
    title: o.title,
    ...(o.description === undefined ? {} : { description: o.description }),
    ...(o.deprecated === null ? {} : { deprecated: o.deprecated }),
    shape: { inputs: portMap(o.inputs), outputs: portMap(o.outputs), config: configMap(o.config), run },
  }));
  const selector = { title: d.variants.title, ...(d.variants.description === undefined ? {} : { description: d.variants.description }), default: d.variants.default };
  return linkVariants(base, selector, options);
}

/**
 * Groups descriptors into run-less packs. A pack's namespaces are its name plus the
 * namespace of each of its node types; its types are the `types` whose id starts with
 * `<pack>.`. Packs referenced only by node descriptors are created too.
 *
 * @example
 * ```ts
 * const packs = packsFromDescriptors(await client.nodeTypes.list());
 * ```
 */
export function packsFromDescriptors(info: NodeTypesDescriptors): NodePack[] {
  const byPack = new Map<string, { meta: PackDescriptor; nodes: NodeDescriptor[] }>();
  for (const p of info.packs) byPack.set(p.name, { meta: p, nodes: [] });
  for (const d of info.nodes) {
    let entry = byPack.get(d.pack.name);
    if (!entry) {
      entry = { meta: { name: d.pack.name, version: d.pack.version }, nodes: [] };
      byPack.set(d.pack.name, entry);
    }
    entry.nodes.push(d);
  }
  return [...byPack.values()].map(({ meta, nodes }) => {
    const namespaces = [meta.name];
    for (const d of nodes) {
      const ns = d.type.slice(0, d.type.indexOf("."));
      if (ns !== "" && !namespaces.includes(ns)) namespaces.push(ns);
    }
    return {
      kind: "nodePack",
      name: meta.name,
      version: meta.version,
      title: meta.title ?? meta.name,
      description: meta.description ?? "",
      namespaces,
      types: info.types.filter((t) => t.id.startsWith(`${meta.name}.`)).map((t) => cloneJson(t)),
      nodes: nodes.map(definitionFromDescriptor),
      settings: (meta.settings ?? []).map((s) => cloneJson(s)),
    };
  });
}

/**
 * Builds a catalog from node-type descriptors, preferring `localPacks` where given.
 * Throws `CatalogError` like `createCatalog` (duplicate pack, namespace conflict).
 *
 * @example
 * ```ts
 * const catalog = createCatalogFromDescriptors(await client.nodeTypes.list(), { localPacks: [stdPack] });
 * applyBatch(doc, commands, { catalog });
 * catalog.approximateTypes; // dynamic-port types without a local pack
 * ```
 */
export function createCatalogFromDescriptors(
  info: NodeTypesDescriptors,
  options: CatalogFromDescriptorsOptions = {},
): DescriptorCatalog {
  const local = new Map((options.localPacks ?? []).map((p) => [p.name, p]));
  const packs: NodePack[] = [];
  const approximateTypes: string[] = [];
  for (const pack of packsFromDescriptors(info)) {
    const localPack = local.get(pack.name);
    if (localPack) {
      packs.push(localPack);
      local.delete(pack.name);
      continue;
    }
    packs.push(pack);
  }
  const localNames = new Set((options.localPacks ?? []).map((p) => p.name));
  for (const d of info.nodes) {
    const dynamic = d.dynamicPorts || (d.variants?.options.some((o) => o.dynamicPorts) ?? false);
    if (dynamic && !localNames.has(d.pack.name)) approximateTypes.push(d.type);
  }
  packs.push(...local.values());
  return { ...createCatalog(packs), approximateTypes };
}

function portMap(ports: readonly PortDescriptor[]): PortMap {
  const out: PortMap = {};
  for (const p of ports) {
    const port: PortOptions = { type: { kind: "typeSpec", ref: cloneJson(p.type) }, title: p.title };
    if (p.description !== undefined) port.description = p.description;
    if (p.default !== undefined) port.default = cloneJson(p.default) as NonNullable<PortOptions["default"]>;
    if (p.widget !== undefined && p.widget !== null) port.widget = p.widget;
    out[p.name] = port;
  }
  return out;
}

function configMap(fields: readonly ConfigDescriptor[]): ConfigMap {
  const out: ConfigMap = {};
  for (const f of fields) {
    const field: { -readonly [K in keyof ConfigField]: ConfigField[K] } = { kind: f.kind, required: f.required, title: f.title };
    if (f.description !== undefined) field.description = f.description;
    if (f.default !== undefined) field.default = cloneJson(f.default);
    if (f.multiline !== undefined) field.multiline = f.multiline;
    if (f.min !== undefined) field.min = f.min;
    if (f.max !== undefined) field.max = f.max;
    if (f.choices !== undefined) field.choices = [...f.choices];
    if (f.typeKind !== undefined) field.typeKind = f.typeKind;
    if (f.writable !== undefined) field.writable = f.writable;
    out[f.name] = field;
  }
  return out;
}
