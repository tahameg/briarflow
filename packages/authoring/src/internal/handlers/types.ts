/**
 * Type commands (commands.md §3).
 */
import {
  ENUM_VALUE_PATTERN,
  collectNamedIds,
  extendsStruct,
  isBuiltinId,
  structProblems,
  type ContextDocument,
  type EnumDecl,
  type EnumMember,
  type FieldDecl,
  type NodeCatalog,
  type StructDecl,
  type TypeDecl,
  type TypeRef,
  type TypeScopeRef,
  nodeDefinition,
} from "@briarflow/core";
import type { Command } from "../../commands.js";
import {
  checkDescription,
  checkFieldName,
  checkGlobalVisibility,
  checkNotRecursive,
  checkTypeName,
  checkValue,
  failWith,
  getFlow,
  getType,
  localTypesIn,
  newId,
  putType,
  putTypes,
  resolveTypeInput,
  scopeInput,
  scopeOf,
  typeIdUsed,
  typesOf,
  type Ctx,
  type Effect,
  type Payload,
  type TypeLocation,
} from "../ctx.js";
import { followPortRename, type PortsOf } from "../normalize.js";
import { clamp, fail, insertAt, moveTo, removeAt, sameNameIgnoringCase, withKey } from "../util.js";
import { renameEnumValue, renameStructKey, rewriteStoredValues } from "../values.js";
import { configFields } from "./graph.js";

const resolvedAs = (p: Payload): Command => p as unknown as Command;

// ---------------------------------------------------------------------------------------------
// Usages
// ---------------------------------------------------------------------------------------------

/** One place that references a type. */
export interface TypeUsage {
  kind: "field" | "extends" | "input" | "output" | "variable" | "global" | "node";
  flowId?: string;
  /** Id of the using entity (struct, flow, variable, global, node). */
  id: string;
  name: string;
  /** Human description for messages. */
  text: string;
  /** Public signature / public variable usage (for moveScope). */
  public?: boolean;
}

const refs = (type: TypeRef, typeId: string) => collectNamedIds(type).includes(typeId);

export function findTypeUsages(doc: ContextDocument, catalog: NodeCatalog, typeId: string): TypeUsage[] {
  const out: TypeUsage[] = [];
  const structFields = (types: readonly TypeDecl[], flowId?: string) => {
    for (const t of types) {
      if (t.kind !== "struct" || t.id === typeId) continue;
      if (t.extends === typeId) {
        out.push({ kind: "extends", ...(flowId ? { flowId } : {}), id: t.id, name: t.name, text: `struct "${t.name}", which extends it` });
      }
      for (const f of t.fields) {
        if (refs(f.type, typeId)) {
          out.push({ kind: "field", ...(flowId ? { flowId } : {}), id: t.id, name: `${t.name}.${f.name}`, text: `field "${t.name}.${f.name}"` });
        }
      }
    }
  };
  structFields(doc.types);
  for (const g of doc.globals) {
    if (refs(g.type, typeId)) out.push({ kind: "global", id: g.id, name: g.name, text: `global "${g.name}"` });
  }
  for (const flow of doc.flows) {
    structFields(flow.types, flow.id);
    for (const side of ["inputs", "outputs"] as const) {
      for (const f of flow[side]) {
        if (!refs(f.type, typeId)) continue;
        const kind = side === "inputs" ? "input" : "output";
        out.push({ kind, flowId: flow.id, id: flow.id, name: f.name, text: `flow ${kind} "${f.name}" of flow "${flow.name}"`, public: true });
      }
    }
    for (const v of flow.variables) {
      if (!refs(v.type, typeId)) continue;
      out.push({
        kind: "variable",
        flowId: flow.id,
        id: v.id,
        name: v.name,
        text: `variable "${v.name}" of flow "${flow.name}"`,
        public: v.access === "public",
      });
    }
    for (const n of flow.nodes) {
      const fields = configFields(nodeDefinition(catalog, n));
      let used = false;
      for (const [k, v] of Object.entries(n.config ?? {})) {
        const kind = fields[k]?.kind;
        if (kind === "typeId" && v === typeId) used = true;
        if (kind === "type" && typeof v === "object" && v !== null && refs(v as TypeRef, typeId)) used = true;
      }
      for (const b of Object.values(n.typeBindings ?? {})) if (refs(b, typeId)) used = true;
      if (used) {
        const lbl = n.title && n.title.trim() !== "" ? n.title : n.id;
        out.push({ kind: "node", flowId: flow.id, id: n.id, name: lbl, text: `node "${lbl}" of flow "${flow.name}"` });
      }
    }
  }
  return out;
}

