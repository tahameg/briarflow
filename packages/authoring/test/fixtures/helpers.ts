/**
 * Shared assertions for the authoring suites: deterministic options, deep-freeze, accept /
 * reject helpers and the generic undo / redo invariants (phase-2.md §5.1).
 */
import { expect } from "vitest";
import {
  applyCommands,
  CommandError,
  type ApplyOptions,
  type BatchResult,
  type Command,
} from "@briarflow/authoring";
import {
  createSequentialIdGenerator,
  isBriarError,
  resolveFlowPorts,
  validateContext,
  type Clock,
  type ContextDocument,
  type Diagnostic,
  type FlowDocument,
  type IdGenerator,
  type NodeInstance,
} from "@briarflow/core";
import { testCatalog } from "@briarflow/testing";

/** Time of the injected clock (differs from the fixtures' `updatedAt`). */
export const NOW = "2026-02-02T12:00:00.000Z";
export const clock: Clock = () => new Date(NOW);

/** Deterministic apply options (fresh sequential id generator each call). */
export function options(extra: Partial<ApplyOptions> = {}): ApplyOptions {
  return { catalog: testCatalog(), idGenerator: createSequentialIdGenerator(), clock, ...extra };
}

/** An id generator that must never be needed (used to re-apply `resolved`). */
export function otherIds(): IdGenerator {
  let i = 0;
  return (prefix) => `${prefix}_zz${++i}`;
}

/** Recursively freezes a value (returns it). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** A frozen deep copy. */
export function frozen(doc: ContextDocument): ContextDocument {
  return deepFreeze(structuredClone(doc));
}

/** The document without `revision` / `updatedAt`. */
export function strip(doc: ContextDocument): Omit<ContextDocument, "revision" | "updatedAt"> {
  const { revision: _r, updatedAt: _u, ...rest } = doc;
  void _r;
  void _u;
  return rest;
}

export type Ok = Extract<BatchResult, { ok: true }>;

function describeFailure(r: BatchResult): string {
  return r.ok ? "ok" : `${r.error.code} (index ${String(r.error.commandIndex)}): ${r.error.message}`;
}

/** Applies and asserts success; returns the result. No invariant checks (setup helper). */
export function build(doc: ContextDocument, commands: readonly Command[], opts: ApplyOptions = options()): ContextDocument {
  const r = applyCommands(doc, commands, opts);
  if (!r.ok) throw new Error(`setup batch rejected: ${describeFailure(r)}`);
  return r.doc;
}

export interface AcceptOptions {
  opts?: ApplyOptions;
  /** Skip the undo round trip (only for batches made of `flow.setViewport`). */
  noUndo?: boolean;
}

/**
 * Applies `commands` to a frozen copy of `doc`, asserts success and checks every common
 * invariant: input untouched, one `created`/`resolved` entry per command, diagnostics =
 * validateContext, revision/updatedAt, `changed: false` contract, every inverse command has
 * `restore: true`, undo round trip, redo (re-applying `resolved`, also with `restore: true` on
 * the undone document) gives the same document.
 */
export function accept(doc: ContextDocument, commands: readonly Command[], acceptOptions: AcceptOptions = {}): Ok {
  const opts = acceptOptions.opts ?? options();
  const before = frozen(doc);
  const snapshot = structuredClone(before);
  const r = applyCommands(before, commands, opts);
  expect(r.ok, `expected the batch to be accepted, got ${describeFailure(r)}`).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  expect(before).toEqual(snapshot);

  expect(r.created).toHaveLength(commands.length);
  expect(r.resolved).toHaveLength(commands.length);
  r.resolved.forEach((c, i) => expect(c.op).toBe(commands[i]!.op));
  expect(r.diagnostics).toEqual(validateContext(r.doc, opts.catalog));
  for (const c of r.inverse) expect(c.restore, `inverse ${c.op} must carry restore: true`).toBe(true);

  if (!r.changed) {
    expect(r.doc).toBe(before);
    expect(r.inverse).toEqual([]);
    return r;
  }
  expect(r.doc.revision).toBe(before.revision + 1);
  expect(r.doc.updatedAt).toBe(opts.clock!().toISOString());

  expectRedo(before, r, opts);
  if (!acceptOptions.noUndo) expectUndoRoundTrip(before, r, opts);
  return r;
}

/** Undo invariant: applying `inverse` to the result gives back `before` (minus revision/updatedAt). */
export function expectUndoRoundTrip(before: ContextDocument, r: Ok, opts: ApplyOptions = options()): ContextDocument {
  const after = frozen(r.doc);
  const u = applyCommands(after, r.inverse, { ...opts, idGenerator: otherIds() });
  expect(u.ok, `undo (inverse) rejected: ${describeFailure(u)}`).toBe(true);
  if (!u.ok) throw new Error("unreachable");
  expect(strip(u.doc)).toEqual(strip(before));
  // redo of an undo: resolved commands with restore: true on the undone document
  const again = applyCommands(
    frozen(u.doc),
    r.resolved.map((c) => ({ ...c, restore: true }) as Command),
    { ...opts, idGenerator: otherIds() },
  );
  expect(again.ok, `redo after undo rejected: ${describeFailure(again)}`).toBe(true);
  if (again.ok) expect(strip(again.doc)).toEqual(strip(r.doc));
  return u.doc;
}

