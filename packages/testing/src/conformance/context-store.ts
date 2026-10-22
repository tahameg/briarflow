/**
 * `describeContextStore`: the ContextStore conformance suite of docs/specs/storage.md §3
 * (checks 1–14). Run it from a Vitest test file of your store package:
 *
 * ```ts
 * describeContextStore("redis", async () => {
 *   const store = new RedisContextStore({ url, prefix: crypto.randomUUID() });
 *   return { store, cleanup: () => store.flushAll() };
 * });
 * ```
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONTEXT_FORMAT,
  CONTEXT_FORMAT_VERSION,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  isBriarError,
  serializeContext,
  type ContextDocument,
  type ContextStore,
  type FlowDocument,
} from "@briarflow/core";
import { everyTypeContext } from "../fixtures/contexts.js";

/** What the factory of {@link describeContextStore} returns: a fresh, empty store. */
export interface ContextStoreFixture {
  store: ContextStore;
  /** Called after each test (after `store.close()`). Remove temp dirs, drop databases, … */
  cleanup?: () => void | Promise<void>;
  /**
   * Store-specific hook that writes `text` as the stored document of `id` without any
   * validation. Enables check 13 (raw / older documents, corrupt data). Default: the store's
   * own `writeRaw(id, text)` method when it has one; check 13 is skipped without either.
   */
  writeRaw?: (id: string, text: string) => void | Promise<void>;
}

/** Options of {@link describeContextStore}. */
export interface ContextStoreSuiteOptions {
  /** Per-test timeout in ms for the slower checks (pagination of 205 contexts, 1 MB round-trip). Default 30 000. */
  slowTimeoutMs?: number;
}

let flowCounter = 0;

interface DocSpec {
  name?: string;
  description?: string;
  revision?: number;
  updatedAt?: string;
  flows?: { id: string; name: string }[];
}

/** A small valid context document (exported for store authors' own tests). */
export function storeTestDoc(id: string, spec: DocSpec = {}): ContextDocument {
  const flows: FlowDocument[] = (spec.flows ?? []).map((f) => {
    flowCounter += 1;
    return {
      id: f.id,
      name: f.name,
      types: [],
      inputs: [],
      outputs: [],
      variables: [],
      nodes: [
        { id: `n_in${flowCounter}`, type: FLOW_INPUT_NODE_TYPE, position: { x: 0, y: 0 } },
        { id: `n_out${flowCounter}`, type: FLOW_OUTPUT_NODE_TYPE, position: { x: 640, y: 0 } },
      ],
      edges: [],
    };
  });
  const doc: ContextDocument = {
    format: CONTEXT_FORMAT,
    formatVersion: CONTEXT_FORMAT_VERSION,
    id,
    name: spec.name ?? `Context ${id}`,
    revision: spec.revision ?? 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: spec.updatedAt ?? "2026-10-21T10:00:00.000Z",
    types: [],
    globals: [],
    flows,
  };
  if (spec.description !== undefined) doc.description = spec.description;
  return doc;
}

interface CaughtError {
  code: string;
  message: string;
  details: unknown;
  cause?: unknown;
}

async function rejection(promise: Promise<unknown>): Promise<CaughtError> {
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (error) {
    expect(isBriarError(error), `expected a BriarError, got ${String(error)}`).toBe(true);
    return error as CaughtError;
  }
  expect(resolved, "expected the call to reject").toBe(false);
  throw new Error("unreachable");
}

async function ids(store: ContextStore, search?: string): Promise<string[]> {
  return (await store.list(search === undefined ? {} : { search })).items.map((s) => s.id);
}

/**
 * Registers the ContextStore conformance suite (storage.md §3, checks 1–14) as a Vitest
 * `describe` block. `factory` is called before every test and must return a fresh, empty
 * store; the suite closes it (if it has `close`) and calls `cleanup` after every test.
 *
 * @example
 * ```ts
 * describeContextStore("sqlite", () => ({ store: new SqliteContextStore({ file: ":memory:" }) }));
 * ```
 */
