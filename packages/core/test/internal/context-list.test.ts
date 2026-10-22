import { describe, expect, it } from "vitest";
import {
  buildContextPage,
  compareContextOrder,
  isAfterCursor,
  matchesContextSearch,
  normalizeListQuery,
  normalizeMime,
  type ContextListEntry,
} from "@briarflow/core";

const entry = (id: string, updatedAt: string, extra: Partial<ContextListEntry> = {}): ContextListEntry => ({
  id,
  name: id,
  revision: 1,
  updatedAt,
  flows: [],
  ...extra,
});

describe("context list helpers", () => {
  it("normalizes queries", () => {
    expect(normalizeListQuery(undefined)).toEqual({ limit: 50, search: "", needle: "", after: undefined });
    expect(normalizeListQuery({ limit: 500, search: "  Mark " })).toMatchObject({ limit: 200, search: "Mark", needle: "mark" });
    for (const limit of [0, 1.5, Number.NaN]) {
      expect(() => normalizeListQuery({ limit })).toThrow(expect.objectContaining({ code: "store.invalid_query" }));
    }
    expect(() => normalizeListQuery({ cursor: "!!" })).toThrow(expect.objectContaining({ code: "store.invalid_cursor" }));
  });

  it("matches name, description and flow names case-insensitively", () => {
    const e = entry("ctx_a", "2026-01-01T00:00:00.000Z", { name: "Ads", description: "Spring CAMPAIGN", flows: [{ id: "flow_x", name: "Portrait" }] });
    expect(matchesContextSearch(e, "")).toBe(true);
    expect(matchesContextSearch(e, "campaign")).toBe(true);
    expect(matchesContextSearch(e, "portr")).toBe(true);
    expect(matchesContextSearch(e, "nope")).toBe(false);
  });

  it("orders, positions and pages with a cursor that round-trips", () => {
    const all = [
      entry("ctx_b", "2026-01-01T00:00:00.000Z"),
      entry("ctx_a", "2026-01-01T00:00:00.000Z"),
      entry("ctx_c", "2026-02-01T00:00:00.000Z", { description: "hidden" }),
    ].sort(compareContextOrder);
    expect(all.map((e) => e.id)).toEqual(["ctx_c", "ctx_a", "ctx_b"]);

    const q1 = normalizeListQuery({ limit: 2 });
    const page1 = buildContextPage(all, q1);
    expect(page1.items.map((e) => e.id)).toEqual(["ctx_c", "ctx_a"]);
    expect(page1.items[0]).not.toHaveProperty("description");
    expect(page1.nextCursor).toBeDefined();

    const q2 = normalizeListQuery({ limit: 2, cursor: page1.nextCursor as string });
    const page2 = buildContextPage(all.filter((e) => isAfterCursor(e, q2.after)), q2);
    expect(page2.items.map((e) => e.id)).toEqual(["ctx_b"]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it("rejects a cursor from another search", () => {
    const page = buildContextPage([entry("ctx_a", "x"), entry("ctx_b", "x")], normalizeListQuery({ limit: 1, search: "a" }));
    expect(() => normalizeListQuery({ cursor: page.nextCursor as string, search: "b" })).toThrow(
      expect.objectContaining({ code: "store.invalid_cursor" }),
    );
  });
});

describe("normalizeMime", () => {
  it("strips parameters and lowercases", () => {
    expect(normalizeMime("Image/PNG; q=1")).toBe("image/png");
  });
  it("throws media.invalid_mime", () => {
    for (const bad of [undefined, "", "png", 42]) {
      expect(() => normalizeMime(bad)).toThrow(expect.objectContaining({ code: "media.invalid_mime" }));
    }
  });
});