/** Redo invariant: `resolved` re-applied to `before` with another id generator gives the same document. */
export function expectRedo(before: ContextDocument, r: Ok, opts: ApplyOptions = options()): void {
  const re = applyCommands(before, r.resolved, { ...opts, idGenerator: otherIds() });
  expect(re.ok, `re-applying resolved rejected: ${describeFailure(re)}`).toBe(true);
  if (re.ok) expect(strip(re.doc)).toEqual(strip(r.doc));
}

export interface RejectOptions {
  /** Index of the failing command (default: the last one). */
  index?: number;
  /** Exact message (string) or pattern. */
  message?: string | RegExp;
  /** Substrings the message must contain. */
  contains?: string[];
  opts?: ApplyOptions;
}

/** Applies to a frozen copy, asserts rejection with `code` at `index`; returns the error. */
export function reject(doc: ContextDocument, commands: readonly Command[], code: string, ro: RejectOptions = {}): CommandError {
  const before = frozen(doc);
  const snapshot = structuredClone(before);
  const r = applyCommands(before, commands, ro.opts ?? options());
  expect(r.ok, `expected rejection ${code}, but the batch was accepted`).toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(before).toEqual(snapshot);
  const error = r.error;
  expect(isBriarError(error)).toBe(true);
  expect(error).toBeInstanceOf(CommandError);
  expect(error.code, `message: ${error.message}`).toBe(code);
  const index = ro.index ?? commands.length - 1;
  expect(error.commandIndex).toBe(index);
  const details = error.details as Record<string, unknown>;
  expect(details).toBeTypeOf("object");
  expect(details.commandIndex).toBe(index);
  const cmd = commands[index] as unknown;
  const op = cmd !== null && typeof cmd === "object" ? (cmd as { op?: unknown }).op : undefined;
  if (typeof op === "string") {
    expect(error.op).toBe(op);
    expect(details.op).toBe(op);
  }
  if (typeof ro.message === "string") expect(error.message).toBe(ro.message);
  else if (ro.message) expect(error.message).toMatch(ro.message);
  for (const part of ro.contains ?? []) expect(error.message).toContain(part);
  return error;
}

/** Diagnostics with `code`. */
export function diags(list: readonly Diagnostic[], code: string): Diagnostic[] {
  return list.filter((d) => d.code === code);
}

export function flowOf(doc: ContextDocument, flowId: string): FlowDocument {
  const f = doc.flows.find((x) => x.id === flowId);
  if (!f) throw new Error(`flow ${flowId} missing`);
  return f;
}

export function nodeOf(doc: ContextDocument, flowId: string, nodeId: string): NodeInstance | undefined {
  return flowOf(doc, flowId).nodes.find((n) => n.id === nodeId);
}

export function edgeIds(doc: ContextDocument, flowId: string): string[] {
  return flowOf(doc, flowId).edges.map((e) => e.id);
}

/** Port names of a node as core resolves them. */
export function portsOf(doc: ContextDocument, flowId: string, nodeId: string): { inputs: string[]; outputs: string[] } {
  const n = resolveFlowPorts(doc, flowId, testCatalog()).nodes.get(nodeId);
  if (!n) throw new Error(`node ${nodeId} missing`);
  return { inputs: n.inputs.map((p) => p.name), outputs: n.outputs.map((p) => p.name) };
}

/** Message pattern helpers for templates with free parts. */
export const msg = {
  invalidPayload: (op: string, field: string) => new RegExp(`^Command ${esc(op)}: ${esc(field)} .+\\.$`),
  unknownRef: (op: string, kind: string, id: string) => new RegExp(`^Command ${esc(op)}: ${esc(kind)} "${esc(id)}" does not exist.*\\.$`),
  invalidId: (op: string, id: string) => new RegExp(`^Command ${esc(op)}: "${esc(id)}" is not a valid .+ id\\. Expected .+\\.$`),
  duplicateId: (op: string, id: string) => new RegExp(`^Command ${esc(op)}: id "${esc(id)}" is already used by an? .+\\.$`),
  invalidName: (name: string) => new RegExp(`^"${esc(name)}" is not a valid .+ name\\.`),
  duplicateName: (existing: string) =>
    new RegExp(`^A .+ named "${esc(existing)}" already exists in .+\\. Names must be unique \\(ignoring case\\)\\.$`),
  reservedName: (name: string) => new RegExp(`^"${esc(name)}" is reserved\\. Choose another .+ name\\.$`),
  invalidTypeName: (name: string) =>
    `"${name}" is not a valid type name. Type names start with an uppercase letter and use letters, digits and _ (e.g. Character).`,
  reservedTypeName: (name: string) => `"${name}" is reserved. Choose another type name.`,
  duplicateTypeName: (existing: string) =>
    new RegExp(`^A type named "${esc(existing)}" already exists in .+\\. Names must be unique \\(ignoring case\\)\\.$`),
  invalidDefault: /^Default value of .+ is not valid: .+\.$/,
};

export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `n` chars of "a". */
export function chars(n: number, c = "a"): string {
  return c.repeat(n);
}