export function describeContextStore(
  name: string,
  factory: () => ContextStoreFixture | Promise<ContextStoreFixture>,
  options: ContextStoreSuiteOptions = {},
): void {
  const slow = options.slowTimeoutMs ?? 30_000;

  describe(`ContextStore conformance: ${name}`, () => {
    let fixture: ContextStoreFixture;
    let store: ContextStore;

    beforeEach(async () => {
      fixture = await factory();
      store = fixture.store;
      if (fixture.writeRaw === undefined) {
        const own = (store as { writeRaw?: unknown }).writeRaw;
        if (typeof own === "function") {
          fixture = { ...fixture, writeRaw: (id, text) => (own as (id: string, text: string) => unknown).call(store, id, text) as Promise<void> };
        }
      }
    });

    afterEach(async () => {
      try {
        await store.close?.();
      } finally {
        await fixture.cleanup?.();
      }
    });

    it("has a non-empty kind", () => {
      expect(typeof store.kind).toBe("string");
      expect(store.kind.length).toBeGreaterThan(0);
    });

    it("1. load of an unknown id is undefined", async () => {
      expect(await store.load("ctx_missing")).toBeUndefined();
    });

    it("2. save then load is deep-equal; loaded objects are not shared", async () => {
      const doc = storeTestDoc("ctx_a", { description: "A description", flows: [{ id: "flow_a1", name: "One" }] });
      await store.save(doc);
      const first = await store.load("ctx_a");
      expect(first).toEqual(doc);
      expect(first).not.toBe(doc);
      (first as { name: string }).name = "mutated";
      (first?.flows as FlowDocument[]).length = 0;
      const second = await store.load("ctx_a");
      expect(second).toEqual(doc);
      expect(second).not.toBe(first);
      // Mutating the saved input afterwards does not change the store either.
      (doc as { name: string }).name = "changed after save";
      expect((await store.load("ctx_a"))?.name).toBe("Context ctx_a");
    });

    it("2b. save does not modify the document (no revision bump)", async () => {
      const doc = storeTestDoc("ctx_a", { revision: 7 });
      const copy = structuredClone(doc);
      await store.save(doc);
      expect(doc).toEqual(copy);
      expect((await store.load("ctx_a"))?.revision).toBe(7);
    });

    it("3. save is an upsert: a second save replaces", async () => {
      await store.save(storeTestDoc("ctx_a", { revision: 1, name: "First" }));
      await store.save(storeTestDoc("ctx_a", { revision: 2, name: "Second" }));
      expect(await store.load("ctx_a")).toEqual(storeTestDoc("ctx_a", { revision: 2, name: "Second" }));
      expect(await ids(store)).toEqual(["ctx_a"]);
    });

    it("4. expectedRevision: match saves, mismatch is a RevisionConflictError", async () => {
      await store.save(storeTestDoc("ctx_a", { revision: 1 }), { expectedRevision: 0 });
      await store.save(storeTestDoc("ctx_a", { revision: 2 }), { expectedRevision: 1 });
      const conflict = await rejection(store.save(storeTestDoc("ctx_a", { revision: 3, name: "Mine" }), { expectedRevision: 1 }));
      expect(conflict.code).toBe("store.revision_conflict");
      expect(conflict.details).toEqual({ id: "ctx_a", expected: 1, actual: 2 });
      expect(conflict.message).toBe('Context "Mine" was changed by someone else (revision 2, you had 1). Reload and try again.');
      expect((await store.load("ctx_a"))?.revision).toBe(2);
      // expectedRevision 0 on an existing id → conflict.
      const zero = await rejection(store.save(storeTestDoc("ctx_a", { revision: 3 }), { expectedRevision: 0 }));
      expect(zero.code).toBe("store.revision_conflict");
      expect(zero.details).toEqual({ id: "ctx_a", expected: 0, actual: 2 });
      // A missing document counts as revision 0.
      const missing = await rejection(store.save(storeTestDoc("ctx_b", { revision: 3 }), { expectedRevision: 2 }));
      expect(missing.details).toEqual({ id: "ctx_b", expected: 2, actual: 0 });
      expect(await store.load("ctx_b")).toBeUndefined();
      // Omitted expectedRevision: unconditional.
      await store.save(storeTestDoc("ctx_a", { revision: 9 }));
      expect((await store.load("ctx_a"))?.revision).toBe(9);
    });

    it("5. five concurrent saves with the same expectedRevision: exactly one succeeds", async () => {
      await store.save(storeTestDoc("ctx_a", { revision: 1 }));
      const results = await Promise.allSettled(
        [0, 1, 2, 3, 4].map((i) => store.save(storeTestDoc("ctx_a", { revision: 2, name: `Writer ${i}` }), { expectedRevision: 1 })),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect((r.reason as { code?: string }).code).toBe("store.revision_conflict");
      }
      const winner = results.findIndex((r) => r.status === "fulfilled");
      expect(await store.load("ctx_a")).toEqual(storeTestDoc("ctx_a", { revision: 2, name: `Writer ${winner}` }));
    });

    it("6. a flow id of another context is a FlowIdConflictError; the failing save changes nothing", async () => {
      await store.save(storeTestDoc("ctx_a", { flows: [{ id: "flow_x", name: "X" }] }));
      const before = storeTestDoc("ctx_b", { name: "B before", flows: [{ id: "flow_y", name: "Y" }] });
      await store.save(before);
      const err = await rejection(
        store.save(storeTestDoc("ctx_b", { name: "B after", revision: 2, flows: [{ id: "flow_z", name: "Z" }, { id: "flow_x", name: "X2" }] })),
      );
      expect(err.code).toBe("store.flow_id_conflict");
      expect(err.details).toEqual({ flowId: "flow_x", contextId: "ctx_a" });
      expect(await store.load("ctx_b")).toEqual(before);
      expect(await store.locateFlow("flow_x")).toBe("ctx_a");
      expect(await store.locateFlow("flow_y")).toBe("ctx_b");
      expect(await store.locateFlow("flow_z")).toBeUndefined();
      // A new context too.
      const fresh = await rejection(store.save(storeTestDoc("ctx_c", { flows: [{ id: "flow_y", name: "Y" }] })));
      expect(fresh.code).toBe("store.flow_id_conflict");
      expect(fresh.details).toEqual({ flowId: "flow_y", contextId: "ctx_b" });
      expect(await store.load("ctx_c")).toBeUndefined();
      expect(await ids(store)).not.toContain("ctx_c");
    });

    it("7. delete: true then false; gone from load, list and locateFlow", async () => {
      await store.save(storeTestDoc("ctx_a", { flows: [{ id: "flow_a", name: "A" }] }));
      await store.save(storeTestDoc("ctx_b"));
      expect(await store.delete("ctx_a")).toBe(true);
      expect(await store.delete("ctx_a")).toBe(false);
      expect(await store.delete("ctx_never")).toBe(false);
      expect(await store.load("ctx_a")).toBeUndefined();
      expect(await ids(store)).toEqual(["ctx_b"]);
      expect(await store.locateFlow("flow_a")).toBeUndefined();
      // The flow id is free again.
      await store.save(storeTestDoc("ctx_b", { revision: 2, flows: [{ id: "flow_a", name: "A" }] }));
      expect(await store.locateFlow("flow_a")).toBe("ctx_b");
    });

    it("8. list order: updatedAt descending, then id ascending (ties)", async () => {
      const tie = "2026-10-21T10:00:00.000Z";
      for (const id of ["ctx_d", "ctx_b", "ctx_c", "ctx_a"]) await store.save(storeTestDoc(id, { updatedAt: tie }));
      await store.save(storeTestDoc("ctx_z", { updatedAt: "2026-10-21T11:00:00.000Z" }));
      await store.save(storeTestDoc("ctx_0", { updatedAt: "2025-01-01T00:00:00.000Z" }));
      const page = await store.list();
      expect(page.items.map((s) => s.id)).toEqual(["ctx_z", "ctx_a", "ctx_b", "ctx_c", "ctx_d", "ctx_0"]);
      expect(page.nextCursor).toBeUndefined();
    });

    it("list items are ContextSummary objects with flows in document order", async () => {
      await store.save(storeTestDoc("ctx_a", { name: "Alpha", revision: 4, flows: [{ id: "flow_2", name: "Second" }, { id: "flow_1", name: "First" }] }));
      expect(await store.list()).toEqual({
        items: [
          {
            id: "ctx_a",
            name: "Alpha",
            revision: 4,
            updatedAt: "2026-10-21T10:00:00.000Z",
            flows: [
              { id: "flow_2", name: "Second" },
              { id: "flow_1", name: "First" },
            ],
          },
        ],
      });
    });

    it("9. list search: name, description, flow names; case-insensitive; trimmed; non-match empty", async () => {
      await store.save(storeTestDoc("ctx_m", { name: "Marketing", updatedAt: "2026-10-21T09:00:00.000Z" }));
      await store.save(storeTestDoc("ctx_d", { name: "Other", description: "Used by the mark team", updatedAt: "2026-10-21T10:00:00.000Z" }));
      await store.save(storeTestDoc("ctx_f", { name: "Third", flows: [{ id: "flow_f", name: "Bookmarks" }], updatedAt: "2026-10-21T08:00:00.000Z" }));
      await store.save(storeTestDoc("ctx_n", { name: "Nothing", description: "nope", updatedAt: "2026-10-21T07:00:00.000Z" }));
      expect(await ids(store, "MARK")).toEqual(["ctx_d", "ctx_m", "ctx_f"]);
      expect(await ids(store, "Marketing")).toEqual(["ctx_m"]);
      expect(await ids(store, "  keting  ")).toEqual(["ctx_m"]);
      expect(await ids(store, "bookMARKS")).toEqual(["ctx_f"]);
      expect(await ids(store, "mark team")).toEqual(["ctx_d"]);
      expect(await ids(store, "markteam")).toEqual([]);
      expect(await ids(store, "zzz")).toEqual([]);
      expect(await ids(store, "")).toHaveLength(4);
      expect(await ids(store, "   ")).toHaveLength(4);
    });

    it(
      "10. pagination: 7 contexts, limit 3 → 3, 3, 1; union = all; clamping; invalid cursor/limit",
      async () => {
        for (let i = 0; i < 7; i++) await store.save(storeTestDoc(`ctx_${i}`, { updatedAt: `2026-10-21T10:00:0${i % 3}.000Z` }));
        const sizes: number[] = [];
        const seen: string[] = [];
        let cursor: string | undefined;
        let guard = 0;
        do {
          const page = await store.list(cursor === undefined ? { limit: 3 } : { limit: 3, cursor });
          sizes.push(page.items.length);
          seen.push(...page.items.map((s) => s.id));
          cursor = page.nextCursor;
          guard += 1;
        } while (cursor !== undefined && guard < 10);
        expect(sizes).toEqual([3, 3, 1]);
        expect(new Set(seen).size).toBe(7);
        expect(seen).toEqual(await ids(store));
        // An exact multiple has no extra cursor.
        const all = await store.list({ limit: 7 });
        expect(all.items).toHaveLength(7);
        expect(all.nextCursor).toBeUndefined();
        // limit may change between pages; search must not.
        const first = await store.list({ limit: 2 });
        const rest = await store.list({ limit: 10, cursor: first.nextCursor as string });
        expect([...first.items, ...rest.items].map((s) => s.id)).toEqual(seen);
        expect(rest.nextCursor).toBeUndefined();
        const other = await rejection(store.list({ search: "ctx", cursor: first.nextCursor as string }));
        expect(other.code).toBe("store.invalid_cursor");
        // Malformed cursors and invalid limits.
        for (const bad of ["not a cursor!", "abc"]) {
          expect((await rejection(store.list({ cursor: bad }))).code).toBe("store.invalid_cursor");
        }
        for (const limit of [0, -1, 1.5, Number.NaN]) {
          expect((await rejection(store.list({ limit }))).code).toBe("store.invalid_query");
        }
      },
      slow,
    );

    it(
      "10b. limit defaults to 50 and values > 200 are clamped to 200",
      async () => {
        for (let i = 0; i < 205; i++) await store.save(storeTestDoc(`ctx_${String(i).padStart(3, "0")}`));
        const clamped = await store.list({ limit: 500 });
        expect(clamped.items).toHaveLength(200);
        expect(clamped.nextCursor).toBeDefined();
        const last = await store.list({ limit: 500, cursor: clamped.nextCursor as string });
        expect(last.items).toHaveLength(5);
        expect(last.nextCursor).toBeUndefined();
        expect((await store.list()).items).toHaveLength(50);
      },
      slow,
    );

    it("empty store lists nothing", async () => {
      expect(await store.list()).toEqual({ items: [] });
      expect(await store.list({ search: "anything" })).toEqual({ items: [] });
    });

    it("11. locateFlow after save, after removing a flow, after moving it and after delete", async () => {
      expect(await store.locateFlow("flow_1")).toBeUndefined();
      await store.save(storeTestDoc("ctx_a", { flows: [{ id: "flow_1", name: "One" }, { id: "flow_2", name: "Two" }] }));
      expect(await store.locateFlow("flow_1")).toBe("ctx_a");
      expect(await store.locateFlow("flow_2")).toBe("ctx_a");
      await store.save(storeTestDoc("ctx_a", { revision: 2, flows: [{ id: "flow_2", name: "Two" }] }));
      expect(await store.locateFlow("flow_1")).toBeUndefined();
      await store.save(storeTestDoc("ctx_b", { flows: [{ id: "flow_1", name: "Moved" }] }));
      expect(await store.locateFlow("flow_1")).toBe("ctx_b");
      expect(await store.delete("ctx_a")).toBe(true);
      expect(await store.locateFlow("flow_2")).toBeUndefined();
      expect(await store.locateFlow("flow_1")).toBe("ctx_b");
    });

    it(
      "12. round-trip of a document with every type kind, unicode names and 1 MB of text",
      async () => {
        const doc = everyTypeContext();
        await store.save(doc);
        const loaded = await store.load(doc.id);
        expect(loaded).toEqual(doc);
        expect(serializeContext(loaded as ContextDocument)).toBe(serializeContext(doc));
        expect(await ids(store, "文脈")).toEqual([doc.id]);
        expect(await ids(store, "EVERY TYPE 🌱")).toEqual([doc.id]);
        expect(await store.locateFlow("flow_every")).toBe(doc.id);
      },
      slow,
    );

    it("13. a raw stored document is read through deserializeContext; corrupt data is store.corrupt", async (ctx) => {
      if (!fixture.writeRaw) {
        ctx.skip();
        return;
      }
      const doc = storeTestDoc("ctx_raw", { flows: [{ id: "flow_raw", name: "Raw" }] });
      // Only format version 1 exists so far: an unsorted, compact v1 text stands in for "older".
      await fixture.writeRaw("ctx_raw", JSON.stringify(doc));
      expect(await store.load("ctx_raw")).toEqual(doc);
      await fixture.writeRaw("ctx_bad", "{ this is not json");
      const corrupt = await rejection(store.load("ctx_bad"));
      expect(corrupt.code).toBe("store.corrupt");
      expect(corrupt.details).toEqual({ id: "ctx_bad" });
      expect((corrupt.cause as { code?: string } | undefined)?.code).toBe("format.invalid");
      await fixture.writeRaw("ctx_new", JSON.stringify({ ...storeTestDoc("ctx_new"), formatVersion: 99 }));
      const tooNew = await rejection(store.load("ctx_new"));
      expect(tooNew.code).toBe("store.corrupt");
      expect((tooNew.cause as { code?: string } | undefined)?.code).toBe("format.unsupported_version");
      // An unconditional save replaces a corrupt document.
      await store.save(storeTestDoc("ctx_bad"));
      expect(await store.load("ctx_bad")).toEqual(storeTestDoc("ctx_bad"));
    });

    it("14. close is idempotent; calls after close throw store.closed", async (ctx) => {
      if (typeof store.close !== "function") {
        ctx.skip();
        return;
      }
      await store.save(storeTestDoc("ctx_a"));
      await store.close();
      await store.close();
      const calls: (() => Promise<unknown>)[] = [
        () => store.load("ctx_a"),
        () => store.save(storeTestDoc("ctx_b")),
        () => store.delete("ctx_a"),
        () => store.list(),
        () => store.locateFlow("flow_x"),
      ];
      for (const call of calls) expect((await rejection(call())).code).toBe("store.closed");
    });

    it("save rejects invalid documents with store.invalid_document and stores nothing", async () => {
      const bad: unknown[] = [
        null,
        "text",
        42,
        { ...storeTestDoc("ctx_a"), format: "something.else" },
        { ...storeTestDoc("ctx_a"), id: "../etc/passwd" },
        { ...storeTestDoc("ctx_a"), id: "flow_wrongprefix" },
      ];
      for (const doc of bad) {
        expect((await rejection(store.save(doc as ContextDocument))).code).toBe("store.invalid_document");
      }
      expect(await store.list()).toEqual({ items: [] });
    });
  });
}
