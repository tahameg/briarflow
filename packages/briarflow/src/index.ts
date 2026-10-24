/**
 * briarflow — the Briarflow facade: `createBriar()` wires stores, packs, secrets and the
 * runtime (ARCHITECTURE.md §6.2, docs/tasks/phase-4.md). The main entry is portable: no
 * `node:*` imports.
 *
 * @example
 * ```ts
 * import { createBriar } from "briarflow";
 * import { mockPack } from "@briarflow/nodes-mock";
 *
 * const briar = createBriar({ packs: [mockPack] });
 * const ctx = await briar.contexts.create({ name: "Demo" });
 * const flow = ctx.flows.create("Echo");
 * flow.inputs.add("topic", "text").outputs.add("reply", "text");
 * const llm = flow.nodes.add("mock.llm");
 * flow.connect(flow.input.port("topic"), llm.port("prompt"));
 * flow.connect(llm.port("text"), flow.output.port("reply"));
 * await ctx.save();
 * const result = await (await briar.run(flow.id, { topic: "cats" })).result;
 * ```
 */
export const PACKAGE_NAME = "briarflow";

export { createBriar } from "./briar.js";
export type { ApplyCommandsRequest, ApplyCommandsResult, Briar, BriarOptions, BriarRunOptions, FlowInfo, NodeTypesInfo, SettingInfo, SettingsInfo } from "./briar.js";
export type {
  AddNodeOptions,
  ContextHandle,
  FieldLike,
  FlowHandle,
  GlobalHandle,
  NodeHandle,
  PositionLike,
  TypeHandle,
  TypeLike,
  TypesApi,
  VariableHandle,
} from "./handles.js";
export type { BriarRun, GlobalWriteStatus, RunInfo, RunListFilter, RunRetention } from "./runs.js";
export { MemoryContextStore } from "./memory-context-store.js";
export { MemoryMediaStore } from "./memory-media-store.js";
export type { MemoryMediaStoreOptions } from "./memory-media-store.js";
export { envSecrets, noSecrets, staticSecrets } from "./secrets.js";
export type { EnvSecretsOptions } from "./secrets.js";
