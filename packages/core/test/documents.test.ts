/**
 * Document factories and serialization (phase-1.md §5.8; ARCH §4.6–4.7).
 */
import { describe, expect, it } from "vitest";
import {
  CONTEXT_FORMAT,
  CONTEXT_FORMAT_VERSION,
  FLOW_INPUT_NODE_TYPE,
  FLOW_OUTPUT_NODE_TYPE,
  FormatError,
  VARIABLE_NODE_TYPES,
  createContextDocument,
  createFlowDocument,
  createSequentialIdGenerator,
  deserializeContext,
  findFlow,
  findNode,
  serializeContext,
  type ContextDocument,
} from "@briarflow/core";
import {
  FIXED_TIME,
  PORTRAIT_FLOW_ID,
  catchError,
  editContext,
  everyTypeContext,
  expectBriarError,
  fixedClock,
  portraitContext,
  reverseKeysDeep,
  sortKeysDeep,
  variablesContext,
} from "@briarflow/testing";

describe("constants", () => {
  it("match the contract", () => {
    expect(CONTEXT_FORMAT).toBe("briarflow.context");
    expect(CONTEXT_FORMAT_VERSION).toBe(1);
    expect(FLOW_INPUT_NODE_TYPE).toBe("briar.input");
    expect(FLOW_OUTPUT_NODE_TYPE).toBe("briar.output");
    expect(VARIABLE_NODE_TYPES).toEqual({
      variableGet: "briar.variable.get",
      variableSet: "briar.variable.set",
      globalGet: "briar.global.get",
      globalSet: "briar.global.set",
    });
  });
});

