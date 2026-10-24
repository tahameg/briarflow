/**
 * Batch runner: payload checks, handler dispatch, port follow-up, inverses, revision.
 */
import { createIdGenerator, jsonEquals, validateContext, type ContextDocument } from "@briarflow/core";
import type { ApplyOptions } from "../apply.js";
import type { Command, CommandOp } from "../commands.js";
import { CommandError, type BatchResult, type CreatedIds } from "../result.js";
import type { Ctx, Effect, Payload } from "./ctx.js";
import * as g from "./handlers/graph.js";
import * as x from "./handlers/exec.js";
import * as f from "./handlers/flows.js";
import * as t from "./handlers/types.js";
import * as v from "./handlers/vars.js";
import { createPortsCache, normalize, type PortsOf } from "./normalize.js";
import { checkPayload } from "./payload.js";

type Handler = (ctx: Ctx, p: Payload, ports: PortsOf) => Effect;

const HANDLERS: Record<CommandOp, Handler> = {
  "context.rename": f.contextRename,
  "context.setDescription": f.contextSetDescription,
  "type.defineStruct": t.typeDefineStruct,
  "type.defineEnum": t.typeDefineEnum,
  "type.rename": t.typeRename,
  "type.setDescription": t.typeSetDescription,
  "type.delete": t.typeDelete,
  "type.moveScope": t.typeMoveScope,
  "type.field.add": t.fieldAdd,
  "type.field.remove": t.fieldRemove,
  "type.field.rename": t.fieldRename,
  "type.field.setType": t.fieldSetType,
  "type.field.reorder": t.fieldReorder,
  "type.field.setDescription": t.fieldSetDescription,
  "type.field.setDefault": t.fieldSetDefault,
  "type.field.clearDefault": t.fieldClearDefault,
  "type.enum.addMember": t.memberAdd,
  "type.enum.removeMember": t.memberRemove,
  "type.enum.renameMember": t.memberRename,
  "type.enum.setMemberLabel": t.memberSetLabel,
  "global.create": v.globalCreate,
  "global.rename": v.globalRename,
  "global.setType": v.globalSetType,
  "global.setAccess": v.globalSetAccess,
  "global.setValue": v.globalSetValue,
  "global.clearValue": v.globalClearValue,
  "global.setDescription": v.globalSetDescription,
  "global.delete": v.globalDelete,
  "flow.create": f.flowCreate,
  "flow.rename": f.flowRename,
  "flow.setDescription": f.flowSetDescription,
  "flow.duplicate": f.flowDuplicate,
  "flow.delete": f.flowDelete,
  "flow.setViewport": f.flowSetViewport,
  "flow.input.add": v.sigAdd,
  "flow.input.remove": v.sigRemove,
  "flow.input.rename": v.sigRename,
  "flow.input.setType": v.sigSetType,
  "flow.input.reorder": v.sigReorder,
  "flow.input.setDescription": v.sigSetDescription,
  "flow.input.setDefault": v.inputSetDefault,
  "flow.input.clearDefault": v.inputClearDefault,
  "flow.output.add": v.sigAdd,
  "flow.output.remove": v.sigRemove,
  "flow.output.rename": v.sigRename,
  "flow.output.setType": v.sigSetType,
  "flow.output.reorder": v.sigReorder,
  "flow.output.setDescription": v.sigSetDescription,
  "flow.variable.create": v.variableCreate,
  "flow.variable.rename": v.variableRename,
  "flow.variable.setType": v.variableSetType,
  "flow.variable.setAccess": v.variableSetAccess,
  "flow.variable.setDefault": v.variableSetDefault,
  "flow.variable.clearDefault": v.variableClearDefault,
  "flow.variable.setDescription": v.variableSetDescription,
  "flow.variable.delete": v.variableDelete,
  "node.add": g.nodeAdd,
  "node.remove": g.nodeRemove,
  "node.move": g.nodeMove,
  "node.setTitle": g.nodeSetTitle,
  "node.setValue": g.nodeSetValue,
  "node.clearValue": g.nodeClearValue,
  "node.setConfig": g.nodeSetConfig,
  "node.setVariant": g.nodeSetVariant,
  "edge.connect": g.edgeConnect,
  "edge.disconnect": g.edgeDisconnect,
  "exec.connect": x.execConnect,
  "exec.disconnect": x.execDisconnect,
  "flow.exec.enable": x.flowExecEnable,
  "flow.exec.set": x.flowExecSet,
};

/** Implementation of `applyCommands`. */
export function runBatch(doc: ContextDocument, commands: readonly Command[], options: ApplyOptions): BatchResult {
  const ids = options.idGenerator ?? createIdGenerator();
  const clock = options.clock ?? (() => new Date());
  const ports = createPortsCache(options.catalog);
  if (!Array.isArray(commands)) {
    return { ok: false, error: new CommandError("command.invalid_payload", "Commands must be a list of command objects.", { details: {} }) };
  }
  let cur = doc;
  const created: CreatedIds[] = [];
  const resolved: Command[] = [];
  const inverses: Command[][] = [];
  for (let i = 0; i < commands.length; i++) {
    const raw = commands[i] as unknown;
    let op: string | undefined;
    try {
      op = checkPayload(raw);
      const p = raw as Payload;
      const ctx: Ctx = { doc: cur, catalog: options.catalog, ids, restore: p["restore"] === true, op };
      const effect = HANDLERS[op as CommandOp](ctx, p, ports);
      let next = ctx.doc;
      let prune: Command[] = [];
      if (effect.touched !== "none" && next !== cur) {
        const n = normalize(cur, next, effect.touched, ports);
        next = n.doc;
        prune = n.inverse;
      }
      cur = next;
      created.push(effect.created ?? {});
      resolved.push(effect.resolved);
      inverses.push([...effect.inverse, ...prune]);
    } catch (err) {
      if (err instanceof CommandError) {
        const located = err.at(i, op ?? opOf(raw));
        return { ok: false, error: located };
      }
      throw err;
    }
  }
  if (jsonEquals(stripMeta(cur), stripMeta(doc))) {
    return { ok: true, doc, created, inverse: [], resolved, diagnostics: validateContext(doc, options.catalog), changed: false };
  }
  const final: ContextDocument = { ...cur, revision: doc.revision + 1, updatedAt: clock().toISOString() };
  const inverse = inverses
    .reverse()
    .flat()
    .map((c) => ({ ...c, restore: true }) as Command);
  return { ok: true, doc: final, created, inverse, resolved, diagnostics: validateContext(final, options.catalog), changed: true };
}

function stripMeta(doc: ContextDocument): unknown {
  return { ...doc, revision: 0, updatedAt: "" };
}

function opOf(raw: unknown): string | undefined {
  return typeof raw === "object" && raw !== null && typeof (raw as { op?: unknown }).op === "string" ? (raw as { op: string }).op : undefined;
}
