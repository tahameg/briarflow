import { describe, expect, it } from "vitest";
import { jsonErrorLocation } from "../../src/values.js";

describe("jsonErrorLocation", () => {
  it("is undefined for valid JSON", () => {
    expect(jsonErrorLocation('{ "a": [1, -2.5e3, true, null, "x\\"y"] }')).toBeUndefined();
  });

  it("points at the first bad character", () => {
    expect(jsonErrorLocation('{\n  "name": "",\n  "oops": \n}')).toBe("line 4, column 1");
    expect(jsonErrorLocation("{ name: 1 }")).toBe("line 1, column 3");
    expect(jsonErrorLocation("[1, 2,]")).toBe("line 1, column 7");
    expect(jsonErrorLocation('{"a": 1} x')).toBe("line 1, column 10");
    expect(jsonErrorLocation('{"a": tru}')).toBe("line 1, column 7");
  });
});
