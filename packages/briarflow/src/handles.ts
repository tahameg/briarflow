/**
 * Fluent authoring handles over `@briarflow/authoring` (docs/tasks/phase-4.md §3.1).
 */
import {
  createContextEditor,
  type Command,
  type ContextEditor,
  type CreatedIds,
  type EnumMemberSpec,
  type FieldInputDecl,
  type PortRef,
  type ScopeInput,
  type TypeInput,
} from "@briarflow/authoring";
import {
  BriarError,
  EXEC_FAILED,
  EXEC_IN,
  EXEC_THEN,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  VARIABLE_NODE_TYPES,
  isTypeSpec,
  type ContextDocument,
  type Diagnostic,
  type FlowDocument,
  type FlowVariable,
  type GlobalVariable,
  type NodeInstance,
  type Position,
  type TypeDecl,
  type TypeRef,
  type TypeSpec,
} from "@briarflow/core";
import type { BriarRun } from "./runs.js";
import type { BriarRunOptions } from "./briar.js";

/** A type in a fluent call: shorthand (`"list<Character?>"`), IR, or a `t` builder spec (`t.text()`). */
export type TypeLike = string | TypeRef | TypeSpec;

/** A struct field: just its type, or the type with a description / default. */
export type FieldLike = TypeLike | { type: TypeLike; description?: string; default?: unknown };

/** Canvas position as `[x, y]` or `{ x, y }`. */
export type PositionLike = readonly [number, number] | Position;

/** What handles need from the facade. */
export interface HandleHost {
  editorOptions(): Parameters<typeof createContextEditor>[1];
  load(contextId: string): Promise<ContextDocument | undefined>;
  save(doc: ContextDocument, expectedRevision: number): Promise<void>;
  run(flowId: string, inputs: Record<string, unknown> | undefined, options: BriarRunOptions): Promise<BriarRun>;
}

function toTypeInput(type: TypeLike, where: string): TypeInput {
  if (typeof type === "string") return type;
  if (isTypeSpec(type)) return type.ref;
  if (typeof type === "object" && type !== null && typeof (type as { kind?: unknown }).kind === "string") return type as TypeRef;
  throw new BriarError(
    "handle.invalid_type",
    `${where}: ${JSON.stringify(type)} is not a type. Use shorthand like "text", "list<int>" or "Character?", a t builder (t.text()), or type IR.`,
  );
}

function toPosition(at: PositionLike): Position {
  if (Array.isArray(at)) return { x: at[0] as number, y: at[1] as number };
  const p = at as Position;
  return { x: p.x, y: p.y };
}

function notFound(kind: string, wanted: string, where: string, available: readonly string[]): BriarError {
  const list = available.length > 0 ? available.map((n) => `"${n}"`).join(", ") : "none";
  return new BriarError("handle.not_found", `${where} has no ${kind} "${wanted}". Available: ${list}.`, {
    details: { kind, name: wanted },
  });
}

function byNameOrId<T extends { id: string; name: string }>(items: readonly T[], key: string): T | undefined {
  return items.find((i) => i.id === key) ?? items.find((i) => i.name === key) ?? items.find((i) => i.name.toLowerCase() === key.toLowerCase());
}

/** A struct or enum type. */
export interface TypeHandle {
  readonly id: string;
  readonly name: string;
  readonly kind: "struct" | "enum";
  readonly decl: TypeDecl;
}

/** A global variable of the context. */
export interface GlobalHandle {
  readonly id: string;
  readonly name: string;
  readonly decl: GlobalVariable;
  /** Sets the stored value (`global.setValue`). */
  setValue(value: unknown): GlobalHandle;
}

/** A flow variable. */
export interface VariableHandle {
  readonly id: string;
  readonly name: string;
  readonly flowId: string;
  readonly decl: FlowVariable;
}

