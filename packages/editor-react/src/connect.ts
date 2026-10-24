/**
 * "Drop a wire on empty canvas" matching: which node types (with a given config) have a port
 * that a dragged output can feed, or that can feed a dragged input. Ports are resolved the
 * same way the canvas resolves them, so dynamic, variable and variant nodes work too.
 */
import { bindTypeVars, containsVar, isAssignable, resolveFlowPorts, substituteTypeVars } from "@briarflow/core";
import type { ContextDocument, NodeCatalog, TypeRef } from "@briarflow/core";

/** A node the user could add: its type and the config it would be added with. */
export interface ConnectProbe {
  /** Caller's key for the result. */
  key: string;
  type: string;
  /** Variant of a node type with variants. Default: its default variant. */
  variant?: string;
  config?: Record<string, unknown>;
}

/** A probe with a matching port. */
export interface ConnectMatch {
  key: string;
  /** Port of the new node to wire. */
  port: string;
  portTitle: string;
  /** The port is generic (`$T`): it accepts anything rather than this type in particular. */
  generic: boolean;
}

const PROBE_PREFIX = "n__probe";

/**
 * For each probe, the first port on the opposite side that fits `type`: an input accepting it
 * when dragging from an output (`from: "out"`), an output assignable to it when dragging from
 * an input (`from: "in"`). Exact type matches win over generic ports.
 *
 * @example
 * ```ts
 * matchConnectTargets(doc, "flow_p", catalog, { kind: "primitive", name: "text" }, "out", [{ key: "join", type: "text.join" }]);
 * // → [{ key: "join", port: "separator", portTitle: "Separator", generic: false }]
 * ```
 */
export function matchConnectTargets(
  doc: ContextDocument,
  flowId: string,
  catalog: NodeCatalog,
  type: TypeRef,
  from: "out" | "in",
  probes: readonly ConnectProbe[],
): ConnectMatch[] {
  const flow = doc.flows.find((f) => f.id === flowId);
  if (!flow || probes.length === 0) return [];
  const probeDoc: ContextDocument = {
    ...doc,
    flows: doc.flows.map((f) =>
      f.id !== flowId
        ? f
        : {
            ...f,
            nodes: [
              ...f.nodes,
              ...probes.map((p, i) => ({
                id: `${PROBE_PREFIX}${i}`,
                type: p.type,
                position: { x: 0, y: 0 },
                ...(p.variant === undefined ? {} : { variant: p.variant }),
                ...(p.config ? { config: p.config } : {}),
              })),
            ],
          },
    ),
  };
  let resolved: ReturnType<typeof resolveFlowPorts>;
  try {
    resolved = resolveFlowPorts(probeDoc, flowId, catalog);
  } catch {
    return [];
  }
  const fits = (port: TypeRef) => (from === "out" ? isAssignable(type, port) : isAssignable(port, type));
  // A generic port fits when binding its type variables to the dragged type makes it fit
  // (`$T` takes anything, `list<$T>` only lists).
  const fitsGeneric = (name: string, port: TypeRef) => {
    const r = bindTypeVars([{ port: name, direction: from === "out" ? "input" : "output", pattern: port, other: type }]);
    if (!r.ok) return false;
    const bound = substituteTypeVars(port, r.bindings);
    return !containsVar(bound) && fits(bound);
  };
  const out: ConnectMatch[] = [];
  probes.forEach((probe, i) => {
    const node = resolved.nodes.get(`${PROBE_PREFIX}${i}`);
    const ports = (from === "out" ? node?.inputs : node?.outputs) ?? [];
    // `declaredType`: a var limited by `oneOf` is bound to its first type while unconnected.
    const exact = ports.find((p) => !containsVar(p.declaredType) && fits(p.type));
    const generic = exact ? undefined : ports.find((p) => containsVar(p.declaredType) && fitsGeneric(p.name, p.declaredType));
    const hit = exact ?? generic;
    if (hit) out.push({ key: probe.key, port: hit.name, portTitle: hit.title, generic: hit === generic });
  });
  return out;
}
