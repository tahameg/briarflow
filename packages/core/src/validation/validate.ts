/**
 * Context and flow validation (docs/ARCHITECTURE.md §4.10). Never throws for document
 * problems; returns diagnostics in a deterministic order (structure, types, signature,
 * variables, nodes, edges, cycles, variable ordering; document order inside each group).
 */
import type { ContextDocument, FlowDocument, TypeDecl } from "../documents/model.js";
import { FLOW_INPUT_NODE_TYPE, FLOW_OUTPUT_NODE_TYPE, VARIABLE_NODE_TYPES } from "../documents/model.js";
import { findFlow } from "../documents/factories.js";
import type { NodeCatalog } from "../nodes/catalog.js";
import { findCycle } from "../nodes/pack.js";
import { isAssignable } from "../types/assignability.js";
import { constraintMessage, constraintProblemsDeep } from "../types/constraints.js";
import { collectTypeVars } from "../types/generics.js";
import type { TypeRef } from "../types/ir.js";
import type { TypeScope } from "../types/scope.js";
import { flowNotFound, scopeForContext, scopeForFlow } from "../types/scope.js";
import { formatType } from "../types/shorthand.js";
import { collectNamedIds, containsVar } from "../types/walk.js";
import { RESERVED_TYPE_NAMES, TYPE_NAME_PATTERN } from "../util/names.js";
import { validateValue } from "../values/validate.js";
import type { Diagnostic, DiagnosticPath } from "./diagnostic.js";
import { buildAdjacency, findCycles } from "./graph.js";
import { nodeLabel } from "./labels.js";
import { resolveFlowPorts } from "./ports.js";
import { computeVariableOrder } from "./variables.js";
import { analyzeExec } from "./exec.js";

const VARIABLE_TYPES: readonly string[] = Object.values(VARIABLE_NODE_TYPES);

/**
 * Validates one flow: structure (`flow.builtin_missing`, duplicate ids), node types, config,
 * ports, edges (`edge.type_mismatch`, `edge.unknown_port`, dangling edges), generics, constants
 * (`node.invalid_value`), `input.unconnected`, `output.unconnected`, cycles (`flow.cycle`),
 * local types, signature visibility, variables (variables.md §5). Throws
 * `BriarError("flow.not_found")` for an unknown flow id.
 *
 * @example
 * ```ts
 * const errors = validateFlow(doc, "flow_p", catalog).filter((d) => d.severity === "error");
 * ```
 */