/** Defining types in one scope (global for a context, local for a flow). */
export interface TypesApi {
  /**
   * Defines a struct. Fields map names to types.
   *
   * @example
   * ```ts
   * ctx.types.defineStruct("Character", { name: "text", age: "int", style: "ArtStyle" });
   * ```
   */
  defineStruct(name: string, fields?: Readonly<Record<string, FieldLike>>, options?: { description?: string; id?: string }): TypeHandle;
  /**
   * Defines an enum.
   *
   * @example
   * ```ts
   * ctx.types.defineEnum("ArtStyle", ["anime", { value: "pixel", label: "Pixel art" }]);
   * ```
   */
  defineEnum(name: string, members: readonly EnumMemberSpec[], options?: { description?: string; id?: string }): TypeHandle;
  /** A type of this scope by name or id; throws `handle.not_found`. */
  get(nameOrId: string): TypeHandle;
  list(): TypeHandle[];
}

/**
 * A context being edited from code. Authoring methods are synchronous and throw the
 * `CommandError` from `@briarflow/authoring` when a command is rejected. Nothing is stored
 * until {@link ContextHandle.save}.
 *
 * @example
 * ```ts
 * const ctx = await briar.contexts.create({ name: "Marketing" });
 * ctx.types.defineEnum("ArtStyle", ["anime", "pixel"]);
 * const flow = ctx.flows.create("Portrait");
 * await ctx.save();
 * ```
 */
export interface ContextHandle {
  readonly id: string;
  readonly name: string;
  /** The current (possibly unsaved) document. Immutable: never mutate it. */
  readonly doc: ContextDocument;
  readonly revision: number;
  /** Revision in the store, as far as this handle knows. */
  readonly savedRevision: number;
  /** `true` when there are changes that `save()` would write. */
  readonly dirty: boolean;
  readonly types: TypesApi;
  readonly globals: {
    /**
     * Creates a global variable. `access` defaults to `"readwrite"`; a readonly global needs a value.
     *
     * @example
     * ```ts
     * ctx.globals.create("brandGuide", "text", { access: "readonly", value: "Pastel colors" });
     * ```
     */
    create(
      name: string,
      type: TypeLike,
      options?: { access?: "readonly" | "readwrite"; value?: unknown; description?: string; id?: string },
    ): GlobalHandle;
    get(nameOrId: string): GlobalHandle;
    list(): GlobalHandle[];
  };
  readonly flows: {
    create(name: string, options?: { description?: string; id?: string }): FlowHandle;
    get(nameOrId: string): FlowHandle;
    list(): FlowHandle[];
  };
  /** Applies raw commands (one undo step). Returns the created ids. */
  apply(command: Command): CreatedIds;
  apply(commands: readonly Command[]): CreatedIds[];
  /** Saves with `expectedRevision` = `savedRevision`. Throws `RevisionConflictError` if someone else saved in between. */
  save(): Promise<void>;
  /** Replaces the document with the stored one and clears undo history. */
  reload(): Promise<void>;
  /** Validation findings of the current document. */
  diagnostics(): Diagnostic[];
  /** `false` when there is nothing to undo. */
  undo(): boolean;
  /** `false` when there is nothing to redo. */
  redo(): boolean;
}

/** A node in a flow. */
export interface NodeHandle {
  readonly id: string;
  readonly type: string;
  readonly flow: FlowHandle;
  /** The current node instance. */
  readonly instance: NodeInstance;
  /** `{ node, port }` for `flow.connect`. Unknown ports are reported by `connect`, with the list of ports. */
  port(name: string): PortRef;
  /** Sets a constant on an input port. */
  set(port: string, value: unknown): NodeHandle;
  /** Removes a constant. */
  clear(port: string): NodeHandle;
  /** Replaces the node's config. */
  configure(config: Readonly<Record<string, unknown>>): NodeHandle;
  move(at: PositionLike): NodeHandle;
  setTitle(title: string | null): NodeHandle;
  /** Removes the node and its edges. */
  remove(): void;
}

