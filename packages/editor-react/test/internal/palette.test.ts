import { describe, expect, it } from "vitest";
import { freePosition } from "../../src/palette.js";

describe("freePosition", () => {
  it("keeps the desired spot when it is free (snapped to the grid)", () => {
    expect(freePosition([], { x: 10, y: 10 })).toEqual({ x: 12, y: 12 });
    expect(freePosition([{ x: 1000, y: 1000 }], { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("steps right past occupied spots, then down a row", () => {
    expect(freePosition([{ x: 0, y: 0 }], { x: 10, y: 10 })).toEqual({ x: 300, y: 12 });
    const row = Array.from({ length: 6 }, (_, i) => ({ x: i * 284, y: 0 }));
    expect(freePosition(row, { x: 0, y: 0 })).toEqual({ x: 0, y: 228 });
  });
});