export function validateFlow(doc: ContextDocument, flowId: string, catalog: NodeCatalog): Diagnostic[] {
  const flow = findFlow(doc, flowId);
  if (!flow) throw flowNotFound(doc, flowId);
  const out: Diagnostic[] = [];
  const scope = scopeForFlow(doc, flowId, catalog);
  const err = (code: string, message: string, path: DiagnosticPath, details?: unknown) =>
    out.push({ severity: "error", code, message, path: { flowId, ...path }, ...(details === undefined ? {} : { details }) });

  // Structure.
  const inputs = flow.nodes.filter((n) => n.type === FLOW_INPUT_NODE_TYPE).length;
  const outputs = flow.nodes.filter((n) => n.type === FLOW_OUTPUT_NODE_TYPE).length;
  if (inputs !== 1 || outputs !== 1) {
    err("flow.builtin_missing", `Flow "${flow.name}" must have exactly one Input and one Output node.`, {}, { inputNodes: inputs, outputNodes: outputs });
  }
  for (const [kind, items] of [
    ["node", flow.nodes],
    ["edge", flow.edges],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        err("flow.duplicate_id", `Flow "${flow.name}" has two ${kind}s with id "${item.id}". Ids must be unique; give one a new id.`, kind === "node" ? { nodeId: item.id } : { edgeId: item.id });
      }
      seen.add(item.id);
    }
  }

  // Local types.
  const globalNames = new Set(doc.types.map((t) => t.name));
  out.push(...checkTypeDecls(flow.types, scope, `flow "${flow.name}"`, { flowId }, undefined));
  for (const t of flow.types) {
    if (globalNames.has(t.name)) {
      out.push({
        severity: "warning",
        code: "type.shadows_global",
        message: `Local type "${t.name}" in flow "${flow.name}" hides the global type with the same name.`,
        path: { flowId, typeId: t.id },
      });
    }
  }

  // Signature.
  for (const [side, fields] of [
    ["input", flow.inputs],
    ["output", flow.outputs],
  ] as const) {
    for (const f of fields) {
      const at = { flowId, field: f.name };
      const ok = checkTypeRef(f.type, `Flow ${side} "${f.name}"`, scope, at, out, undefined);
      for (const id of collectNamedIds(f.type)) {
        const entry = scope.getType(id);
        if (entry?.origin === "local") {
          err(
            "visibility.local_type_in_public_signature",
            `Flow ${side} "${f.name}" uses local type "${entry.decl.name}". Public signatures can only use primitives, global types and pack types. Move "${entry.decl.name}" to global types.`,
            { field: f.name, typeId: id },
          );
        }
      }
      if (ok && f.default !== undefined) {
        const d = validateValue(f.default, f.type, scope, { path: `${side}s.${f.name}`, at });
        if (d[0]) err("type.invalid_default", `Default value of flow ${side} "${f.name}" is not valid: ${d[0].message}.`, { field: f.name }, { diagnostics: d });
      }
    }
  }

  // Variables.
  const used = new Set(flow.nodes.map((n) => n.config?.["variableId"]).filter((x) => typeof x === "string"));
  for (const v of flow.variables) {
    const at = { flowId, variableId: v.id };
    const ok = checkTypeRef(v.type, `Variable "${v.name}"`, scope, at, out, undefined);
    if (v.access === "public") {
      for (const id of collectNamedIds(v.type)) {
        const entry = scope.getType(id);
        if (entry?.origin === "local") {
          err(
            "visibility.local_type_in_public_variable",
            `Public variable "${v.name}" uses local type "${entry.decl.name}". Make the variable private or move the type to global.`,
            { variableId: v.id, typeId: id },
          );
        }
      }
    }
    if (ok && v.default !== undefined) {
      const d = validateValue(v.default, v.type, scope, { path: `variables.${v.name}`, at });
      if (d[0]) err("variable.invalid_default", `Default of variable "${v.name}": ${d[0].message}`, { variableId: v.id }, { diagnostics: d });
    }
    if (v.access === "private" && !used.has(v.id)) {
      out.push({ severity: "warning", code: "variable.unused", message: `Variable "${v.name}" is never read or written.`, path: at });
    }
  }

  // Nodes.
  const ports = resolveFlowPorts(doc, flowId, catalog);
  const byId = new Map(flow.nodes.map((n) => [n.id, n] as const));
  const connected = new Set(flow.edges.map((e) => `${e.to.node}\u0000${e.to.port}`));
  const portsUnknown = new Set<string>();
  for (const [nodeId, rn] of ports.nodes) {
    const node = byId.get(nodeId);
    if (!node) continue;
    const isVariableNode = VARIABLE_TYPES.includes(node.type);
    for (const d of rn.diagnostics) {
      if (isVariableNode && (d.code === "config.unknown_ref" || d.code === "variable.write_to_readonly")) continue;
      if (d.code === "node.unknown_type" || d.code === "node.ports_unresolved") portsUnknown.add(nodeId);
      if (d.code.startsWith("config.") && rn.definition?.resolvePorts) portsUnknown.add(nodeId);
      out.push(d);
    }
    const label = nodeLabel(node, rn.definition);
    // Constants (only unconnected ports; connected ones are kept but ignored).
    for (const [port, value] of Object.entries(node.values ?? {})) {
      if (value === undefined || connected.has(`${nodeId}\u0000${port}`)) continue;
      const p = rn.inputs.find((x) => x.name === port);
      if (!p || containsVar(p.type)) continue;
      for (const d of validateValue(value, p.type, scope, { path: `nodes.${nodeId}.values.${port}`, at: { flowId, nodeId, port } })) {
        out.push({ ...d, code: "node.invalid_value", message: `Constant ${label}.${port}: ${d.message}`, details: { code: d.code } });
      }
    }
    // Unbound generics.
    const reported = new Set<string>();
    for (const p of rn.inputs) {
      for (const v of collectTypeVars(p.type)) {
        if (reported.has(v)) continue;
        reported.add(v);
        err("node.generic_unbound", `${label} does not know its type yet. Connect a value to "${p.name}".`, { nodeId, port: p.name }, { varName: v });
      }
    }
    // Unconnected inputs / flow outputs.
    for (const p of rn.inputs) {
      if (connected.has(`${nodeId}\u0000${p.name}`)) continue;
      if (node.values?.[p.name] !== undefined) continue;
      if (node.type === FLOW_OUTPUT_NODE_TYPE) {
        err("output.unconnected", `Flow output "${p.name}" is not connected. Connect it or remove it from the signature.`, { nodeId, port: p.name });
        continue;
      }
      if (p.hasDefault || p.type.kind === "optional" || containsVar(p.type)) continue;
      err("input.unconnected", `${label} needs a value for "${p.name}". Connect an edge or type a constant.`, { nodeId, port: p.name });
    }
  }

  // Edges.
  const intoInput = new Map<string, string[]>();
  for (const e of flow.edges) {
    const from = byId.get(e.from.node);
    const to = byId.get(e.to.node);
    let missing = false;
    for (const [end, node] of [
      [e.from, from],
      [e.to, to],
    ] as const) {
      if (!node) {
        missing = true;
        err("edge.unknown_node", `Edge ${e.id} points to node "${end.node}", which does not exist in flow "${flow.name}". Remove the edge.`, { edgeId: e.id }, { node: end.node });
      }
    }
    if (missing || !from || !to) continue;
    const key = `${e.to.node}\u0000${e.to.port}`;
    const prior = intoInput.get(key) ?? [];
    intoInput.set(key, [...prior, e.id]);
    if (prior.length > 0) {
      err(
        "edge.duplicate_input",
        `${nodeLabel(to, ports.nodes.get(to.id)?.definition)} input "${e.to.port}" has more than one incoming edge (${[...prior, e.id].join(", ")}). Remove all but one.`,
        { edgeId: e.id, nodeId: to.id, port: e.to.port },
        { edgeIds: [...prior, e.id] },
      );
    }
    const rf = ports.nodes.get(from.id);
    const rt = ports.nodes.get(to.id);
    if (!rf || !rt) continue;
    const fromLabel = nodeLabel(from, rf.definition);
    const toLabel = nodeLabel(to, rt.definition);
    const fp = rf.outputs.find((p) => p.name === e.from.port);
    const tp = rt.inputs.find((p) => p.name === e.to.port);
    let portMissing = false;
    if (!fp && !portsUnknown.has(from.id)) {
      portMissing = true;
      const list = rf.outputs.map((p) => p.name).join(", ") || "none";
      err("edge.unknown_port", `${fromLabel} has no output "${e.from.port}". Outputs: ${list}.`, { edgeId: e.id, nodeId: from.id, port: e.from.port });
    }
    if (!tp && !portsUnknown.has(to.id)) {
      portMissing = true;
      const list = rt.inputs.map((p) => p.name).join(", ") || "none";
      err("edge.unknown_port", `${toLabel} has no input "${e.to.port}". Inputs: ${list}.`, { edgeId: e.id, nodeId: to.id, port: e.to.port });
    }
    if (portMissing || !fp || !tp || containsVar(fp.type) || containsVar(tp.type)) continue;
    if (!isAssignable(fp.type, tp.type)) {
      const hint = mismatchHint(fp.type, tp.type);
      err(
        "edge.type_mismatch",
        `Cannot connect ${fromLabel}.${fp.name} (${formatType(fp.type, scope)}) to ${toLabel}.${tp.name} (${formatType(tp.type, scope)}).${hint ? ` ${hint}` : ""}`,
        { edgeId: e.id },
        { from: fp.type, to: tp.type },
      );
    }
  }

  // Data cycles.
  const nodeIds = [...new Set(flow.nodes.map((n) => n.id))];
  const adj = buildAdjacency(
    nodeIds,
    flow.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
  );
  for (const cycle of findCycles(adj)) {
    const text = cycle.map((id) => {
      const n = byId.get(id);
      return n ? nodeLabel(n, ports.nodes.get(id)?.definition) : id;
    });
    err("flow.cycle", `Flow "${flow.name}" has a loop: ${text.join(" → ")}.`, { nodeId: cycle[0] as string }, { cycle });
  }

  // Data-driven flows (no execution lines yet): variable writes are ordered by the data graph.
  if (flow.execEdges === undefined) {
    out.push(...computeVariableOrder(doc, flowId, catalog).diagnostics);
    return out;
  }
  // Execution lines decide what runs and in which order. Nodes off the line never run, so
  // their problems are not reported; problems of wires stay.
  const exec = analyzeExec(doc, flow, catalog);
  const kept = out.filter((d) => d.path.nodeId === undefined || exec.live.has(d.path.nodeId) || d.code.startsWith("edge."));
  return [...kept, ...exec.diagnostics];
}

