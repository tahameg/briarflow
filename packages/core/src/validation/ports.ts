/**
 * Port resolution of node instances: static or dynamic (`resolvePorts`) ports, built-in
 * input/output nodes, generic bindings. Shared by validation, authoring and the runtime.
 */
import { ERROR_OUTPUT } from "../nodes/exec-ports.js";
import type { ContextDocument, FieldDecl, FlowDocument, NodeInstance } from "../documents/model.js";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE } from "../documents/model.js";
import { findFlow } from "../documents/factories.js";
import type { NodeCatalog } from "../nodes/catalog.js";
import type { ConfigField } from "../nodes/config.js";
import type { AnyNodeDefinition, PortMap, PortScope, PortWidget } from "../nodes/define.js";
import { portParts } from "../nodes/define.js";
import type { GenericConnection, TypeBindings } from "../types/generics.js";
import { bindTypeVarsAll, substituteTypeVars } from "../types/generics.js";
import type { TypeRef } from "../types/ir.js";
import type { TypeScope } from "../types/scope.js";
import { flowNotFound, scopeForFlow } from "../types/scope.js";
import { formatType } from "../types/shorthand.js";
import { collectNamedIds, containsVar, isBareName, mapNamedIds, typeRefShapeProblem } from "../types/walk.js";
import { jsonEquals } from "../util/json.js";
import { isValidFieldName } from "../util/names.js";
import { titleFromName } from "../util/titles.js";
import type { Diagnostic } from "./diagnostic.js";
import { nodeLabel } from "./labels.js";

/** A port of a placed node, after dynamic resolution and generic substitution. */
export interface ResolvedPort {
  name: string;
  /** Declared type with bound vars substituted (unbound vars stay `var`). */
  type: TypeRef;
  /** Declared type, vars included. */
  declaredType: TypeRef;
  title: string;
  description?: string;
  /** `true` when the port declares a default (which may be `null`). */
  hasDefault: boolean;
  default?: unknown;
  widget?: PortWidget;
}

/** Ports of one node instance. */
export interface ResolvedNode {
  nodeId: string;
  /** `undefined` for unknown node types and for the built-in input/output nodes. */
  definition: AnyNodeDefinition | undefined;
  inputs: ResolvedPort[];
  outputs: ResolvedPort[];
  /** Recomputed from edges (types.md §5.1); compare with `NodeInstance.typeBindings`. */
  typeBindings: TypeBindings;
  /**
   * Problems found while resolving: `node.unknown_type`, `config.invalid`,
   * `config.unknown_ref`, `node.ports_unresolved`, `node.generic_conflict`.
   */
  diagnostics: Diagnostic[];
}

/** Ports of every node of a flow. */
export interface FlowPorts {
  flowId: string;
  nodes: ReadonlyMap<string, ResolvedNode>;
}

/**
 * Resolves the ports of every node in a flow. `briar.input` gets one output per flow input,
 * `briar.output` one input per flow output; other nodes use their definition (static ports, or
 * `resolvePorts` with validated config). Generic bindings are recomputed from the current
 * edges. Throws `BriarError("flow.not_found")` for an unknown flow id; never throws for
 * document problems (they become diagnostics).
 *
 * When a dynamic node's config is invalid or `resolvePorts` fails, the node gets no ports
 * (`node.ports_unresolved` / `config.*` explain why).
 *
 * @example
 * ```ts
 * const ports = resolveFlowPorts(doc, "flow_p", catalog);
 * ports.nodes.get("n_tpl")?.inputs.map((p) => p.name); // ["name", "style"]
 * ```
 */
export function resolveFlowPorts(doc: ContextDocument, flowId: string, catalog: NodeCatalog): FlowPorts {
  const flow = findFlow(doc, flowId);
  if (!flow) throw flowNotFound(doc, flowId);
  const scope = scopeForFlow(doc, flowId, catalog);
  const nodes = new Map<string, ResolvedNode>();
  for (const node of flow.nodes) {
    if (nodes.has(node.id)) continue; // duplicate ids are reported by validateFlow
    nodes.set(node.id, resolveNode(node, doc, flow, scope, catalog));
  }
  bindGenerics(flow, nodes, catalog);
  return { flowId, nodes };
}

function signaturePorts(fields: readonly FieldDecl[]): ResolvedPort[] {
  return fields.map((f) => {
    const p: ResolvedPort = { name: f.name, type: f.type, declaredType: f.type, title: titleFromName(f.name), hasDefault: false };
    if (f.description !== undefined) p.description = f.description;
    return p;
  });
}