/** Options of `flow.nodes.add`. */
export interface AddNodeOptions {
  /** Default: a cascade so that code-built graphs open readably in the studio. */
  at?: PositionLike;
  config?: Readonly<Record<string, unknown>>;
  /** Constants of input ports. */
  values?: Readonly<Record<string, unknown>>;
  title?: string;
  id?: string;
}

/**
 * A flow being edited from code.
 *
 * @example
 * ```ts
 * const flow = ctx.flows.create("Portrait");
 * flow.inputs.add("character", "Character");
 * flow.outputs.add("prompt", "text");
 * const tpl = flow.nodes.add("text.template", { config: { template: "Draw {c}" } });
 * flow.connect(flow.input.port("character"), tpl.port("c"));
 * flow.connect(tpl.port("text"), flow.output.port("prompt"));
 * ```
 */
export interface FlowHandle {
  readonly id: string;
  readonly name: string;
  readonly context: ContextHandle;
  readonly doc: FlowDocument;
  /** The built-in Input node: its output ports are the flow inputs. */
  readonly input: NodeHandle;
  /** The built-in Output node: its input ports are the flow outputs. */
  readonly output: NodeHandle;
  /** Flow-local types. */
  readonly types: TypesApi;
  readonly inputs: {
    add(name: string, type: TypeLike, options?: { description?: string; default?: unknown }): FlowHandle;
    remove(name: string): FlowHandle;
  };
  readonly outputs: {
    add(name: string, type: TypeLike, options?: { description?: string }): FlowHandle;
    remove(name: string): FlowHandle;
  };
  readonly variables: {
    /** `access` defaults to `"private"`. */
    create(
      name: string,
      type: TypeLike,
      options?: { access?: "public" | "private"; default?: unknown; description?: string; id?: string },
    ): VariableHandle;
    get(nameOrId: string): VariableHandle;
    list(): VariableHandle[];
  };
  readonly nodes: {
    add(type: string, options?: AddNodeOptions): NodeHandle;
    get(id: string): NodeHandle;
    list(): NodeHandle[];
    /** Adds a `briar.global.get` node for the global. */
    getGlobal(global: GlobalHandle | string, options?: Omit<AddNodeOptions, "config">): NodeHandle;
    /** Adds a `briar.global.set` node for the global. */
    setGlobal(global: GlobalHandle | string, options?: Omit<AddNodeOptions, "config">): NodeHandle;
    /** Adds a `briar.variable.get` node. */
    getVariable(variable: VariableHandle | string, options?: Omit<AddNodeOptions, "config">): NodeHandle;
    /** Adds a `briar.variable.set` node. */
    setVariable(variable: VariableHandle | string, options?: Omit<AddNodeOptions, "config">): NodeHandle;
  };
  /** Connects an output port to an input port (replacing an edge already into that input). Returns the edge id. */
  connect(from: PortRef, to: PortRef): string;
  /** Removes the edge into an input port. */
  disconnect(to: PortRef): void;
  /**
   * Wires an execution line through `nodes` in order (each one's `then` to the next one's
   * `in`). Use `flow.input` / `flow.output` for the ends.
   *
   * @example
   * ```ts
   * flow.line(flow.input, llm, print, flow.output);
   * ```
   */
  line(...nodes: readonly (NodeHandle | string)[]): FlowHandle;
  /** Wires `node`'s `failed` line to `next` (the node must be able to fail). */
  onFailure(node: NodeHandle | string, next: NodeHandle | string): FlowHandle;
  /** Replaces every execution line with Input → each execution node in data order → Output. */
  wireExecution(): FlowHandle;
  /** Runs the handle's current document (unsaved edits included). Global writes go to the stored context. */
  run(inputs?: Record<string, unknown>, options?: Omit<BriarRunOptions, "context">): Promise<BriarRun>;
}

/** Creates a handle for a loaded document. */
export function createContextHandle(host: HandleHost, doc: ContextDocument): ContextHandle {
  return new ContextHandleImpl(host, doc);
}

