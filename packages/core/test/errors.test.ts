import { describe, expect, it } from "vitest";
import {
  BriarError,
  CatalogError,
  FlowIdConflictError,
  FormatError,
  InvalidCursorError,
  InvalidDocumentError,
  InvalidQueryError,
  MediaError,
  NodeDefinitionError,
  NodeError,
  NotImplementedError,
  PackDefinitionError,
  RevisionConflictError,
  StoreClosedError,
  StoreCorruptError,
  TypeDefinitionError,
  isBriarError,
  serializeError,
} from "@briarflow/core";

describe("BriarError", () => {
  it("carries a stable code, a human message and optional details", () => {
    const error = new BriarError("flow.not_found", "Flow missing.", { details: { flowId: "f1" } });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BriarError");
    expect(error.code).toBe("flow.not_found");
    expect(error.message).toBe("Flow missing.");
    expect(error.toJSON()).toEqual({ code: "flow.not_found", message: "Flow missing.", details: { flowId: "f1" } });
  });

  it("omits details from JSON when absent and keeps the cause", () => {
    const cause = new Error("disk full");
    const error = new BriarError("store.write_failed", "Could not save.", { cause });
    expect(error.toJSON()).toEqual({ code: "store.write_failed", message: "Could not save." });
    expect(error.cause).toBe(cause);
  });

  it("serializes a Briarflow cause recursively", () => {
    const inner = new NodeError("node.rate_limited", "Slow down.");
    const middle = new BriarError("run.node_failed", "Node failed.", { cause: inner });
    const outer = new BriarError("outer", "Outer.", { cause: middle });
    expect(outer.toJSON()).toEqual({
      code: "outer",
      message: "Outer.",
      cause: {
        code: "run.node_failed",
        message: "Node failed.",
        cause: { code: "node.rate_limited", message: "Slow down.", retryable: true },
      },
    });
  });

  it("never includes a stack in JSON", () => {
    const json = new BriarError("x.y", "m", { cause: new BriarError("a.b", "c") }).toJSON();
    expect(JSON.stringify(json)).not.toContain("stack");
    expect(Object.keys(json)).not.toContain("stack");
  });

  it("survives JSON.stringify", () => {
    const error = new BriarError("x.y", "message", { details: { a: 1 } });
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code: "x.y", message: "message", details: { a: 1 } });
  });
});

describe("NotImplementedError", () => {
  it("is a BriarError with code not_implemented", () => {
    const error = new NotImplementedError("validateFlow");
    expect(error).toBeInstanceOf(BriarError);
    expect(error.name).toBe("NotImplementedError");
    expect(error.code).toBe("not_implemented");
    expect(error.message).toContain("validateFlow");
    expect(isBriarError(error)).toBe(true);
    expect(isBriarError(new Error("plain"))).toBe(false);
  });
});