function resolveNode(
  node: NodeInstance,
  doc: ContextDocument,
  flow: FlowDocument,
  scope: TypeScope,
  catalog: NodeCatalog,
): ResolvedNode {
  const base = { nodeId: node.id, typeBindings: {}, diagnostics: [] as Diagnostic[] };
  if (node.type === FLOW_INPUT_NODE_TYPE) {
    return { ...base, definition: undefined, inputs: [], outputs: signaturePorts(flow.inputs) };
  }
  if (node.type === FLOW_OUTPUT_NODE_TYPE) {
    return { ...base, definition: undefined, inputs: signaturePorts(flow.outputs), outputs: [] };
  }
  const def = catalog.get(node.type);
  const at = { flowId: flow.id, nodeId: node.id };
  if (!def) {
    base.diagnostics.push({
      severity: "error",
      code: "node.unknown_type",
      message: `${nodeLabel(node, undefined)} uses unknown node type "${node.type}". Load its pack or remove the node.`,
      path: at,
      details: { type: node.type },
    });
    return { ...base, definition: undefined, inputs: [], outputs: [] };
  }
  const config = checkConfig(def, node.config, doc, flow, scope, node);
  base.diagnostics.push(...config.diagnostics);
  let inputs: PortMap = def.inputs;
  let outputs: PortMap = def.outputs;
  if (def.resolvePorts) {
    const unresolved = (message: string, code?: string): ResolvedNode => {
      base.diagnostics.push({
        severity: "error",
        code: "node.ports_unresolved",
        message: `${nodeLabel(node, def)} cannot work out its ports: ${message}`,
        path: at,
        ...(code === undefined ? {} : { details: { code } }),
      });
      return { ...base, definition: def, inputs: [], outputs: [] };
    };
    if (!config.ok) return { ...base, definition: def, inputs: [], outputs: [] };
    let result: ReturnType<NonNullable<AnyNodeDefinition["resolvePorts"]>>;
    try {
      result = def.resolvePorts({ config: config.config as never, scope: portScope(doc, flow, scope) });
    } catch (err) {
      return unresolved(err instanceof Error ? err.message : String(err));
    }
    if (typeof result !== "object" || result === null) return unresolved("resolvePorts returned nothing.");
    if ("error" in result) return unresolved(result.error.message, result.error.code);
    inputs = result.inputs ?? {};
    outputs = result.outputs ?? {};
  }
  const pack = catalog.packOf(node.type);
  const qualify = (ref: TypeRef): TypeRef =>
    mapNamedIds(ref, (id) => {
      if (!pack || !isBareName(id)) return id;
      return pack.types.some((t) => t.id === `${pack.name}.${id}`) ? `${pack.name}.${id}` : id;
    });
  const convert = (map: PortMap, isInput: boolean): ResolvedPort[] | string => {
    const out: ResolvedPort[] = [];
    for (const [name, port] of Object.entries(map)) {
      const parts = portParts(port);
      if (!isValidFieldName(name)) return `"${name}" is not a valid port name.`;
      if (!parts) return `port "${name}" has no type.`;
      const declaredType = qualify(parts.spec.ref);
      const p: ResolvedPort = { name, type: declaredType, declaredType, title: parts.title ?? titleFromName(name), hasDefault: false };
      if (parts.description !== undefined) p.description = parts.description;
      if (isInput && parts.default !== undefined) {
        p.hasDefault = true;
        p.default = parts.default;
      }
      if (parts.widget !== undefined) p.widget = parts.widget;
      out.push(p);
    }
    return out;
  };
  const ri = convert(inputs, true);
  const ro = convert(outputs, false);
  if (typeof ri === "string" || typeof ro === "string") {
    base.diagnostics.push({
      severity: "error",
      code: "node.ports_unresolved",
      message: `${nodeLabel(node, def)} cannot work out its ports: ${typeof ri === "string" ? ri : ro}`,
      path: at,
    });
    return { ...base, definition: def, inputs: [], outputs: [] };
  }
  if (def.canFail && !ro.some((p) => p.name === ERROR_OUTPUT)) {
    const type: TypeRef = { kind: "primitive", name: "error" };
    ro.push({ name: ERROR_OUTPUT, type, declaredType: type, title: "Error", description: "Why the node failed. Only set on the failed line.", hasDefault: false });
  }
  return { ...base, definition: def, inputs: ri, outputs: ro };
}

