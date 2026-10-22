/**
 * Per-command context and shared lookups/checks used by every handler.
 */
import {
  FIELD_NAME_PATTERN,
  ID_PREFIXES,
  RESERVED_FIELD_NAMES,
  RESERVED_TYPE_NAMES,
  TYPE_NAME_PATTERN,
  collectNamedIds,
  containsVar,
  findFlow,
  isValidId,
  parseType,
  scopeForContext,
  scopeForFlow,
  typeConstraintDiagnostics,
  typeRefShapeProblem,
  validateValue,
  type ContextDocument,
  type Diagnostic,
  type FlowDocument,
  type IdGenerator,
  type IdKind,
  type NodeCatalog,
  type NodeInstance,
  type TypeDecl,
  type TypeRef,
  type TypeScope,
  type TypeScopeRef,
} from "@briarflow/core";
import type { Command } from "../commands.js";
import type { CreatedIds } from "../result.js";
import { fail, sameNameIgnoringCase } from "./util.js";

/** State of one command being applied. Handlers replace `doc` (never mutate it). */
export interface Ctx {
  doc: ContextDocument;
  readonly catalog: NodeCatalog;
  readonly ids: IdGenerator;
  readonly restore: boolean;
  readonly op: string;
}

/** What a handler returns. */
export interface Effect {
  created?: CreatedIds;
  /** Undo commands of this command (the runner adds `restore: true`). */
  inverse: Command[];
  /** The command as applied (ids filled in, types as IR). */
  resolved: Command;
  /** Flows whose ports must be re-resolved and cleaned up: none, all, or these ids. */
  touched: "none" | "all" | readonly string[];
}

/** Raw payload as validated by `checkPayload`. */
export type Payload = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

export function unknownRef(ctx: Ctx, kind: string, id: string, where = ""): never {
  return fail("command.unknown_ref", `Command ${ctx.op}: ${kind} "${id}" does not exist${where}.`, { kind, id });
}

export function getFlow(ctx: Ctx, flowId: string): FlowDocument {
  return findFlow(ctx.doc, flowId) ?? unknownRef(ctx, "flow", flowId, ` in context "${ctx.doc.name}"`);
}

export function flowIndex(ctx: Ctx, flowId: string): number {
  return ctx.doc.flows.findIndex((f) => f.id === flowId);
}

/** Replaces a flow (by id) in the working document. */
export function putFlow(ctx: Ctx, flow: FlowDocument): void {
  ctx.doc = { ...ctx.doc, flows: ctx.doc.flows.map((f) => (f.id === flow.id ? flow : f)) };
}

export function getNode(ctx: Ctx, flow: FlowDocument, nodeId: string): NodeInstance {
  return flow.nodes.find((n) => n.id === nodeId) ?? unknownRef(ctx, "node", nodeId, ` in flow "${flow.name}"`);
}

/** Where a user type is declared. */
export interface TypeLocation {
  decl: TypeDecl;
  scope: TypeScopeRef;
  index: number;
}

export function locateType(doc: ContextDocument, typeId: string): TypeLocation | undefined {
  const g = doc.types.findIndex((t) => t.id === typeId);
  if (g >= 0) return { decl: doc.types[g] as TypeDecl, scope: { kind: "global" }, index: g };
  for (const f of doc.flows) {
    const i = f.types.findIndex((t) => t.id === typeId);
    if (i >= 0) return { decl: f.types[i] as TypeDecl, scope: { kind: "flow", flowId: f.id }, index: i };
  }
  return undefined;
}

export function getType(ctx: Ctx, typeId: string): TypeLocation {
  const loc = locateType(ctx.doc, typeId);
  if (loc) return loc;
  if (ctx.catalog.getType(typeId)) {
    fail("type.read_only", `Type "${typeId}" comes from a node pack and cannot be changed. Define your own type instead.`, { id: typeId });
  }
  return unknownRef(ctx, "type", typeId);
}

