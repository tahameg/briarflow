/**
 * JSON descriptors of node definitions (docs/specs/node-api.md §7 "Descriptors"). Used by
 * `GET /node-types` and the Python manifest.
 */
import type { TypeRef } from "../types/ir.js";
import type { ConfigFieldKind } from "./config.js";
import type { AnyNodeDefinition, NodeColor, PortMap, PortWidget, RetryPolicy } from "./define.js";
import { portParts } from "./define.js";
import { titleFromName } from "../util/titles.js";
import { cloneJson } from "../util/json.js";
import type { NodePack } from "./pack.js";

/** One port in a descriptor. `default` is omitted when absent. */
export interface PortDescriptor {
  name: string;
  type: TypeRef;
  title: string;
  description?: string;
  default?: unknown;
  widget?: PortWidget | null;
}

/** One config field in a descriptor. */
export interface ConfigDescriptor {
  name: string;
  kind: ConfigFieldKind;
  required: boolean;
  title: string;
  description?: string;
  default?: unknown;
  multiline?: boolean;
  min?: number;
  max?: number;
  choices?: string[];
  typeKind?: "struct" | "enum" | "any";
  writable?: boolean;
}

/** JSON-serializable description of a node definition (no `run`). Ports keep declaration order. */
export interface NodeDescriptor {
  type: string;
  pack: { name: string; version: string };
  title: string;
  description: string;
  category: string;
  icon: string | null;
  color: NodeColor | null;
  inputs: PortDescriptor[];
  outputs: PortDescriptor[];
  config: ConfigDescriptor[];
  dynamicPorts: boolean;
  secrets: string[];
  cache: boolean;
  timeoutMs: number;
  retry: RetryPolicy;
  concurrency: number | null;
  deprecated: string | null;
  /** Present (true) on frontend nodes only: their effect happens in the viewer. */
  frontend?: true;
}

/**
 * Strips `run` / `resolvePorts` and returns a JSON descriptor (static ports).
 *
 * @example
 * ```ts
 * const json = JSON.stringify(toNodeDescriptor(slugify, wordsPack));
 * ```
 */
export function toNodeDescriptor(def: AnyNodeDefinition, pack: Pick<NodePack, "name" | "version">): NodeDescriptor {
  const config: ConfigDescriptor[] = Object.entries(def.config).map(([name, f]) => {
    const d: ConfigDescriptor = { name, kind: f.kind, required: f.required, title: f.title ?? titleFromName(name) };
    if (f.description !== undefined) d.description = f.description;
    if (f.default !== undefined) d.default = cloneJson(f.default);
    if (f.multiline !== undefined) d.multiline = f.multiline;
    if (f.min !== undefined) d.min = f.min;
    if (f.max !== undefined) d.max = f.max;
    if (f.choices !== undefined) d.choices = [...f.choices];
    if (f.typeKind !== undefined) d.typeKind = f.typeKind;
    if (f.writable !== undefined) d.writable = f.writable;
    return d;
  });
  return {
    type: def.type,
    pack: { name: pack.name, version: pack.version },
    title: def.title,
    description: def.description,
    category: def.category,
    icon: def.icon ?? null,
    color: def.color ?? null,
    inputs: ports(def.inputs, true),
    outputs: ports(def.outputs, false),
    config,
    dynamicPorts: typeof def.resolvePorts === "function",
    secrets: [...def.secrets],
    cache: def.cache,
    timeoutMs: def.timeoutMs,
    retry: cloneJson(def.retry),
    concurrency: def.concurrency ?? null,
    deprecated: def.deprecated ?? null,
    ...(def.frontend ? { frontend: true as const } : {}),
  };
}

function ports(map: PortMap, isInput: boolean): PortDescriptor[] {
  return Object.entries(map).map(([name, port]) => {
    const p = portParts(port);
    const d: PortDescriptor = { name, type: cloneJson(p?.spec.ref ?? { kind: "primitive", name: "text" }), title: p?.title ?? titleFromName(name) };
    if (p?.description !== undefined) d.description = p.description;
    if (p?.default !== undefined) d.default = cloneJson(p.default);
    if (isInput) d.widget = p?.widget ?? null;
    return d;
  });
}
