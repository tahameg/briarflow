import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/runtime";

describe("@briarflow/runtime smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/runtime");
  });
});