/** The declarations list of a scope. */
export function typesOf(doc: ContextDocument, scope: TypeScopeRef): readonly TypeDecl[] {
  if (scope.kind === "global") return doc.types;
  return findFlow(doc, scope.flowId)?.types ?? [];
}

/** Replaces the declarations list of a scope. */
export function putTypes(ctx: Ctx, scope: TypeScopeRef, types: readonly TypeDecl[]): void {
  if (scope.kind === "global") ctx.doc = { ...ctx.doc, types };
  else {
    const flow = getFlow(ctx, scope.flowId);
    putFlow(ctx, { ...flow, types });
  }
}

/** Replaces one declaration in place. */
export function putType(ctx: Ctx, loc: TypeLocation, decl: TypeDecl): void {
  const list = typesOf(ctx.doc, loc.scope).slice();
  list[loc.index] = decl;
  putTypes(ctx, loc.scope, list);
}

/** Type scope in which a declaration's own references are resolved. */
export function scopeOf(ctx: Ctx, scope: TypeScopeRef): TypeScope {
  return scope.kind === "global" ? scopeForContext(ctx.doc, ctx.catalog) : scopeForFlow(ctx.doc, scope.flowId, ctx.catalog);
}

export function scopeLabel(ctx: Ctx, scope: TypeScopeRef): string {
  return scope.kind === "global" ? "global types" : `flow "${getFlow(ctx, scope.flowId).name}"`;
}

