import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/nodes-std";

describe("@briarflow/nodes-std smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/nodes-std");
  });
});
