import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/authoring";

describe("@briarflow/authoring smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/authoring");
  });
});
