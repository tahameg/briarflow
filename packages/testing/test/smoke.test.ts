import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/testing";

describe("@briarflow/testing smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/testing");
  });
});
