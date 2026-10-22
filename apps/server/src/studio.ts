/**
 * The studio's start target: the context (and flow) it opens first, configured with
 * `BRIAR_STUDIO_CONTEXT` / `BRIAR_STUDIO_FLOW` and served at `GET /api/studio`.
 */
import type { Logger } from "@briarflow/core";
import type { Briar } from "briarflow";
import type { ServerConfig } from "./config.js";

/** Ids the studio opens first; empty when nothing is configured. */
export interface StudioStart {
  contextId?: string;
  flowId?: string;
}

/**
 * Makes sure the configured start context and flow exist and returns their ids. Each is
 * matched by id, then by name, and created (with that name) when missing.
 *
 * @example
 * ```ts
 * await ensureStudioStart(briar, { context: "Marketing", flow: "Portrait" }, logger);
 * // → { contextId: "ctx_…", flowId: "flow_…" }
 * ```
 */
export async function ensureStudioStart(briar: Briar, start: ServerConfig["studioStart"], logger: Logger): Promise<StudioStart> {
  if (start.context === undefined) return {};
  let contextId: string | undefined;
  let byName: string | undefined;
  for await (const c of briar.contexts.iterate()) {
    if (c.id === start.context) {
      contextId = c.id;
      break;
    }
    if (c.name === start.context) byName ??= c.id;
  }
  contextId ??= byName;
  if (contextId === undefined) {
    contextId = (await briar.contexts.create({ name: start.context })).id;
    logger.info("studio.context_created", { contextId, name: start.context });
  }
  if (start.flow === undefined) return { contextId };

  const ctx = await briar.contexts.get(contextId);
  const flows = ctx.doc.flows;
  const flow = flows.find((f) => f.id === start.flow) ?? flows.find((f) => f.name === start.flow);
  if (flow) return { contextId, flowId: flow.id };
  const result = await briar.applyCommands(contextId, { baseRevision: ctx.revision, commands: [{ op: "flow.create", name: start.flow }] });
  const flowId = result.created[0]?.flowId;
  if (typeof flowId !== "string") return { contextId };
  logger.info("studio.flow_created", { contextId, flowId, name: start.flow });
  return { contextId, flowId };
}