describe("error classes", () => {
  const cases: [string, BriarError, string][] = [
    ["TypeDefinitionError", new TypeDefinitionError("type.invalid_constraint", "bad"), "type.invalid_constraint"],
    ["NodeDefinitionError", new NodeDefinitionError("bad node"), "node_def.invalid"],
    ["PackDefinitionError", new PackDefinitionError("bad pack"), "pack.invalid"],
    ["CatalogError", new CatalogError("catalog.duplicate_pack", "dup"), "catalog.duplicate_pack"],
    ["FormatError", new FormatError("format.invalid", "bad", { details: { path: "id" } }), "format.invalid"],
    ["NodeError", new NodeError("node.failed", "failed"), "node.failed"],
    ["RevisionConflictError", new RevisionConflictError({ id: "ctx_1", expected: 1, actual: 2 }), "store.revision_conflict"],
    ["FlowIdConflictError", new FlowIdConflictError({ flowId: "flow_1", contextId: "ctx_2" }), "store.flow_id_conflict"],
    ["StoreCorruptError", new StoreCorruptError({ id: "ctx_1" }), "store.corrupt"],
    ["InvalidCursorError", new InvalidCursorError(), "store.invalid_cursor"],
    ["InvalidQueryError", new InvalidQueryError("limit must be >= 1"), "store.invalid_query"],
    ["InvalidDocumentError", new InvalidDocumentError("not a context"), "store.invalid_document"],
    ["StoreClosedError", new StoreClosedError("context"), "store.closed"],
    ["MediaError", new MediaError("media.not_found", "missing"), "media.not_found"],
  ];

  it.each(cases)("%s is a BriarError with its code and class name", (name, error, code) => {
    expect(error).toBeInstanceOf(BriarError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(isBriarError(error)).toBe(true);
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("RevisionConflictError has details { id, expected, actual } and names the context", () => {
    const error = new RevisionConflictError({ id: "ctx_1", name: "Marketing", expected: 3, actual: 5 });
    expect(error.details).toEqual({ id: "ctx_1", expected: 3, actual: 5 });
    expect(error.message).toBe('Context "Marketing" was changed by someone else (revision 5, you had 3). Reload and try again.');
  });

  it("RevisionConflictError falls back to the id in the message", () => {
    expect(new RevisionConflictError({ id: "ctx_1", expected: 0, actual: 2 }).message).toContain('"ctx_1"');
  });

  it("FlowIdConflictError has details { flowId, contextId }", () => {
    const error = new FlowIdConflictError({ flowId: "flow_1", contextId: "ctx_2" });
    expect(error.details).toEqual({ flowId: "flow_1", contextId: "ctx_2" });
    expect(error.message).toContain("flow_1");
    expect(error.message).toContain("ctx_2");
  });

  it("StoreCorruptError has details { id }", () => {
    expect(new StoreCorruptError({ id: "ctx_9" }).details).toEqual({ id: "ctx_9" });
  });

  it("InvalidCursorError accepts a custom message", () => {
    expect(new InvalidCursorError("nope").message).toBe("nope");
  });
});

describe("NodeError.retryable", () => {
  it.each(["node.rate_limited", "node.unavailable", "node.timeout"])("defaults to true for %s", (code) => {
    expect(new NodeError(code, "m").retryable).toBe(true);
  });

  it.each(["node.failed", "node.invalid_input", "node.cancelled", "node.missing_secret", "node.invalid_output", "acme.request_failed"])(
    "defaults to false for %s",
    (code) => {
      expect(new NodeError(code, "m").retryable).toBe(false);
    },
  );

  it("explicit option wins", () => {
    expect(new NodeError("node.rate_limited", "m", { retryable: false }).retryable).toBe(false);
    expect(new NodeError("acme.request_failed", "m", { retryable: true }).retryable).toBe(true);
  });

  it("toJSON includes retryable and details", () => {
    const error = new NodeError("node.rate_limited", "Slow down.", { details: { retryAfterMs: 2000 } });
    expect(error.toJSON()).toEqual({ code: "node.rate_limited", message: "Slow down.", details: { retryAfterMs: 2000 }, retryable: true });
  });
});

describe("serializeError", () => {
  it("maps a plain Error to internal", () => {
    expect(serializeError(new Error("x"))).toEqual({ code: "internal", message: "x" });
  });

  it("maps non-errors to internal", () => {
    expect(serializeError("boom")).toEqual({ code: "internal", message: "boom" });
    expect(serializeError(42).code).toBe("internal");
  });

  it("keeps Briarflow errors (code, details, cause)", () => {
    const error = new BriarError("a.b", "m", { details: { x: 1 }, cause: new BriarError("c.d", "n") });
    expect(serializeError(error)).toEqual({ code: "a.b", message: "m", details: { x: 1 }, cause: { code: "c.d", message: "n" } });
  });

  it("drops plain causes", () => {
    expect(serializeError(new BriarError("a.b", "m", { cause: new Error("secret") }))).toEqual({ code: "a.b", message: "m" });
  });

  it("duck-types errors from another package copy", () => {
    const foreign = Object.assign(new Error("foreign"), { code: "x.foreign", details: { a: 1 } });
    expect(isBriarError(foreign)).toBe(true);
    expect(serializeError(foreign)).toEqual({ code: "x.foreign", message: "foreign", details: { a: 1 } });
  });

  it("never contains a stack key", () => {
    for (const value of [new Error("x"), new BriarError("a.b", "m"), new NodeError("node.failed", "m")]) {
      expect(JSON.stringify(serializeError(value))).not.toContain("stack");
    }
  });
});
