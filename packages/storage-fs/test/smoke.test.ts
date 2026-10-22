import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/storage-fs";

describe("@briarflow/storage-fs smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/storage-fs");
  });
});