describe("createContextDocument", () => {
  it("creates an empty context with injected id and clock", () => {
    const doc = createContextDocument({ name: "Marketing", idGenerator: createSequentialIdGenerator(), clock: fixedClock });
    expect(doc).toEqual({
      format: "briarflow.context",
      formatVersion: 1,
      id: "ctx_1",
      name: "Marketing",
      revision: 0,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
      types: [],
      globals: [],
      flows: [],
    });
  });

  it("uses an explicit id and description", () => {
    const doc = createContextDocument({ name: "M", id: "ctx_mine", description: "About", clock: fixedClock });
    expect(doc.id).toBe("ctx_mine");
    expect(doc.description).toBe("About");
  });

  it("generates a valid random id by default and an ISO UTC timestamp", () => {
    const doc = createContextDocument({ name: "M" });
    expect(doc.id).toMatch(/^ctx_[A-Za-z0-9_-]{1,60}$/);
    expect(doc.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    expect(doc.updatedAt).toBe(doc.createdAt);
  });

  it("rejects a bad id", () => {
    expectBriarError(() => createContextDocument({ name: "M", id: "flow_x" }), "document.invalid_id");
    expectBriarError(() => createContextDocument({ name: "M", id: "ctx_a b" }), "document.invalid_id");
  });

  it("rejects an empty or too long name", () => {
    expectBriarError(() => createContextDocument({ name: "" }), "document.invalid_name");
    expectBriarError(() => createContextDocument({ name: "x".repeat(121) }), "document.invalid_name");
    expect(() => createContextDocument({ name: "x".repeat(120) })).not.toThrow();
  });
});

describe("createFlowDocument", () => {
  it("creates a flow with briar.input at {0,0} and briar.output at {640,0}", () => {
    const flow = createFlowDocument({ name: "Portrait", idGenerator: createSequentialIdGenerator() });
    expect(flow).toEqual({
      id: "flow_1",
      name: "Portrait",
      types: [],
      inputs: [],
      outputs: [],
      variables: [],
      nodes: [
        { id: "n_1", type: "briar.input", position: { x: 0, y: 0 } },
        { id: "n_2", type: "briar.output", position: { x: 640, y: 0 } },
      ],
      edges: [],
      execEdges: [{ id: "x_1", from: { node: "n_1", port: "then" }, to: { node: "n_2", port: "in" } }],
    });
  });

  it("uses explicit ids and description", () => {
    const flow = createFlowDocument({ name: "P", id: "flow_p", inputNodeId: "n_in", outputNodeId: "n_out", description: "d" });
    expect(flow.id).toBe("flow_p");
    expect(flow.description).toBe("d");
    expect(flow.nodes.map((n) => n.id)).toEqual(["n_in", "n_out"]);
  });
});

describe("findFlow / findNode", () => {
  it("find by id", () => {
    const doc = portraitContext();
    const flow = findFlow(doc, PORTRAIT_FLOW_ID)!;
    expect(flow.name).toBe("Portrait");
    expect(findNode(flow, "n_tpl")?.type).toBe("text.template");
    expect(findFlow(doc, "flow_ghost")).toBeUndefined();
    expect(findNode(flow, "n_ghost")).toBeUndefined();
  });
});

describe("serializeContext", () => {
  const docs: [string, () => ContextDocument][] = [
    ["portrait", portraitContext],
    ["every type (1 MB)", everyTypeContext],
    ["variables A", () => variablesContext("A")],
  ];

  it.each(docs)("%s: sorted keys, 2-space indent, trailing newline", (_label, make) => {
    const doc = make();
    const text = serializeContext(doc);
    expect(text).toBe(JSON.stringify(sortKeysDeep(doc), null, 2) + "\n");
  });

  it.each(docs)("%s: documents equal up to key order serialize identically", (_label, make) => {
    const doc = make();
    expect(serializeContext(reverseKeysDeep(doc) as ContextDocument)).toBe(serializeContext(doc));
  });

  it.each(docs)("%s: round-trips through deserializeContext", (_label, make) => {
    const doc = make();
    expect(deserializeContext(serializeContext(doc))).toEqual(doc);
  });

  it("drops undefined entries", () => {
    const doc = { ...portraitContext(), description: undefined } as unknown as ContextDocument;
    expect(serializeContext(doc)).not.toContain('"description"');
  });

  it("does not mutate the document", () => {
    const doc = portraitContext();
    const copy = structuredClone(doc);
    serializeContext(doc);
    expect(doc).toEqual(copy);
  });

  it("keeps array order", () => {
    const text = serializeContext(portraitContext());
    expect(text.indexOf('"e_1"')).toBeLessThan(text.indexOf('"e_4"'));
    expect(text.indexOf('"n_in"')).toBeLessThan(text.indexOf('"n_tpl"'));
  });
});

describe("deserializeContext", () => {
  it("accepts an object and never mutates it", () => {
    const input = JSON.parse(JSON.stringify(portraitContext())) as unknown;
    const copy = structuredClone(input);
    const doc = deserializeContext(input);
    expect(doc).toEqual(portraitContext());
    expect(input).toEqual(copy);
  });

  it("accepts a string", () => {
    expect(deserializeContext(JSON.stringify(portraitContext()))).toEqual(portraitContext());
  });

  function formatError(input: unknown, code: string): Record<string, unknown> {
    const error = expectBriarError(() => deserializeContext(input), code, FormatError);
    return (error.details ?? {}) as Record<string, unknown>;
  }

  it("non-JSON → format.invalid", () => {
    formatError("{ not json", "format.invalid");
    formatError("", "format.invalid");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 42],
  ])("%s → format.invalid", (_label, input) => {
    formatError(input, "format.invalid");
  });

  const mutated = (edit: (d: Record<string, unknown>) => void): unknown => {
    const d = JSON.parse(JSON.stringify(portraitContext())) as Record<string, unknown>;
    edit(d);
    return d;
  };

  it.each([
    ["wrong format", (d: Record<string, unknown>) => void (d.format = "other.format"), "format"],
    ["missing id", (d: Record<string, unknown>) => void delete d.id, "id"],
    ["missing flows", (d: Record<string, unknown>) => void delete d.flows, "flows"],
    ["flows not an array", (d: Record<string, unknown>) => void (d.flows = {}), "flows"],
    ["revision not a number", (d: Record<string, unknown>) => void (d.revision = "1"), "revision"],
    ["name not a string", (d: Record<string, unknown>) => void (d.name = 5), "name"],
    ["types not an array", (d: Record<string, unknown>) => void (d.types = "x"), "types"],
    [
      "node position not an object",
      (d: Record<string, unknown>) => void (((d.flows as Record<string, unknown>[])[0]!.nodes as Record<string, unknown>[])[0]!.position = "0,0"),
      "flows",
    ],
    [
      "edge without from",
      (d: Record<string, unknown>) => void delete ((d.flows as Record<string, unknown>[])[0]!.edges as Record<string, unknown>[])[0]!.from,
      "flows",
    ],
  ])("%s → format.invalid with details.path", (_label, edit, pathFragment) => {
    const details = formatError(mutated(edit), "format.invalid");
    expect(typeof details.path).toBe("string");
    expect(details.path as string).toContain(pathFragment);
  });

  it("formatVersion newer than supported → format.unsupported_version", () => {
    const details = formatError(mutated((d) => void (d.formatVersion = 2)), "format.unsupported_version");
    expect(details).toMatchObject({ formatVersion: 2 });
    expect(details.supported).toBeDefined();
  });

  it.each([1.5, "1", 0, -1])("formatVersion %j → format.unsupported_version or format.invalid", (version) => {
    const error = catchError(() => deserializeContext(mutated((d) => void (d.formatVersion = version))));
    expect(error).toBeInstanceOf(FormatError);
    expect(["format.unsupported_version", "format.invalid"]).toContain((error as FormatError).code);
  });

  it("formatVersion 1.5 → format.unsupported_version", () => {
    formatError(mutated((d) => void (d.formatVersion = 1.5)), "format.unsupported_version");
  });

  it("round-trips a document edited after creation", () => {
    const doc = editContext(portraitContext(), (d) => {
      d.meta = { owner: "me", nested: { a: [1, 2] } };
      d.revision = 7;
    });
    expect(deserializeContext(serializeContext(doc))).toEqual(doc);
  });
});
