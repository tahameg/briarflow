/**
 * `describeNodePack`: conformance checks for a node pack (docs/specs/node-api.md §1, §7, §8):
 * pack and descriptor sanity, `defineNode` invariants, naming rules, and (with samples) that
 * every node runs through {@link runNode}.
 */
import { describe, expect, it } from "vitest";
import {
  createCatalog,
  defineNode,
  isBriarError,
  isTypeSpec,
  isValidFieldName,
  isValidNodeType,
  isValidPackName,
  toNodeDescriptor,
  type AnyNodeDefinition,
  type ContextDocument,
  type NodePack,
  type Port,
  type TypeRef,
} from "@briarflow/core";
import { runNode, type RunNodeOptions, type RunNodeResult } from "../run-node.js";

/** One sample execution of a node. */
export interface NodeSample extends Omit<RunNodeOptions, "packs"> {
  /** Test name suffix. Default: `sample <n>`. */
  name?: string;
  /** Inputs by port name. Default `{}`. */
  inputs?: Record<string, unknown>;
  /** Expected outputs (deep equality on the normalized outputs). */
  outputs?: Record<string, unknown>;
  /** The run must reject with a `BriarError` of this code instead. */
  errorCode?: string;
  /** Extra assertions on the result. */
  check?: (result: RunNodeResult) => void | Promise<void>;
}