class ContextHandleImpl implements ContextHandle {
  readonly #host: HandleHost;
  #editor: ContextEditor;
  #savedRevision: number;
  #savedDoc: ContextDocument;
  readonly types: TypesApi;
  readonly globals: ContextHandle["globals"];
  readonly flows: ContextHandle["flows"];

  constructor(host: HandleHost, doc: ContextDocument) {
    this.#host = host;
    this.#editor = createContextEditor(doc, host.editorOptions());
    this.#savedRevision = doc.revision;
    this.#savedDoc = doc;
    this.types = typesApi(this, { kind: "global" }, () => this.doc.types, `Context "${doc.name}"`);
    this.globals = {
      create: (name, type, options = {}) => {
        const cmd: Command = { op: "global.create", name, type: toTypeInput(type, `Global "${name}"`), access: options.access ?? "readwrite" };
        if (options.value !== undefined) cmd.value = options.value;
        if (options.description !== undefined) cmd.description = options.description;
        if (options.id !== undefined) cmd.id = options.id;
        const created = this.apply(cmd);
        return this.#global(created.globalId as string);
      },
      get: (key) => {
        const g = byNameOrId(this.doc.globals, key);
        if (!g) throw notFound("global", key, `Context "${this.name}"`, this.doc.globals.map((x) => x.name));
        return this.#global(g.id);
      },
      list: () => this.doc.globals.map((g) => this.#global(g.id)),
    };
    this.flows = {
      create: (name, options = {}) => {
        const cmd: Command = { op: "flow.create", name };
        if (options.description !== undefined) cmd.description = options.description;
        if (options.id !== undefined) cmd.id = options.id;
        const created = this.apply(cmd);
        return new FlowHandleImpl(this, this.#host, created.flowId as string);
      },
      get: (key) => {
        const f = byNameOrId(this.doc.flows, key);
        if (!f) throw notFound("flow", key, `Context "${this.name}"`, this.doc.flows.map((x) => x.name));
        return new FlowHandleImpl(this, this.#host, f.id);
      },
      list: () => this.doc.flows.map((f) => new FlowHandleImpl(this, this.#host, f.id)),
    };
  }

  get id(): string {
    return this.doc.id;
  }
  get name(): string {
    return this.doc.name;
  }
  get doc(): ContextDocument {
    return this.#editor.doc;
  }
  get revision(): number {
    return this.doc.revision;
  }
  get savedRevision(): number {
    return this.#savedRevision;
  }
  get dirty(): boolean {
    return this.doc !== this.#savedDoc;
  }

  apply(command: Command): CreatedIds;
  apply(commands: readonly Command[]): CreatedIds[];
  apply(input: Command | readonly Command[]): CreatedIds | CreatedIds[] {
    const batch = Array.isArray(input);
    const result = this.#editor.applyBatch(batch ? (input as readonly Command[]) : [input as Command]);
    if (!result.ok) throw result.error;
    return batch ? result.created : (result.created[0] ?? {});
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const doc = this.doc;
    await this.#host.save(doc, this.#savedRevision);
    this.#savedRevision = doc.revision;
    this.#savedDoc = doc;
  }

  async reload(): Promise<void> {
    const doc = await this.#host.load(this.id);
    if (!doc) {
      throw new BriarError("context.not_found", `Context "${this.id}" no longer exists in the store. It may have been deleted.`, {
        details: { contextId: this.id },
      });
    }
    this.#editor.reset(doc);
    this.#savedRevision = doc.revision;
    this.#savedDoc = doc;
  }

  diagnostics(): Diagnostic[] {
    return [...this.#editor.diagnostics];
  }

  undo(): boolean {
    const r = this.#editor.undo();
    if (r && !r.ok) throw r.error;
    return r !== undefined;
  }

  redo(): boolean {
    const r = this.#editor.redo();
    if (r && !r.ok) throw r.error;
    return r !== undefined;
  }

  #global(id: string): GlobalHandle {
    const ctx = this;
    return {
      id,
      get name() {
        return ctx.#globalDecl(id).name;
      },
      get decl() {
        return ctx.#globalDecl(id);
      },
      setValue(value: unknown) {
        ctx.apply({ op: "global.setValue", globalId: id, value });
        return this;
      },
    };
  }

  #globalDecl(id: string): GlobalVariable {
    const g = this.doc.globals.find((x) => x.id === id);
    if (!g) throw notFound("global", id, `Context "${this.name}"`, this.doc.globals.map((x) => x.name));
    return g;
  }
}

function typesApi(ctx: ContextHandle, scope: ScopeInput, list: () => readonly TypeDecl[], where: string): TypesApi {
  const handle = (id: string): TypeHandle => ({
    id,
    get decl() {
      const d = list().find((t) => t.id === id);
      if (!d) throw notFound("type", id, where, list().map((t) => t.name));
      return d;
    },
    get name() {
      return this.decl.name;
    },
    get kind() {
      return this.decl.kind;
    },
  });
  return {
    defineStruct(name, fields = {}, options = {}) {
      const decls: FieldInputDecl[] = Object.entries(fields).map(([field, spec]) => {
        const where2 = `Field "${name}.${field}"`;
        if (typeof spec === "object" && spec !== null && !isTypeSpec(spec) && !("kind" in spec) && "type" in spec) {
          const d: FieldInputDecl = { name: field, type: toTypeInput(spec.type, where2) };
          if (spec.description !== undefined) d.description = spec.description;
          if (spec.default !== undefined) d.default = spec.default;
          return d;
        }
        return { name: field, type: toTypeInput(spec as TypeLike, where2) };
      });
      const cmd: Command = { op: "type.defineStruct", scope, name, fields: decls };
      if (options.description !== undefined) cmd.description = options.description;
      if (options.id !== undefined) cmd.id = options.id;
      return handle(ctx.apply(cmd).typeId as string);
    },
    defineEnum(name, members, options = {}) {
      const cmd: Command = { op: "type.defineEnum", scope, name, members: [...members] };
      if (options.description !== undefined) cmd.description = options.description;
      if (options.id !== undefined) cmd.id = options.id;
      return handle(ctx.apply(cmd).typeId as string);
    },
    get(key) {
      const t = byNameOrId(list(), key);
      if (!t) throw notFound("type", key, where, list().map((x) => x.name));
      return handle(t.id);
    },
    list() {
      return list().map((t) => handle(t.id));
    },
  };
}

class FlowHandleImpl implements FlowHandle {
  readonly types: TypesApi;
  readonly inputs: FlowHandle["inputs"];
  readonly outputs: FlowHandle["outputs"];
  readonly variables: FlowHandle["variables"];
  readonly nodes: FlowHandle["nodes"];

  constructor(
    readonly context: ContextHandle,
    private readonly host: HandleHost,
    readonly id: string,
  ) {
    const flowId = id;
    this.types = typesApi(context, { kind: "flow", flowId }, () => this.doc.types, `Flow "${this.name}"`);
    this.inputs = {
      add: (name, type, options = {}) => {
        const cmd: Command = { op: "flow.input.add", flowId, name, type: toTypeInput(type, `Input "${name}"`) };
        if (options.description !== undefined) cmd.description = options.description;
        if (options.default !== undefined) cmd.default = options.default;
        context.apply(cmd);
        return this;
      },
      remove: (name) => {
        context.apply({ op: "flow.input.remove", flowId, name });
        return this;
      },
    };
    this.outputs = {
      add: (name, type, options = {}) => {
        const cmd: Command = { op: "flow.output.add", flowId, name, type: toTypeInput(type, `Output "${name}"`) };
        if (options.description !== undefined) cmd.description = options.description;
        context.apply(cmd);
        return this;
      },
      remove: (name) => {
        context.apply({ op: "flow.output.remove", flowId, name });
        return this;
      },
    };
    const variable = (vid: string): VariableHandle => {
      const self = this;
      return {
        id: vid,
        flowId,
        get decl() {
          const v = self.doc.variables.find((x) => x.id === vid);
          if (!v) throw notFound("variable", vid, `Flow "${self.name}"`, self.doc.variables.map((x) => x.name));
          return v;
        },
        get name() {
          return this.decl.name;
        },
      };
    };
    this.variables = {
      create: (name, type, options = {}) => {
        const cmd: Command = {
          op: "flow.variable.create",
          flowId,
          name,
          type: toTypeInput(type, `Variable "${name}"`),
          access: options.access ?? "private",
        };
        if (options.default !== undefined) cmd.default = options.default;
        if (options.description !== undefined) cmd.description = options.description;
        if (options.id !== undefined) cmd.id = options.id;
        return variable(context.apply(cmd).variableId as string);
      },
      get: (key) => {
        const v = byNameOrId(this.doc.variables, key);
        if (!v) throw notFound("variable", key, `Flow "${this.name}"`, this.doc.variables.map((x) => x.name));
        return variable(v.id);
      },
      list: () => this.doc.variables.map((v) => variable(v.id)),
    };
    const globalId = (g: GlobalHandle | string): string => (typeof g === "string" ? context.globals.get(g).id : g.id);
    const variableId = (v: VariableHandle | string): string => (typeof v === "string" ? this.variables.get(v).id : v.id);
    this.nodes = {
      add: (type, options = {}) => this.#addNode(type, options),
      get: (nodeId) => {
        if (!this.doc.nodes.some((n) => n.id === nodeId)) {
          throw notFound("node", nodeId, `Flow "${this.name}"`, this.doc.nodes.map((n) => n.id));
        }
        return new NodeHandleImpl(this, nodeId);
      },
      list: () => this.doc.nodes.map((n) => new NodeHandleImpl(this, n.id)),
      getGlobal: (g, options = {}) => this.#addNode(VARIABLE_NODE_TYPES.globalGet, { ...options, config: { globalId: globalId(g) } }),
      setGlobal: (g, options = {}) => this.#addNode(VARIABLE_NODE_TYPES.globalSet, { ...options, config: { globalId: globalId(g) } }),
      getVariable: (v, options = {}) =>
        this.#addNode(VARIABLE_NODE_TYPES.variableGet, { ...options, config: { variableId: variableId(v) } }),
      setVariable: (v, options = {}) =>
        this.#addNode(VARIABLE_NODE_TYPES.variableSet, { ...options, config: { variableId: variableId(v) } }),
    };
  }

  get doc(): FlowDocument {
    const f = this.context.doc.flows.find((x) => x.id === this.id);
    if (!f) {
      throw new BriarError("flow.not_found", `Flow "${this.id}" no longer exists in context "${this.context.name}". It was deleted or undone.`, {
        details: { flowId: this.id },
      });
    }
    return f;
  }

  get name(): string {
    return this.doc.name;
  }

  get input(): NodeHandle {
    return new NodeHandleImpl(this, this.#builtin(FLOW_INPUT_NODE_TYPE));
  }

  get output(): NodeHandle {
    return new NodeHandleImpl(this, this.#builtin(FLOW_OUTPUT_NODE_TYPE));
  }

  connect(from: PortRef, to: PortRef): string {
    checkPortRef(from, "from");
    checkPortRef(to, "to");
    const created = this.context.apply({
      op: "edge.connect",
      flowId: this.id,
      from: { node: from.node, port: from.port },
      to: { node: to.node, port: to.port },
    });
    return created.edgeId as string;
  }

  disconnect(to: PortRef): void {
    checkPortRef(to, "to");
    this.context.apply({ op: "edge.disconnect", flowId: this.id, to: { node: to.node, port: to.port } });
  }

  line(...nodes: readonly (NodeHandle | string)[]): FlowHandle {
    const ids = nodes.map((n) => (typeof n === "string" ? n : n.id));
    const commands = ids.slice(1).map<Command>((to, i) => ({ op: "exec.connect", flowId: this.id, from: { node: ids[i] as string, port: EXEC_THEN }, to: { node: to, port: EXEC_IN } }));
    if (commands.length > 0) this.context.apply(commands);
    return this;
  }

  onFailure(node: NodeHandle | string, next: NodeHandle | string): FlowHandle {
    const from = typeof node === "string" ? node : node.id;
    const to = typeof next === "string" ? next : next.id;
    this.context.apply({ op: "exec.connect", flowId: this.id, from: { node: from, port: EXEC_FAILED }, to: { node: to, port: EXEC_IN } });
    return this;
  }

  wireExecution(): FlowHandle {
    this.context.apply([
      { op: "flow.exec.set", flowId: this.id, edges: null },
      { op: "flow.exec.enable", flowId: this.id },
    ]);
    return this;
  }

  run(inputs?: Record<string, unknown>, options: Omit<BriarRunOptions, "context"> = {}): Promise<BriarRun> {
    return this.host.run(this.id, inputs, { ...options, context: this.context.doc });
  }

  #builtin(type: string): string {
    const n = this.doc.nodes.find((x) => x.type === type);
    if (!n) throw new BriarError("flow.builtin_missing", `Flow "${this.name}" has no ${type} node.`);
    return n.id;
  }

  #addNode(type: string, options: AddNodeOptions): NodeHandle {
    const k = Math.max(0, this.doc.nodes.length - 2);
    const position = options.at !== undefined ? toPosition(options.at) : { x: 320 + 40 * k, y: 160 + 40 * k };
    const cmd: Command = { op: "node.add", flowId: this.id, type, position };
    if (options.config !== undefined) cmd.config = options.config;
    if (options.values !== undefined) cmd.values = options.values;
    if (options.title !== undefined) cmd.title = options.title;
    if (options.id !== undefined) cmd.id = options.id;
    return new NodeHandleImpl(this, this.context.apply(cmd).nodeId as string);
  }
}

function checkPortRef(ref: PortRef, side: string): void {
  if (typeof ref !== "object" || ref === null || typeof ref.node !== "string" || typeof ref.port !== "string") {
    throw new BriarError(
      "handle.invalid_port",
      `connect: "${side}" must be a port like node.port("text") or flow.input.port("topic") (got ${JSON.stringify(ref)}).`,
    );
  }
}

class NodeHandleImpl implements NodeHandle {
  constructor(
    readonly flow: FlowHandle,
    readonly id: string,
  ) {}

  get instance(): NodeInstance {
    const n = this.flow.doc.nodes.find((x) => x.id === this.id);
    if (!n) throw notFound("node", this.id, `Flow "${this.flow.name}"`, this.flow.doc.nodes.map((x) => x.id));
    return n;
  }

  get type(): string {
    return this.instance.type;
  }

  port(name: string): PortRef {
    return { node: this.id, port: name };
  }

  set(port: string, value: unknown): NodeHandle {
    this.flow.context.apply({ op: "node.setValue", flowId: this.flow.id, nodeId: this.id, port, value });
    return this;
  }

  clear(port: string): NodeHandle {
    this.flow.context.apply({ op: "node.clearValue", flowId: this.flow.id, nodeId: this.id, port });
    return this;
  }

  configure(config: Readonly<Record<string, unknown>>): NodeHandle {
    this.flow.context.apply({ op: "node.setConfig", flowId: this.flow.id, nodeId: this.id, config });
    return this;
  }

  move(at: PositionLike): NodeHandle {
    this.flow.context.apply({ op: "node.move", flowId: this.flow.id, nodeId: this.id, position: toPosition(at) });
    return this;
  }

  setTitle(title: string | null): NodeHandle {
    this.flow.context.apply({ op: "node.setTitle", flowId: this.flow.id, nodeId: this.id, title });
    return this;
  }

  remove(): void {
    this.flow.context.apply({ op: "node.remove", flowId: this.flow.id, nodeId: this.id });
  }
}
