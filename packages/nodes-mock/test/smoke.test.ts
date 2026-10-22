import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/nodes-mock";

describe("@briarflow/nodes-mock smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/nodes-mock");
  });
});