/** Options of {@link describeNodePack}. */
export interface NodePackSuiteOptions {
  /** Packs this pack needs in the catalog (e.g. `stdPack`), for types and namespaces. */
  dependencies?: readonly NodePack[];
  /** Samples by node type. Each runs through `runNode`. */
  samples?: Readonly<Record<string, readonly NodeSample[]>>;
  /** Fail when a node has no sample (default `false`: such nodes are reported as todo). */
  requireSamples?: boolean;
  /** A context used for samples that do not give their own. */
  context?: ContextDocument;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function portRef(port: Port): TypeRef | undefined {
  if (isTypeSpec(port)) return port.ref;
  if (typeof port === "object" && port !== null && isTypeSpec((port as { type?: unknown }).type)) return (port as { type: { ref: TypeRef } }).type.ref;
  return undefined;
}

function namedIds(ref: TypeRef, out: string[] = []): string[] {
  if (ref.kind === "named") out.push(ref.id);
  if (ref.kind === "list" || ref.kind === "optional") namedIds(ref.of, out);
  return out;
}

/**
 * Registers conformance checks for a node pack as a Vitest `describe` block.
 *
 * @example
 * ```ts
 * describeNodePack(wordsPack, {
 *   samples: { "words.shout": [{ inputs: { text: "hi" }, outputs: { text: "HI!" } }] },
 * });
 * ```
 */
export function describeNodePack(pack: NodePack, options: NodePackSuiteOptions = {}): void {
  const deps = options.dependencies ?? [];
  const samples = options.samples ?? {};

  describe(`NodePack conformance: ${pack.name}@${pack.version}`, () => {
    it("is a pack from definePack with a valid name, semver version and namespaces", () => {
      expect(pack.kind).toBe("nodePack");
      expect(isValidPackName(pack.name), `pack name "${pack.name}"`).toBe(true);
      expect(pack.version).toMatch(SEMVER);
      expect(pack.namespaces).toContain(pack.name);
      expect(new Set(pack.namespaces).size).toBe(pack.namespaces.length);
      expect(typeof pack.title).toBe("string");
      expect(pack.title.trim()).not.toBe("");
    });

    it("loads into a catalog together with its dependencies", () => {
      const catalog = createCatalog([...deps, pack]);
      for (const def of pack.nodes) {
        expect(catalog.get(def.type)).toBe(def);
        expect(catalog.packOf(def.type)?.name).toBe(pack.name);
      }
    });

    it("pack types have qualified ids and unique names", () => {
      const names = new Set<string>();
      for (const type of pack.types) {
        expect(type.id).toBe(`${pack.name}.${type.name}`);
        expect(names.has(type.name.toLowerCase()), `duplicate type name ${type.name}`).toBe(false);
        names.add(type.name.toLowerCase());
      }
    });

    it("node types are unique, valid and inside the pack's namespaces", () => {
      const seen = new Set<string>();
      for (const def of pack.nodes) {
        expect(isValidNodeType(def.type), `node type "${def.type}"`).toBe(true);
        expect(seen.has(def.type), `duplicate node type ${def.type}`).toBe(false);
        seen.add(def.type);
        expect(pack.namespaces, `namespace of ${def.type}`).toContain(def.type.split(".")[0]);
      }
    });

    describe.each(pack.nodes.map((def) => [def.type, def] as const))("node %s", (_type, def: AnyNodeDefinition) => {
      it("satisfies the defineNode invariants (re-defining it does not throw)", () => {
        expect(def.kind).toBe("nodeDefinition");
        expect(typeof def.run).toBe("function");
        expect(Number.isSafeInteger(def.timeoutMs) && def.timeoutMs >= 0).toBe(true);
        expect(Number.isSafeInteger(def.retry.maxAttempts) && def.retry.maxAttempts >= 1).toBe(true);
        expect(typeof def.cache).toBe("boolean");
        expect(typeof def.cacheVersion).toBe("string");
        if (def.concurrency !== undefined) expect(Number.isSafeInteger(def.concurrency) && def.concurrency >= 1).toBe(true);
        for (const s of def.secrets) expect(typeof s === "string" && s !== "").toBe(true);
        expect(() => defineNode({ ...(def as object) } as never)).not.toThrow();
      });

      it("follows the naming conventions (title, ports)", () => {
        expect(def.title.trim()).not.toBe("");
        expect(def.title[0], `title "${def.title}" should start with a capital letter`).toBe(def.title[0]?.toUpperCase());
        expect(def.title.includes(def.type), `title "${def.title}" should not repeat the node type`).toBe(false);
        for (const name of [...Object.keys(def.inputs), ...Object.keys(def.outputs), ...Object.keys(def.config)]) {
          expect(isValidFieldName(name), `port/config name "${name}"`).toBe(true);
        }
      });

      it("port types only reference visible types (own pack types or document types)", () => {
        const visible = new Set([...pack.types, ...deps.flatMap((p) => p.types)].map((t) => t.id));
        for (const port of [...Object.values(def.inputs), ...Object.values(def.outputs)]) {
          const ref = portRef(port);
          expect(ref, "port must have a type").toBeDefined();
          for (const id of namedIds(ref as TypeRef)) {
            if (id.includes(".")) expect(visible.has(id), `type ${id} used by ${def.type}`).toBe(true);
          }
        }
      });

      it("has a plain-JSON descriptor", () => {
        const descriptor = toNodeDescriptor(def, pack);
        expect(descriptor.type).toBe(def.type);
        expect(descriptor.pack).toEqual({ name: pack.name, version: pack.version });
        expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
        expect(descriptor.dynamicPorts).toBe(def.resolvePorts !== undefined);
      });

      const own = samples[def.type] ?? [];
      if (own.length === 0) {
        if (options.requireSamples) {
          it("has a sample", () => {
            expect.fail(`no sample for ${def.type}: pass options.samples["${def.type}"]`);
          });
        } else {
          it.todo("runs through runNode (no sample given)");
        }
      }
      own.forEach((sample, i) => {
        it(`runs through runNode: ${sample.name ?? `sample ${i + 1}`}`, async () => {
          const { name: _name, inputs, outputs, errorCode, check, ...runOptions } = sample;
          const ctxOptions: RunNodeOptions = { ...runOptions, packs: [...deps, pack] };
          if (ctxOptions.context === undefined && options.context !== undefined) ctxOptions.context = options.context;
          if (errorCode !== undefined) {
            let caught: unknown;
            try {
              await runNode(def, inputs ?? {}, ctxOptions);
            } catch (error) {
              caught = error;
            }
            expect(isBriarError(caught), `expected ${def.type} to fail with ${errorCode}, got ${String(caught)}`).toBe(true);
            expect((caught as { code: string }).code).toBe(errorCode);
            return;
          }
          const result = await runNode(def, inputs ?? {}, ctxOptions);
          if (outputs !== undefined) expect(result.outputs).toEqual(outputs);
          await check?.(result as RunNodeResult);
        });
      });
    });
  });
}
