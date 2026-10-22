import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "briarflow";

describe("briarflow smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("briarflow");
  });
});