function mismatchHint(from: TypeRef, to: TypeRef): string {
  const target = to.kind === "optional" ? to.of : to;
  if (from.kind === "list" && isAssignable(from.of, to)) return "Use list.get to pick one item.";
  if (target.kind === "primitive" && target.name === "text") return "Use convert.toText to turn it into text.";
  return "";
}

/**
 * Validates the whole context: global types (`type.*`, `visibility.local_type_in_global`,
 * `type.recursive`, `type.enum_empty`, `type.invalid_default`), globals
 * (`global.invalid_value`, readonly without value), flow name uniqueness, then every flow
 * via {@link validateFlow}.
 *
 * @example
 * ```ts
 * const diagnostics = validateContext(doc, catalog);
 * ```
 */
export function validateContext(doc: ContextDocument, catalog: NodeCatalog): Diagnostic[] {
  const out: Diagnostic[] = [];
  const scope = scopeForContext(doc, catalog);
  const localOwner = new Map<string, FlowDocument>();
  for (const f of doc.flows) for (const t of f.types) if (!localOwner.has(t.id)) localOwner.set(t.id, f);

  // Flows: ids and names.
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const f of doc.flows) {
    if (ids.has(f.id)) {
      out.push({
        severity: "error",
        code: "flow.duplicate_id",
        message: `Context "${doc.name}" has two flows with id "${f.id}". Flow ids must be unique; give one a new id.`,
        path: { flowId: f.id },
      });
    }
    ids.add(f.id);
    const existing = names.get(f.name.toLowerCase());
    if (existing !== undefined) {
      out.push({
        severity: "error",
        code: "flow.duplicate_name",
        message: `A flow named "${existing}" already exists in context "${doc.name}". Names must be unique (ignoring case).`,
        path: { flowId: f.id },
      });
    } else names.set(f.name.toLowerCase(), f.name);
  }

  out.push(...checkTypeDecls(doc.types, scope, "global types", {}, localOwner));

  for (const g of doc.globals) {
    const at = { globalId: g.id };
    const ok = checkTypeRef(g.type, `Global "${g.name}"`, scope, at, out, localOwner);
    if (g.access === "readonly" && g.value === undefined) {
      out.push({
        severity: "error",
        code: "global.readonly_requires_value",
        message: `Readonly global "${g.name}" needs a value. Set a value or make it readwrite.`,
        path: at,
      });
    }
    if (ok && g.value !== undefined) {
      const d = validateValue(g.value, g.type, scope, { path: `globals.${g.name}`, at });
      if (d[0]) {
        out.push({
          severity: "error",
          code: "global.invalid_value",
          message: `Value of global "${g.name}": ${d[0].message}`,
          path: at,
          details: { diagnostics: d },
        });
      }
    }
  }

  const done = new Set<string>();
  for (const f of doc.flows) {
    if (done.has(f.id)) continue;
    done.add(f.id);
    out.push(...validateFlow(doc, f.id, catalog));
  }
  return out;
}

