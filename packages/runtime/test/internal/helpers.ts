/**
 * Test helpers for runtime internal tests: plain document builders and an in-memory
 * MediaStore (the facade's MemoryMediaStore arrives in phase 4).
 */
import {
  createCatalog,
  createSequentialIdGenerator,
  MediaError,
  type ContextDocument,
  type Edge,
  type FieldDecl,
  type FlowDocument,
  type FlowVariable,
  type GlobalVariable,
  type MediaRef,
  type MediaStore,
  type NodeInstance,
  type NodePack,
  type RunEvent,
  type SecretResolver,
  type TypeDecl,
  type TypeRef,
} from "@briarflow/core";
import { mockPack } from "@briarflow/nodes-mock";
import { stdPack } from "@briarflow/nodes-std";
import { createEngine, type EngineOptions } from "@briarflow/runtime";

export const ir = {
  text: (c?: object): TypeRef => (c ? ({ kind: "primitive", name: "text", constraints: c } as TypeRef) : { kind: "primitive", name: "text" }),
  int: (c?: object): TypeRef => (c ? ({ kind: "primitive", name: "int", constraints: c } as TypeRef) : { kind: "primitive", name: "int" }),
  float: (): TypeRef => ({ kind: "primitive", name: "float" }),
  boolean: (): TypeRef => ({ kind: "primitive", name: "boolean" }),
  image: (): TypeRef => ({ kind: "primitive", name: "image" }),
  list: (of: TypeRef): TypeRef => ({ kind: "list", of }),
  optional: (of: TypeRef): TypeRef => ({ kind: "optional", of }),
  named: (id: string): TypeRef => ({ kind: "named", id }),
};

export function field(name: string, type: TypeRef, extra: Partial<FieldDecl> = {}): FieldDecl {
  return { name, type, ...extra };
}

export function node(id: string, type: string, extra: Partial<NodeInstance> = {}): NodeInstance {
  return { id, type, position: { x: 0, y: 0 }, ...extra };
}

let edgeCounter = 0;
/** `edge("a.out", "b.in")`. */
export function edge(from: string, to: string, id?: string): Edge {
  const [fn, fp] = from.split(".") as [string, string];
  const [tn, tp] = to.split(".") as [string, string];
  edgeCounter += 1;
  return { id: id ?? `e_${edgeCounter}`, from: { node: fn, port: fp }, to: { node: tn, port: tp } };
}

export interface FlowSpec {
  id?: string;
  name?: string;
  inputs?: FieldDecl[];
  outputs?: FieldDecl[];
  variables?: FlowVariable[];
  types?: TypeDecl[];
  nodes?: NodeInstance[];
  edges?: Edge[];
}

/** A flow with `n_in` (briar.input) and `n_out` (briar.output). */
export function flow(spec: FlowSpec): FlowDocument {
  return {
    id: spec.id ?? "flow_t",
    name: spec.name ?? "Test flow",
    types: spec.types ?? [],
    inputs: spec.inputs ?? [],
    outputs: spec.outputs ?? [],
    variables: spec.variables ?? [],
    nodes: [node("n_in", "briar.input"), node("n_out", "briar.output"), ...(spec.nodes ?? [])],
    edges: spec.edges ?? [],
  };
}

export function context(flows: FlowDocument[], extra: { types?: TypeDecl[]; globals?: GlobalVariable[] } = {}): ContextDocument {
  return {
    format: "briarflow.context",
    formatVersion: 1,
    id: "ctx_t",
    name: "Test",
    revision: 3,
    createdAt: "2026-10-21T10:00:00.000Z",
    updatedAt: "2026-10-21T10:00:00.000Z",
    types: extra.types ?? [],
    globals: extra.globals ?? [],
    flows,
  };
}

/** In-memory MediaStore with ids m_1, m_2, … */
export interface TestMediaStore extends MediaStore {
  readonly items: Map<string, { ref: MediaRef; bytes: Uint8Array }>;
  text(ref: MediaRef): string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function testMediaStore(): TestMediaStore {
  const items = new Map<string, { ref: MediaRef; bytes: Uint8Array }>();
  let n = 0;
  const idOf = (ref: MediaRef | string) => {
    const uri = typeof ref === "string" ? ref : ref.uri;
    return uri.startsWith("briar-media://") ? uri.slice("briar-media://".length) : uri;
  };
  return {
    kind: "test-memory",
    items,
    text: (ref) => new TextDecoder().decode(items.get(idOf(ref))?.bytes ?? new Uint8Array()),
    async put(data, info) {
      if (!(data instanceof Uint8Array)) throw new MediaError("media.invalid_mime", "test store only takes bytes");
      n += 1;
      const id = `m_${n}`;
      const ref: MediaRef = { uri: `briar-media://${id}`, mime: info.mime, bytes: data.byteLength, hash: await sha256(data) };
      const meta = { ...(info.meta ?? {}), ...(info.filename ? { filename: info.filename } : {}) };
      if (Object.keys(meta).length > 0) ref.meta = meta;
      items.set(id, { ref, bytes: data.slice() });
      return { ...ref };
    },
    async get(ref) {
      const item = items.get(idOf(ref));
      if (!item) return undefined;
      const bytes = item.bytes;
      return {
        ref: { ...item.ref },
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async delete(ref) {
      return items.delete(idOf(ref));
    },
  };
}

export function secretsOf(values: Record<string, string>): SecretResolver {
  return { get: async (name) => values[name] };
}

/** A clock that advances 1 ms per call from a fixed start. */
export function steppingClock(start = Date.parse("2026-10-21T10:00:00.000Z")): () => Date {
  let t = start;
  return () => new Date(t++);
}

export function testEngine(extra: Partial<EngineOptions> & { packs?: NodePack[] } = {}) {
  const { packs, ...rest } = extra;
  const media = testMediaStore();
  const engine = createEngine({
    catalog: createCatalog(packs ?? [stdPack, mockPack]),
    media,
    secrets: secretsOf({}),
    clock: steppingClock(),
    idGenerator: createSequentialIdGenerator(),
    random: () => 0.5,
    ...rest,
  });
  return { engine, media };
}

export async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

/** Compact `type:nodeId` list of events. */
export function trace(events: RunEvent[]): string[] {
  return events.map((e) => ("nodeId" in e ? `${e.type}:${e.nodeId}` : e.type));
}