function inUse(decl: TypeDecl, usages: TypeUsage[], extra = ""): never {
  const first = usages
    .slice(0, 3)
    .map((u) => u.text)
    .join(", ");
  const n = usages.length;
  return fail("type.in_use", `Type "${decl.name}" is used in ${n} place${n === 1 ? "" : "s"} (${first}${n > 3 ? ", …" : ""}). Remove those uses first.${extra}`, {
    usages: usages.map((u) => ({ kind: u.kind, ...(u.flowId ? { flowId: u.flowId } : {}), id: u.id, name: u.name })),
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function struct(ctx: Ctx, typeId: string): { loc: TypeLocation; decl: StructDecl } {
  if (isBuiltinId(typeId)) {
    fail("type.read_only", `Type "${typeId}" is built in and cannot be changed. Define a struct that extends it instead.`, { id: typeId });
  }
  const loc = getType(ctx, typeId);
  if (loc.decl.kind !== "struct") fail("type.not_struct", `Type "${loc.decl.name}" is an enum; fields belong to structs.`, { typeId });
  return { loc, decl: loc.decl };
}

function enumType(ctx: Ctx, typeId: string): { loc: TypeLocation; decl: EnumDecl } {
  const loc = getType(ctx, typeId);
  if (loc.decl.kind !== "enum") fail("type.not_enum", `Type "${loc.decl.name}" is a struct; members belong to enums.`, { typeId });
  return { loc, decl: loc.decl };
}

function fieldIndex(ctx: Ctx, decl: StructDecl, name: string): number {
  const i = decl.fields.findIndex((f) => f.name === name);
  if (i < 0) {
    fail("command.unknown_ref", `Command ${ctx.op}: field "${name}" does not exist in struct "${decl.name}".`, { kind: "field", id: name });
  }
  return i;
}

function memberIndex(ctx: Ctx, decl: EnumDecl, value: string): number {
  const i = decl.members.findIndex((m) => m.value === value);
  if (i < 0) {
    fail("command.unknown_ref", `Command ${ctx.op}: member "${value}" does not exist in enum "${decl.name}".`, { kind: "member", id: value });
  }
  return i;
}

/** Resolves a field type for a struct in `scope`, with visibility (global structs). */
function fieldType(ctx: Ctx, scope: TypeScopeRef, structName: string, fieldName: string, input: unknown, path: string): TypeRef {
  const where = `field "${structName}.${fieldName}"`;
  const type = resolveTypeInput(ctx, input, scopeOf(ctx, scope), where, path);
  if (scope.kind === "global") checkGlobalVisibility(ctx, type, `Field "${structName}.${fieldName}"`);
  return type;
}

function checkFieldDefault(ctx: Ctx, scope: TypeScopeRef, structName: string, field: FieldDecl): void {
  if (field.default === undefined) return;
  checkValue(ctx, field.default, field.type, scopeOf(ctx, scope), `${structName}.${field.name}`, { defaultOf: `field "${structName}.${field.name}"` });
}

/**
 * Rejects a change that breaks the rules of `extends` and static fields (types.md §1.3), for the
 * struct and for every struct that extends it.
 */
function checkStructRules(ctx: Ctx, typeId: string): void {
  if (ctx.restore) return;
  const scopes: { decl: StructDecl; scope: TypeScopeRef }[] = [];
  for (const t of ctx.doc.types) if (t.kind === "struct") scopes.push({ decl: t, scope: { kind: "global" } });
  for (const f of ctx.doc.flows) for (const t of f.types) if (t.kind === "struct") scopes.push({ decl: t, scope: { kind: "flow", flowId: f.id } });
  for (const { decl, scope } of scopes) {
    const sc = scopeOf(ctx, scope);
    if (decl.id !== typeId && !extendsStruct(decl.id, typeId, (id) => sc.getType(id)?.decl)) continue;
    const [problem] = structProblems(decl, sc, { typeId: decl.id });
    if (problem) failWith(problem);
  }
}

/** Resolves the struct a struct extends (a name, shorthand or id); global structs may not extend local ones. */
function extendsTarget(ctx: Ctx, scope: TypeScopeRef, structName: string, input: unknown): string {
  const type = resolveTypeInput(ctx, input, scopeOf(ctx, scope), `"${structName}" extends`, "extends");
  if (type.kind !== "named" || scopeOf(ctx, scope).getType(type.id)?.decl.kind !== "struct") {
    fail("type.extends_not_struct", `"${structName}" can only extend a struct (e.g. Text or Image), not ${JSON.stringify(input)}.`, { field: "extends" });
  }
  if (scope.kind === "global") checkGlobalVisibility(ctx, type, `"${structName}" extends`);
  return type.id;
}

function checkMemberValue(value: string): void {
  if (value.length > 64 || !ENUM_VALUE_PATTERN.test(value)) {
    fail(
      "command.invalid_name",
      `"${value}" is not a valid enum member name. Members use letters, digits, _, . and - and do not start with . or - (at most 64 characters, e.g. gpt-4.1).`,
      { name: value },
    );
  }
}

function checkLabel(ctx: Ctx, label: unknown): void {
  if (typeof label === "string" && (label.trim() === "" || label.length > 120)) {
    fail("command.invalid_payload", `Command ${ctx.op}: label must have 1–120 characters and not be blank.`, { field: "label" });
  }
}

function duplicateMember(decl: { name: string }, existing: string): never {
  return fail(
    "type.duplicate_member",
    `Enum "${decl.name}" already has a member "${existing}". Member values must be unique (ignoring case).`,
    { existing },
  );
}

// ---------------------------------------------------------------------------------------------
// Define / rename / delete / move
// ---------------------------------------------------------------------------------------------

export function typeDefineStruct(ctx: Ctx, p: Payload): Effect {
  const scope = scopeInput(ctx, p["scope"]);
  const name = p["name"] as string;
  checkTypeName(ctx, name, scope);
  checkDescription(ctx, p["description"]);
  const id = newId(ctx, "type", p["id"], (x) => typeIdUsed(ctx.doc, x) || ctx.catalog.getType(x) !== undefined);
  const list = typesOf(ctx.doc, scope);
  const index = clamp((p["index"] as number | undefined) ?? list.length, 0, list.length);
  let decl: StructDecl = { kind: "struct", id, name, fields: [] };
  if (typeof p["description"] === "string") decl.description = p["description"];
  if (p["extends"] !== undefined && p["extends"] !== null) decl.extends = extendsTarget(ctx, scope, name, p["extends"]);
  putTypes(ctx, scope, insertAt(list, index, decl));
  const loc: TypeLocation = { decl, scope, index };
  const fields: FieldDecl[] = [];
  const inputs = (p["fields"] as Payload[] | undefined) ?? [];
  inputs.forEach((f, i) => {
    const fname = f["name"] as string;
    checkFieldName(
      fname,
      "field",
      fields.map((x) => x.name),
      `struct "${name}"`,
    );
    checkDescription(ctx, f["description"], `fields[${i}].description`);
    const field: FieldDecl = { name: fname, type: fieldType(ctx, scope, name, fname, f["type"], `fields[${i}].type`) };
    if (typeof f["description"] === "string") field.description = f["description"];
    if (f["default"] !== undefined) field.default = f["default"];
    if (f["static"] === true) field.static = true;
    fields.push(field);
  });
  decl = { ...decl, fields };
  putType(ctx, loc, decl);
  checkNotRecursive(ctx, id);
  for (const f of fields) checkFieldDefault(ctx, scope, name, f);
  checkStructRules(ctx, id);
  return {
    created: { typeId: id },
    inverse: [{ op: "type.delete", typeId: id }],
    resolved: resolvedAs({
      ...p,
      id,
      ...(decl.extends === undefined ? {} : { extends: { kind: "named", id: decl.extends } }),
      ...(p["fields"] !== undefined ? { fields: fields.map((f) => ({ ...f })) } : {}),
    }),
    touched: "none",
  };
}

export function typeDefineEnum(ctx: Ctx, p: Payload): Effect {
  const scope = scopeInput(ctx, p["scope"]);
  const name = p["name"] as string;
  checkTypeName(ctx, name, scope);
  checkDescription(ctx, p["description"]);
  const id = newId(ctx, "type", p["id"], (x) => typeIdUsed(ctx.doc, x) || ctx.catalog.getType(x) !== undefined);
  const members: EnumMember[] = [];
  for (const raw of (p["members"] as unknown[] | undefined) ?? []) {
    const m: EnumMember = typeof raw === "string" ? { value: raw } : { ...(raw as EnumMember) };
    checkMemberValue(m.value);
    checkLabel(ctx, m.label);
    const dup = sameNameIgnoringCase(
      members.map((x) => x.value),
      m.value,
    );
    if (dup !== undefined) duplicateMember({ name }, dup);
    members.push(m);
  }
  const decl: EnumDecl = { kind: "enum", id, name, members };
  if (typeof p["description"] === "string") decl.description = p["description"];
  const list = typesOf(ctx.doc, scope);
  putTypes(ctx, scope, insertAt(list, (p["index"] as number | undefined) ?? list.length, decl));
  return {
    created: { typeId: id },
    inverse: [{ op: "type.delete", typeId: id }],
    resolved: resolvedAs({ ...p, id }),
    touched: "none",
  };
}

export function typeRename(ctx: Ctx, p: Payload): Effect {
  const loc = getType(ctx, p["typeId"] as string);
  const name = p["name"] as string;
  checkTypeName(ctx, name, loc.scope, loc.decl.id);
  putType(ctx, loc, { ...loc.decl, name });
  return { inverse: [{ op: "type.rename", typeId: loc.decl.id, name: loc.decl.name }], resolved: resolvedAs(p), touched: "none" };
}

export function typeSetDescription(ctx: Ctx, p: Payload): Effect {
  const loc = getType(ctx, p["typeId"] as string);
  checkDescription(ctx, p["description"]);
  putType(ctx, loc, withKey(loc.decl, "description", (p["description"] as string | null) ?? undefined));
  return {
    inverse: [{ op: "type.setDescription", typeId: loc.decl.id, description: loc.decl.description ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

/** Command that re-defines `decl` (with its fields/members) at `index` in `scope`. */
function defineCommand(decl: TypeDecl, scope: TypeScopeRef, index: number): Command {
  const c: Payload = {
    op: decl.kind === "struct" ? "type.defineStruct" : "type.defineEnum",
    scope: scope.kind === "global" ? { kind: "global" } : { kind: "flow", flowId: scope.flowId },
    id: decl.id,
    name: decl.name,
    index,
  };
  if (decl.description !== undefined) c["description"] = decl.description;
  if (decl.kind === "struct" && decl.extends !== undefined) c["extends"] = { kind: "named", id: decl.extends };
  if (decl.kind === "struct") c["fields"] = decl.fields.map((f) => ({ ...f }));
  else c["members"] = decl.members.map((m) => ({ ...m }));
  return c as unknown as Command;
}

export function typeDelete(ctx: Ctx, p: Payload): Effect {
  const loc = getType(ctx, p["typeId"] as string);
  const usages = findTypeUsages(ctx.doc, ctx.catalog, loc.decl.id);
  if (usages.length > 0) inUse(loc.decl, usages);
  putTypes(ctx, loc.scope, removeAt(typesOf(ctx.doc, loc.scope), loc.index));
  return { inverse: [defineCommand(loc.decl, loc.scope, loc.index)], resolved: resolvedAs(p), touched: "none" };
}

export function typeMoveScope(ctx: Ctx, p: Payload): Effect {
  const loc = getType(ctx, p["typeId"] as string);
  const to = scopeInput(ctx, p["to"]);
  const decl = loc.decl;
  const same = to.kind === loc.scope.kind && (to.kind === "global" || (loc.scope.kind === "flow" && to.flowId === loc.scope.flowId));
  if (same) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  if (to.kind === "flow" && loc.scope.kind === "flow") {
    fail(
      "command.invalid_payload",
      `Command type.moveScope: type "${decl.name}" cannot move directly from one flow to another. Move it to global types first, then into the other flow.`,
      { field: "to" },
    );
  }
  checkTypeName(ctx, decl.name, to, decl.id);
  if (to.kind === "flow") {
    const flow = getFlow(ctx, to.flowId);
    const usages = findTypeUsages(ctx.doc, ctx.catalog, decl.id);
    const outside = usages.filter((u) => u.flowId !== to.flowId);
    if (outside.length > 0) inUse(decl, outside, ` A local type is only visible inside flow "${flow.name}".`);
    if (!ctx.restore) {
      const sig = usages.find((u) => u.public && (u.kind === "input" || u.kind === "output"));
      if (sig) {
        fail(
          "visibility.local_type_in_public_signature",
          `Flow ${sig.kind} "${sig.name}" uses local type "${decl.name}". Public signatures can only use primitives, global types and pack types. Move "${decl.name}" to global types.`,
          { id: decl.id, flowId: flow.id },
        );
      }
      const pub = usages.find((u) => u.public && u.kind === "variable");
      if (pub) {
        fail(
          "visibility.local_type_in_public_variable",
          `Public variable "${pub.name}" uses local type "${decl.name}". Make the variable private or move the type to global.`,
          { id: decl.id, variableId: pub.id },
        );
      }
    }
  } else if (decl.kind === "struct" && !ctx.restore && loc.scope.kind === "flow") {
    const flow = getFlow(ctx, loc.scope.flowId);
    const deps = new Map<string, TypeDecl>();
    for (const f of decl.fields) for (const t of localTypesIn(flow, f.type)) if (t.id !== decl.id) deps.set(t.id, t);
    if (decl.extends !== undefined) for (const t of localTypesIn(flow, { kind: "named", id: decl.extends })) deps.set(t.id, t);
    if (deps.size > 0) {
      const names = [...deps.values()].map((t) => `"${t.name}"`).join(", ");
      fail(
        "visibility.local_type_in_global",
        `Type "${decl.name}" uses local type${deps.size === 1 ? "" : "s"} ${names}, which ${deps.size === 1 ? "is" : "are"} only visible inside flow "${flow.name}". Move ${deps.size === 1 ? "it" : "them"} to global types first.`,
        { localDependencies: [...deps.values()].map((t) => ({ id: t.id, name: t.name })) },
      );
    }
  }
  putTypes(ctx, loc.scope, removeAt(typesOf(ctx.doc, loc.scope), loc.index));
  const target = typesOf(ctx.doc, to);
  putTypes(ctx, to, insertAt(target, (p["index"] as number | undefined) ?? target.length, decl));
  const back = loc.scope.kind === "global" ? { kind: "global" } : { kind: "flow", flowId: loc.scope.flowId };
  return {
    inverse: [{ op: "type.moveScope", typeId: decl.id, to: back as TypeScopeRef, index: loc.index }],
    resolved: resolvedAs(p),
    touched: "all",
  };
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

function addFieldCommand(typeId: string, f: FieldDecl, index: number): Command {
  const c: Payload = { op: "type.field.add", typeId, name: f.name, type: f.type, index };
  if (f.description !== undefined) c["description"] = f.description;
  if (f.default !== undefined) c["default"] = f.default;
  if (f.static) c["static"] = true;
  return c as unknown as Command;
}

export function fieldAdd(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const name = p["name"] as string;
  checkFieldName(
    name,
    "field",
    decl.fields.map((f) => f.name),
    `struct "${decl.name}"`,
  );
  checkDescription(ctx, p["description"]);
  const field: FieldDecl = { name, type: fieldType(ctx, loc.scope, decl.name, name, p["type"], "type") };
  if (typeof p["description"] === "string") field.description = p["description"];
  if (p["default"] !== undefined) field.default = p["default"];
  if (p["static"] === true) field.static = true;
  const index = clamp((p["index"] as number | undefined) ?? decl.fields.length, 0, decl.fields.length);
  putType(ctx, loc, { ...decl, fields: insertAt(decl.fields, index, field) });
  checkNotRecursive(ctx, decl.id);
  checkFieldDefault(ctx, loc.scope, decl.name, field);
  checkStructRules(ctx, decl.id);
  return {
    inverse: [{ op: "type.field.remove", typeId: decl.id, field: name }],
    resolved: resolvedAs({ ...p, type: field.type }),
    touched: "all",
  };
}

/** A renamed static field keeps the values that structs extending its struct give it. */
function renameInheritedStatic(ctx: Ctx, baseId: string, old: string, name: string): void {
  const rename = (types: readonly TypeDecl[], sc: () => ReturnType<typeof scopeOf>): readonly TypeDecl[] =>
    types.map((t) => {
      if (t.kind !== "struct" || t.id === baseId || !extendsStruct(t.id, baseId, (id) => sc().getType(id)?.decl)) return t;
      if (!t.fields.some((f) => f.static && f.name === old)) return t;
      return { ...t, fields: t.fields.map((f) => (f.static && f.name === old ? { ...f, name } : f)) };
    });
  const global = { kind: "global" } as const;
  putTypes(ctx, global, rename(ctx.doc.types, () => scopeOf(ctx, global)));
  for (const f of ctx.doc.flows) {
    const flowScope = { kind: "flow", flowId: f.id } as const;
    putTypes(ctx, flowScope, rename(f.types, () => scopeOf(ctx, flowScope)));
  }
}

export function fieldRemove(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  putType(ctx, loc, { ...decl, fields: removeAt(decl.fields, i) });
  checkStructRules(ctx, decl.id);
  return { inverse: [addFieldCommand(decl.id, decl.fields[i] as FieldDecl, i)], resolved: resolvedAs(p), touched: "all" };
}

export function fieldRename(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const old = p["field"] as string;
  const i = fieldIndex(ctx, decl, old);
  const name = p["name"] as string;
  if (name === old) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  checkFieldName(
    name,
    "field",
    decl.fields.map((f) => f.name),
    `struct "${decl.name}"`,
    old,
  );
  const before = ctx.doc;
  if (decl.fields[i]?.static) renameInheritedStatic(ctx, decl.id, old, name);
  else ctx.doc = rewriteStoredValues(ctx.doc, ctx.catalog, ports, renameStructKey(decl.id, old, name));
  putType(ctx, { ...loc, decl: getType(ctx, decl.id).decl }, { ...decl, fields: decl.fields.map((f, k) => (k === i ? { ...f, name } : f)) });
  ctx.doc = followPortRename(before, ctx.doc, "all", ports, old, name);
  return { inverse: [{ op: "type.field.rename", typeId: decl.id, field: name, name: old }], resolved: resolvedAs(p), touched: "all" };
}

export function fieldSetType(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  const field = decl.fields[i] as FieldDecl;
  const type = fieldType(ctx, loc.scope, decl.name, field.name, p["type"], "type");
  putType(ctx, loc, { ...decl, fields: decl.fields.map((f, k) => (k === i ? { ...f, type } : f)) });
  checkNotRecursive(ctx, decl.id);
  checkStructRules(ctx, decl.id);
  return {
    inverse: [{ op: "type.field.setType", typeId: decl.id, field: field.name, type: field.type }],
    resolved: resolvedAs({ ...p, type }),
    touched: "all",
  };
}

export function fieldReorder(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  const to = clamp(p["index"] as number, 0, decl.fields.length - 1);
  putType(ctx, loc, { ...decl, fields: moveTo(decl.fields, i, to) });
  return { inverse: [{ op: "type.field.reorder", typeId: decl.id, field: p["field"] as string, index: i }], resolved: resolvedAs(p), touched: "all" };
}

export function fieldSetDescription(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  checkDescription(ctx, p["description"]);
  const field = decl.fields[i] as FieldDecl;
  putType(ctx, loc, { ...decl, fields: decl.fields.map((f, k) => (k === i ? withKey(f, "description", (p["description"] as string | null) ?? undefined) : f)) });
  return {
    inverse: [{ op: "type.field.setDescription", typeId: decl.id, field: field.name, description: field.description ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

export function fieldSetDefault(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  const field = decl.fields[i] as FieldDecl;
  const next = { ...field, default: p["value"] };
  checkFieldDefault(ctx, loc.scope, decl.name, next);
  putType(ctx, loc, { ...decl, fields: decl.fields.map((f, k) => (k === i ? next : f)) });
  checkStructRules(ctx, decl.id);
  const inverse: Command =
    field.default === undefined
      ? { op: "type.field.clearDefault", typeId: decl.id, field: field.name }
      : { op: "type.field.setDefault", typeId: decl.id, field: field.name, value: field.default };
  return { inverse: [inverse], resolved: resolvedAs(p), touched: "all" };
}

export function fieldClearDefault(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  const field = decl.fields[i] as FieldDecl;
  if (field.default === undefined) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putType(ctx, loc, { ...decl, fields: decl.fields.map((f, k) => (k === i ? withKey(f, "default", undefined) : f)) });
  checkStructRules(ctx, decl.id);
  return {
    inverse: [{ op: "type.field.setDefault", typeId: decl.id, field: field.name, value: field.default }],
    resolved: resolvedAs(p),
    touched: "all",
  };
}

export function typeSetExtends(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const raw = p["extends"];
  const next = raw === null || raw === undefined ? undefined : extendsTarget(ctx, loc.scope, decl.name, raw);
  if (next === decl.extends) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putType(ctx, loc, withKey(decl, "extends", next));
  checkStructRules(ctx, decl.id);
  return {
    inverse: [{ op: "type.setExtends", typeId: decl.id, extends: decl.extends === undefined ? null : { kind: "named", id: decl.extends } }],
    resolved: resolvedAs({ ...p, extends: next === undefined ? null : { kind: "named", id: next } }),
    touched: "all",
  };
}

export function fieldSetStatic(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = struct(ctx, p["typeId"] as string);
  const i = fieldIndex(ctx, decl, p["field"] as string);
  const field = decl.fields[i] as FieldDecl;
  const on = p["static"] === true;
  if ((field.static === true) === on) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  putType(ctx, loc, { ...decl, fields: decl.fields.map((f, k) => (k === i ? withKey(f, "static", on ? true : undefined) : f)) });
  checkStructRules(ctx, decl.id);
  return {
    inverse: [{ op: "type.field.setStatic", typeId: decl.id, field: field.name, static: !on }],
    resolved: resolvedAs(p),
    touched: "all",
  };
}

// ---------------------------------------------------------------------------------------------
// Enum members
// ---------------------------------------------------------------------------------------------

export function memberAdd(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = enumType(ctx, p["typeId"] as string);
  const value = p["value"] as string;
  checkMemberValue(value);
  checkLabel(ctx, p["label"]);
  const dup = sameNameIgnoringCase(
    decl.members.map((m) => m.value),
    value,
  );
  if (dup !== undefined) duplicateMember(decl, dup);
  const member: EnumMember = { value };
  if (typeof p["label"] === "string") member.label = p["label"];
  const index = clamp((p["index"] as number | undefined) ?? decl.members.length, 0, decl.members.length);
  putType(ctx, loc, { ...decl, members: insertAt(decl.members, index, member) });
  return { inverse: [{ op: "type.enum.removeMember", typeId: decl.id, value }], resolved: resolvedAs(p), touched: "none" };
}

export function memberRemove(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = enumType(ctx, p["typeId"] as string);
  const i = memberIndex(ctx, decl, p["value"] as string);
  const m = decl.members[i] as EnumMember;
  putType(ctx, loc, { ...decl, members: removeAt(decl.members, i) });
  const inv: Payload = { op: "type.enum.addMember", typeId: decl.id, value: m.value, index: i };
  if (m.label !== undefined) inv["label"] = m.label;
  return { inverse: [inv as unknown as Command], resolved: resolvedAs(p), touched: "none" };
}

export function memberRename(ctx: Ctx, p: Payload, ports: PortsOf): Effect {
  const { loc, decl } = enumType(ctx, p["typeId"] as string);
  const old = p["value"] as string;
  const i = memberIndex(ctx, decl, old);
  const value = p["newValue"] as string;
  if (value === old) return { inverse: [], resolved: resolvedAs(p), touched: "none" };
  checkMemberValue(value);
  const dup = sameNameIgnoringCase(
    decl.members.map((m) => m.value),
    value,
    old,
  );
  if (dup !== undefined) duplicateMember(decl, dup);
  ctx.doc = rewriteStoredValues(ctx.doc, ctx.catalog, ports, renameEnumValue(decl.id, old, value));
  putType(ctx, loc, { ...decl, members: decl.members.map((m, k) => (k === i ? { ...m, value } : m)) });
  return { inverse: [{ op: "type.enum.renameMember", typeId: decl.id, value, newValue: old }], resolved: resolvedAs(p), touched: "none" };
}

export function memberSetLabel(ctx: Ctx, p: Payload): Effect {
  const { loc, decl } = enumType(ctx, p["typeId"] as string);
  const i = memberIndex(ctx, decl, p["value"] as string);
  checkLabel(ctx, p["label"]);
  const m = decl.members[i] as EnumMember;
  putType(ctx, loc, { ...decl, members: decl.members.map((x, k) => (k === i ? withKey(x, "label", (p["label"] as string | null) ?? undefined) : x)) });
  return {
    inverse: [{ op: "type.enum.setMemberLabel", typeId: decl.id, value: m.value, label: m.label ?? null }],
    resolved: resolvedAs(p),
    touched: "none",
  };
}