/**
 * Checks a type ref written somewhere (`where`). Pushes `type.var_not_allowed`,
 * `type.invalid_constraint`, `type.unknown_id` or (at global level, when `localOwner` is
 * given) `visibility.local_type_in_global`. Returns false when ids could not be resolved.
 */
function checkTypeRef(
  type: TypeRef,
  where: string,
  scope: TypeScope,
  at: DiagnosticPath,
  out: Diagnostic[],
  localOwner: Map<string, FlowDocument> | undefined,
): boolean {
  let ok = true;
  for (const name of collectTypeVars(type)) {
    ok = false;
    out.push({ severity: "error", code: "type.var_not_allowed", message: `Generic type "$${name}" can only be used in node definitions.`, path: at });
  }
  for (const p of constraintProblemsDeep(type)) {
    out.push({ severity: "error", code: "type.invalid_constraint", message: constraintMessage(p, where), path: at, details: { constraint: p.constraint } });
  }
  for (const id of collectNamedIds(type)) {
    if (scope.getType(id)) continue;
    ok = false;
    const owner = localOwner?.get(id);
    const local = owner?.types.find((t) => t.id === id);
    if (owner && local) {
      out.push({
        severity: "error",
        code: "visibility.local_type_in_global",
        message: `${where} uses local type "${local.name}", which is only visible inside flow "${owner.name}". Move it to global types first.`,
        path: at,
        details: { id },
      });
    } else {
      out.push({
        severity: "error",
        code: "type.unknown_id",
        message: `${where} refers to type id ${id}, which no longer exists. Pick another type.`,
        path: at,
        details: { id },
      });
    }
  }
  return ok;
}