function portScope(doc: ContextDocument, flow: FlowDocument, scope: TypeScope): PortScope {
  return {
    flow: { id: flow.id, inputs: flow.inputs, outputs: flow.outputs, variables: flow.variables },
    globals: doc.globals,
    resolveType: (id) => scope.getType(id)?.decl,
  };
}

function bindGenerics(flow: FlowDocument, nodes: Map<string, ResolvedNode>, catalog: NodeCatalog): void {
  void catalog;
  const generic = [...nodes.values()].filter((n) => [...n.inputs, ...n.outputs].some((p) => containsVar(p.declaredType)));
  if (generic.length === 0) return;
  const bindings = new Map<string, TypeBindings>();
  let conflicts = new Map<string, ReturnType<typeof bindTypeVarsAll>["conflicts"]>();
  const portType = (nodeId: string, port: string, side: "inputs" | "outputs"): TypeRef | undefined => {
    const p = nodes.get(nodeId)?.[side].find((x) => x.name === port);
    return p ? substituteTypeVars(p.declaredType, bindings.get(nodeId) ?? {}) : undefined;
  };
  const maxRounds = generic.length + 2;
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    const nextConflicts = new Map<string, ReturnType<typeof bindTypeVarsAll>["conflicts"]>();
    for (const n of generic) {
      const conns: GenericConnection[] = [];
      for (const e of flow.edges) {
        if (e.from.node === e.to.node) continue;
        if (e.to.node === n.nodeId) {
          const p = n.inputs.find((x) => x.name === e.to.port);
          const other = portType(e.from.node, e.from.port, "outputs");
          if (p && other && containsVar(p.declaredType) && !containsVar(other)) {
            conns.push({ port: p.name, direction: "input", pattern: p.declaredType, other });
          }
        }
        if (e.from.node === n.nodeId) {
          const p = n.outputs.find((x) => x.name === e.from.port);
          const other = portType(e.to.node, e.to.port, "inputs");
          if (p && other && containsVar(p.declaredType) && !containsVar(other)) {
            conns.push({ port: p.name, direction: "output", pattern: p.declaredType, other });
          }
        }
      }
      const r = bindTypeVarsAll(conns);
      if (!jsonEquals(r.bindings, bindings.get(n.nodeId) ?? {})) changed = true;
      bindings.set(n.nodeId, r.bindings);
      nextConflicts.set(n.nodeId, r.conflicts);
    }
    conflicts = nextConflicts;
    if (!changed) break;
  }
  for (const n of generic) {
    const b = bindings.get(n.nodeId) ?? {};
    n.typeBindings = b;
    for (const p of [...n.inputs, ...n.outputs]) p.type = substituteTypeVars(p.declaredType, b);
    const node = flow.nodes.find((x) => x.id === n.nodeId);
    for (const c of conflicts.get(n.nodeId) ?? []) {
      const label = node ? nodeLabel(node, n.definition) : n.nodeId;
      n.diagnostics.push({
        severity: "error",
        code: "node.generic_conflict",
        message: `${label} already uses ${c.varName} = ${formatType(c.bound)}; ${c.port} would need ${c.varName} = ${formatType(c.other)}.`,
        path: { flowId: flow.id, nodeId: n.nodeId, port: c.port },
        details: { varName: c.varName, bound: c.bound, other: c.other },
      });
    }
  }
}

/** Result of {@link validateNodeConfig}. */
export type ConfigCheckResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; diagnostics: Diagnostic[] };

/**
 * Validates a node config against a definition's config fields in the given flow and returns
 * it with defaults applied. Codes: `config.invalid` (missing required, wrong kind, unknown key,
 * out of range), `config.unknown_ref` (missing variable/global/type or wrong type kind),
 * `variable.write_to_readonly` (`cfg.global({ writable: true })` on a readonly global).
 *
 * @example
 * ```ts
 * validateNodeConfig(structMake, { typeId: "ty_char" }, doc, "flow_p", catalog);
 * ```
 */
