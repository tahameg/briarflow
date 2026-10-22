import { describe, expect, it } from "vitest";
import type { Command } from "@briarflow/authoring";
import { emptyDoc, richDoc } from "./fixtures/docs.js";
import { accept, chars, msg, reject } from "./fixtures/helpers.js";

describe("context.rename", () => {
  it("renames the context; creates nothing; inverse restores the old name", () => {
    const r = accept(richDoc(), [{ op: "context.rename", name: "Studio" }]);
    expect(r.doc.name).toBe("Studio");
    expect(r.created).toEqual([{}]);
    expect(r.changed).toBe(true);
    expect(r.inverse).toEqual([{ op: "context.rename", name: "Rich", restore: true }]);
  });

  it("accepts 120 characters and unicode", () => {
    expect(accept(emptyDoc(), [{ op: "context.rename", name: chars(120) }]).doc.name).toBe(chars(120));
    expect(accept(emptyDoc(), [{ op: "context.rename", name: "Ünïcødé ✨ 文脈" }]).doc.name).toBe("Ünïcødé ✨ 文脈");
  });

  it("renaming to the same name is a no-op", () => {
    const r = accept(richDoc(), [{ op: "context.rename", name: "Rich" }]);
    expect(r.changed).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["121 characters", chars(121)],
  ])("rejects a %s name with command.invalid_payload", (_label, name) => {
    reject(emptyDoc(), [{ op: "context.rename", name }], "command.invalid_payload", { message: /^Command context\.rename: name .+\.$/ });
  });

  it("rejects a non-string, missing name and unknown fields", () => {
    reject(emptyDoc(), [{ op: "context.rename", name: 5 } as unknown as Command], "command.invalid_payload", {
      message: msg.invalidPayload("context.rename", "name"),
    });
    reject(emptyDoc(), [{ op: "context.rename" } as unknown as Command], "command.invalid_payload", {
      message: msg.invalidPayload("context.rename", "name"),
    });
    reject(emptyDoc(), [{ op: "context.rename", name: "X", color: "red" } as unknown as Command], "command.invalid_payload", {
      message: /^Command context\.rename: .*color.* .+\.$/,
    });
  });
});

describe("context.setDescription", () => {
  it("sets a description", () => {
    const r = accept(emptyDoc(), [{ op: "context.setDescription", description: "About" }]);
    expect(r.doc.description).toBe("About");
    expect(r.created).toEqual([{}]);
  });

  it("null clears the description (key removed)", () => {
    const doc = accept(emptyDoc(), [{ op: "context.setDescription", description: "About" }]).doc;
    const r = accept(doc, [{ op: "context.setDescription", description: null }]);
    expect(r.doc.description).toBeUndefined();
    expect(Object.keys(r.doc)).not.toContain("description");
  });

  it("clearing a missing description is a no-op", () => {
    expect(accept(emptyDoc(), [{ op: "context.setDescription", description: null }]).changed).toBe(false);
  });

  it("accepts 2000 characters and rejects 2001", () => {
    accept(emptyDoc(), [{ op: "context.setDescription", description: chars(2000) }]);
    reject(emptyDoc(), [{ op: "context.setDescription", description: chars(2001) }], "command.invalid_payload", {
      message: msg.invalidPayload("context.setDescription", "description"),
    });
  });

  it("rejects a non-string description and a missing one", () => {
    reject(emptyDoc(), [{ op: "context.setDescription", description: 3 } as unknown as Command], "command.invalid_payload", {
      message: msg.invalidPayload("context.setDescription", "description"),
    });
    reject(emptyDoc(), [{ op: "context.setDescription" } as unknown as Command], "command.invalid_payload");
  });
});