function checkTypeDecls(
  decls: readonly TypeDecl[],
  scope: TypeScope,
  scopeLabel: string,
  base: DiagnosticPath,
  localOwner: Map<string, FlowDocument> | undefined,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const names = new Map<string, string>();
  const visible = scope.all().map((e) => e.decl);
  for (const t of decls) {
    const at = { ...base, typeId: t.id };
    if (RESERVED_TYPE_NAMES.includes(t.name)) {
      out.push({ severity: "error", code: "type.reserved_name", message: `"${t.name}" is reserved. Choose another type name.`, path: at });
    } else if (t.name.length > 64 || !TYPE_NAME_PATTERN.test(t.name)) {
      out.push({
        severity: "error",
        code: "type.invalid_name",
        message: `"${t.name}" is not a valid type name. Type names start with an uppercase letter and use letters, digits and _ (e.g. Character).`,
        path: at,
      });
    }
    const existing = names.get(t.name.toLowerCase());
    if (existing !== undefined) {
      out.push({
        severity: "error",
        code: "type.duplicate_name",
        message: `A type named "${existing}" already exists in ${scopeLabel}. Names must be unique (ignoring case).`,
        path: at,
      });
    } else names.set(t.name.toLowerCase(), t.name);
    if (t.kind === "enum") {
      if (t.members.length === 0) {
        out.push({ severity: "warning", code: "type.enum_empty", message: `Enum "${t.name}" has no members, so no value can be valid. Add a member.`, path: at });
      }
      continue;
    }
    const chain = findCycle(t.id, visible);
    if (chain) {
      out.push({
        severity: "error",
        code: "type.recursive",
        message: `Type "${t.name}" contains itself through ${chain}. Recursive types are not supported.`,
        path: at,
        details: { chain },
      });
    }
    for (const f of t.fields) {
      const fat = { ...at, field: f.name };
      const ok = checkTypeRef(f.type, `Field "${t.name}.${f.name}"`, scope, fat, out, localOwner);
      if (ok && !chain && f.default !== undefined) {
        const d = validateValue(f.default, f.type, scope, { path: `${t.name}.${f.name}`, at: fat });
        if (d[0]) {
          out.push({
            severity: "error",
            code: "type.invalid_default",
            message: `Default value of field "${t.name}.${f.name}" is not valid: ${d[0].message}.`,
            path: fat,
            details: { diagnostics: d },
          });
        }
      }
    }
  }
  return out;
}
