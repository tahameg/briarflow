/**
 * Flow control nodes (docs/specs/execution.md §7): nodes that steer the execution line.
 *
 * - A **route** node (Branch, Switch) runs like any line node, then picks which of its
 *   execution outputs the line follows.
 * - A **loop** node (For each, For range) runs its `body` line once per iteration, with its
 *   data outputs set to that iteration's values, then follows `completed`.
 */
import type { TypeDecl } from "../documents/model.js";
import type { NodeRunArgs } from "./exec.js";

/** What decides a node's execution outputs: a fixed list, or one computed from its config. */
export type ExecOutputList =
  | readonly string[]
  | ((args: { config: Readonly<Record<string, unknown>>; resolveType(id: string): TypeDecl | undefined }) => readonly string[]);

/** `route` gets what `run` gets plus what `run` returned. */
export type RouteArgs = NodeRunArgs<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>> & {
  outputs: Readonly<Record<string, unknown>>;
};

/** A node that picks the execution output the line follows (Branch, Switch). */
export interface RouteControl {
  kind: "route";
  /** Its execution outputs (instead of `then`). */
  outputs: ExecOutputList;
  /** The output to follow, one of `outputs`. Called after `run` succeeds. */
  route(args: RouteArgs): string;
}

/** A node that runs its body line once per iteration (For each, For range). */
export interface LoopControl {
  kind: "loop";
  /** Execution output run once per iteration. Default `"body"`. */
  body: string;
  /** Execution output followed after the last iteration. Default `"completed"`. */
  completed: string;
  /**
   * The data outputs of every iteration, in order (computed once when the node is reached).
   * An empty list skips the body.
   */
  iterations(args: NodeRunArgs<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>): readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;
}

/** How a flow control node steers the line. */
export type NodeControl = RouteControl | LoopControl;

/** Default names of a loop's execution outputs. */
export const LOOP_BODY = "body";
export const LOOP_COMPLETED = "completed";

/** The execution outputs a control node declares, for a node with `config`. */
export function controlOutputs(control: NodeControl, config: Readonly<Record<string, unknown>> = {}, resolveType: (id: string) => TypeDecl | undefined = () => undefined): readonly string[] {
  if (control.kind === "loop") return [control.body, control.completed];
  return typeof control.outputs === "function" ? control.outputs({ config, resolveType }) : control.outputs;
}
