import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "@briarflow/storage-sqlite";

describe("@briarflow/storage-sqlite smoke", () => {
  it("resolves the package entry through workspace paths", () => {
    expect(PACKAGE_NAME).toBe("@briarflow/storage-sqlite");
  });
});