export function scopeInput(ctx: Ctx, raw: unknown): TypeScopeRef {
  const s = raw as TypeScopeRef;
  if (s.kind === "flow") {
    getFlow(ctx, s.flowId);
    return { kind: "flow", flowId: s.flowId };
  }
  return { kind: "global" };
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

const KIND_LABEL: Record<IdKind, string> = {
  context: "context",
  flow: "flow",
  type: "type",
  global: "global",
  variable: "variable",
  node: "node",
  edge: "edge",
};

/**
 * Validates a supplied id or generates one. `used(id)` tells whether the id is taken in its
 * uniqueness domain.
 */
export function newId(ctx: Ctx, kind: IdKind, supplied: unknown, used: (id: string) => boolean): string {
  const prefix = ID_PREFIXES[kind];
  if (supplied !== undefined) {
    const id = supplied as string;
    if (!isValidId(kind, id)) {
      fail(
        "command.invalid_id",
        `Command ${ctx.op}: "${id}" is not a valid ${KIND_LABEL[kind]} id. Expected ${prefix}_ followed by 1–60 letters, digits, _ or - (e.g. ${prefix}_1).`,
        { id, kind },
      );
    }
    if (used(id)) fail("command.duplicate_id", `Command ${ctx.op}: id "${id}" is already used by a ${KIND_LABEL[kind]}.`, { id, kind });
    return id;
  }
  for (let i = 0; i < 100; i++) {
    const id = ctx.ids(prefix);
    if (!isValidId(kind, id)) {
      fail("command.invalid_id", `Command ${ctx.op}: the id generator returned "${id}", which is not a valid ${KIND_LABEL[kind]} id.`, { id, kind });
    }
    if (!used(id)) return id;
  }
  return fail("command.duplicate_id", `Command ${ctx.op}: the id generator kept returning ids that are already used. Pass an explicit id.`, { kind });
}

/** True when `id` is a user type id anywhere in the document (global or any flow). */
export function typeIdUsed(doc: ContextDocument, id: string): boolean {
  return locateType(doc, id) !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export function checkTypeName(ctx: Ctx, name: string, scope: TypeScopeRef, exceptId?: string): void {
  if (RESERVED_TYPE_NAMES.includes(name)) fail("type.reserved_name", `"${name}" is reserved. Choose another type name.`, { name });
  if (name.length > 64 || !TYPE_NAME_PATTERN.test(name)) {
    fail(
      "type.invalid_name",
      `"${name}" is not a valid type name. Type names start with an uppercase letter and use letters, digits and _ (e.g. Character).`,
      { name },
    );
  }
  const others = typesOf(ctx.doc, scope).filter((t) => t.id !== exceptId);
  const existing = sameNameIgnoringCase(
    others.map((t) => t.name),
    name,
  );
  if (existing !== undefined) {
    fail("type.duplicate_name", `A type named "${existing}" already exists in ${scopeLabel(ctx, scope)}. Names must be unique (ignoring case).`, {
      name,
      existing,
    });
  }
}

/**
 * Checks a field-like name (field, flow input/output, variable, global): regex, length,
 * reserved words, case-insensitive uniqueness among `existing` (minus `except`).
 */
export function checkFieldName(name: string, kind: string, existing: Iterable<string>, scope: string, except?: string): void {
  if (RESERVED_FIELD_NAMES.includes(name)) fail("command.reserved_name", `"${name}" is reserved. Choose another ${kind} name.`, { name });
  if (name.length > 64 || !FIELD_NAME_PATTERN.test(name)) {
    fail(
      "command.invalid_name",
      `"${name}" is not a valid ${kind} name. Names start with a letter or _ and use letters, digits and _ (at most 64 characters, e.g. maxTokens).`,
      { name },
    );
  }
  const dup = sameNameIgnoringCase(existing, name, except);
  if (dup !== undefined) {
    fail("command.duplicate_name", `A ${kind} named "${dup}" already exists in ${scope}. Names must be unique (ignoring case).`, { name, existing: dup });
  }
}

/** Flow names: 1–80 chars, no control characters, trimmed non-empty, unique ignoring case. */
export function checkFlowName(ctx: Ctx, name: string, exceptId?: string): void {
  // eslint-disable-next-line no-control-regex
  if (name.trim() === "" || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    fail("command.invalid_name", `"${name}" is not a valid flow name. Flow names have 1–80 characters and no control characters.`, { name });
  }
  const dup = sameNameIgnoringCase(
    ctx.doc.flows.filter((f) => f.id !== exceptId).map((f) => f.name),
    name,
  );
  if (dup !== undefined) {
    fail("command.duplicate_name", `A flow named "${dup}" already exists in context "${ctx.doc.name}". Names must be unique (ignoring case).`, {
      name,
      existing: dup,
    });
  }
}

export function checkDescription(ctx: Ctx, description: unknown, field = "description"): void {
  if (typeof description === "string" && description.length > 2000) {
    fail("command.invalid_payload", `Command ${ctx.op}: ${field} must be at most 2000 characters.`, { field });
  }
}

// ---------------------------------------------------------------------------------------------
// Types in payloads
// ---------------------------------------------------------------------------------------------

/**
 * Resolves a payload type (shorthand or IR) in `scope`. Rejects syntax/unknown/var/constraint
 * problems. Ids that are local types of another scope are kept (visibility is checked by the
 * caller, soft under `restore`); ids that exist nowhere → `type.unknown_id`.
 *
 * Shorthand names resolve strictly in `scope` (a local type name at global level is
 * `type.unknown`); IR ids of local types reach the caller's visibility check.
 */
export function resolveTypeInput(ctx: Ctx, input: unknown, scope: TypeScope, where: string, field: string): TypeRef {
  if (typeof input === "string") {
    const r = parseType(input, { scope, where });
    if (r.ok) return r.type;
    return failWith(r.diagnostic);
  }
  const shape = typeRefShapeProblem(input, field);
  if (shape) fail("command.invalid_payload", `Command ${ctx.op}: ${shape.path} ${shape.reason}.`, { field: shape.path });
  const type = input as TypeRef;
  if (containsVar(type)) {
    const v = findVar(type);
    fail("type.var_not_allowed", `Generic type "$${v}" can only be used in node definitions.`, { name: v });
  }
  const c = typeConstraintDiagnostics(type, where);
  if (c[0]) failWith(c[0]);
  for (const id of collectNamedIds(type)) {
    if (scope.getType(id)) continue;
    if (scope.flowId === undefined && locateType(ctx.doc, id)?.scope.kind === "flow") continue;
    fail("type.unknown_id", `${capitalize(where)} refers to type id ${id}, which no longer exists. Pick another type.`, { id });
  }
  return type;
}

function findVar(type: TypeRef): string {
  if (type.kind === "var") return type.name;
  if (type.kind === "list" || type.kind === "optional") return findVar(type.of);
  return "";
}

export function failWith(d: Diagnostic): never {
  return fail(d.code, d.message, d.details === undefined ? {} : isRecord(d.details) ? d.details : { value: d.details });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Local types (of any flow) referenced by `type` that are not visible in `scope`. */
export function invisibleLocalTypes(doc: ContextDocument, type: TypeRef, scope: TypeScope): { decl: TypeDecl; flow: FlowDocument }[] {
  const out: { decl: TypeDecl; flow: FlowDocument }[] = [];
  for (const id of collectNamedIds(type)) {
    if (scope.getType(id)) continue;
    for (const f of doc.flows) {
      const decl = f.types.find((t) => t.id === id);
      if (decl) out.push({ decl, flow: f });
    }
  }
  return out;
}

/** `visibility.local_type_in_global` unless restoring. */
export function checkGlobalVisibility(ctx: Ctx, type: TypeRef, where: string): void {
  if (ctx.restore) return;
  const scope = scopeForContext(ctx.doc, ctx.catalog);
  const [hit] = invisibleLocalTypes(ctx.doc, type, scope);
  if (hit) {
    fail(
      "visibility.local_type_in_global",
      `${capitalize(where)} uses local type "${hit.decl.name}", which is only visible inside flow "${hit.flow.name}". Move it to global types first.`,
      { id: hit.decl.id, flowId: hit.flow.id },
    );
  }
}

/** Local types of `flow` referenced by `type`. */
export function localTypesIn(flow: FlowDocument, type: TypeRef): TypeDecl[] {
  const ids = collectNamedIds(type);
  return flow.types.filter((t) => ids.includes(t.id));
}

/** Rejects struct recursion (`type.recursive`); always hard. */
export function checkNotRecursive(ctx: Ctx, structId: string): void {
  const all = new Map<string, TypeDecl>();
  for (const t of ctx.catalog.types) all.set(t.id, t);
  for (const t of ctx.doc.types) all.set(t.id, t);
  for (const f of ctx.doc.flows) for (const t of f.types) all.set(t.id, t);
  const start = all.get(structId);
  if (!start || start.kind !== "struct") return;
  const visit = (id: string, chain: string[], seen: Set<string>): string[] | undefined => {
    const decl = all.get(id);
    if (!decl || decl.kind !== "struct") return undefined;
    for (const f of decl.fields) {
      for (const ref of collectNamedIds(f.type)) {
        const step = [...chain, `${decl.name}.${f.name}`];
        if (ref === structId) return step;
        if (seen.has(ref)) continue;
        seen.add(ref);
        const found = visit(ref, step, seen);
        if (found) return found;
      }
    }
    return undefined;
  };
  const chain = visit(structId, [], new Set([structId]));
  if (chain) {
    const text = `${chain.join(" → ")} → ${start.name}`;
    fail("type.recursive", `Type "${start.name}" contains itself through ${text}. Recursive types are not supported.`, { chain: text });
  }
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/**
 * Validates a value (hard unless `restore`). `code` is the rejection code: `value.invalid`
 * uses the value diagnostic's own code and message; `type.invalid_default` wraps it.
 */
export function checkValue(
  ctx: Ctx,
  value: unknown,
  type: TypeRef,
  scope: TypeScope,
  path: string,
  options: { defaultOf?: string } = {},
): void {
  if (ctx.restore) return;
  const d = validateValue(value, type, scope, { path });
  const first = d[0];
  if (!first) return;
  if (options.defaultOf !== undefined) {
    fail("type.invalid_default", `Default value of ${options.defaultOf} is not valid: ${first.message}.`, { diagnostics: d });
  }
  fail(first.code, first.message, { diagnostics: d });
}