export function validateNodeConfig(
  def: AnyNodeDefinition,
  config: Record<string, unknown> | undefined,
  doc: ContextDocument,
  flowId: string,
  catalog: NodeCatalog,
): ConfigCheckResult {
  const flow = findFlow(doc, flowId);
  if (!flow) throw flowNotFound(doc, flowId);
  const r = checkConfig(def, config, doc, flow, scopeForFlow(doc, flowId, catalog), undefined);
  return r.ok ? { ok: true, config: r.config } : { ok: false, diagnostics: r.diagnostics };
}

/** Internal config check; `node` (when known) adds `nodeId` to paths and names the node. */
export function checkConfig(
  def: AnyNodeDefinition,
  config: Record<string, unknown> | undefined,
  doc: ContextDocument,
  flow: FlowDocument,
  scope: TypeScope,
  node: NodeInstance | undefined,
): { ok: boolean; config: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const out: Record<string, unknown> = {};
  const given = config ?? {};
  const at = (field: string) => ({ flowId: flow.id, ...(node ? { nodeId: node.id } : {}), field });
  const invalid = (key: string, problem: string) =>
    diagnostics.push({ severity: "error", code: "config.invalid", message: `${def.type}: config.${key} ${problem}.`, path: at(key) });
  const unknownRef = (key: string, kind: string, id: string, extra = "") =>
    diagnostics.push({
      severity: "error",
      code: "config.unknown_ref",
      message: `${def.type}: ${kind} "${id}" does not exist in this flow${extra}.`,
      path: at(key),
      details: { kind, id },
    });
  const fields = def.config as Record<string, ConfigField>;
  for (const key of Object.keys(given)) {
    if (given[key] !== undefined && !Object.prototype.hasOwnProperty.call(fields, key)) {
      const known = Object.keys(fields);
      invalid(key, `is not a config field of this node${known.length > 0 ? ` (fields: ${known.join(", ")})` : ""}`);
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    let v = given[key];
    if (v === undefined) {
      if (field.default !== undefined) v = field.default;
      else {
        if (field.required) invalid(key, "is required");
        continue;
      }
    }
    out[key] = v;
    switch (field.kind) {
      case "text":
        if (typeof v !== "string") invalid(key, "must be text");
        break;
      case "boolean":
        if (typeof v !== "boolean") invalid(key, "must be true or false");
        break;
      case "int":
        if (!Number.isSafeInteger(v)) invalid(key, "must be a whole number");
        else if (field.min !== undefined && (v as number) < field.min) invalid(key, `must be >= ${field.min}`);
        else if (field.max !== undefined && (v as number) > field.max) invalid(key, `must be <= ${field.max}`);
        break;
      case "choice":
        if (typeof v !== "string" || !(field.choices ?? []).includes(v)) invalid(key, `must be one of ${(field.choices ?? []).join(", ")}`);
        break;
      case "type": {
        const problem = typeRefShapeProblem(v, key);
        if (problem) invalid(key, `must be a type (${problem.path} ${problem.reason})`);
        else if (containsVar(v as TypeRef)) invalid(key, "cannot contain generic types");
        else for (const id of collectNamedIds(v as TypeRef)) if (!scope.getType(id)) unknownRef(key, "type", id);
        break;
      }
      case "typeId": {
        if (typeof v !== "string") {
          invalid(key, "must be a type id");
          break;
        }
        const entry = scope.getType(v);
        const kind = field.typeKind ?? "any";
        if (!entry) unknownRef(key, "type", v);
        else if (kind !== "any" && entry.decl.kind !== kind) unknownRef(key, kind, v, ` (it is ${entry.decl.kind === "enum" ? "an enum" : "a struct"})`);
        break;
      }
      case "flowVariable":
        if (typeof v !== "string") invalid(key, "must be a variable id");
        else if (!flow.variables.some((x) => x.id === v)) unknownRef(key, "variable", v);
        break;
      case "global": {
        if (typeof v !== "string") {
          invalid(key, "must be a global id");
          break;
        }
        const g = doc.globals.find((x) => x.id === v);
        if (!g) unknownRef(key, "global", v);
        else if (field.writable && g.access === "readonly") {
          diagnostics.push({
            severity: "error",
            code: "variable.write_to_readonly",
            message: node
              ? `${nodeLabel(node, def)} writes readonly global "${g.name}". Make the global readwrite or remove the node.`
              : `Global "${g.name}" is readonly. Make it readwrite to write it from a flow.`,
            path: { ...at(key), globalId: g.id },
          });
        }
        break;
      }
    }
  }
  return { ok: diagnostics.length === 0, config: out, diagnostics };
}
