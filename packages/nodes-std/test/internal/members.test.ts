/**
 * types.md §12: members of a type and the Get member / Set member nodes.
 */
import { describe, expect, it } from "vitest";
import { memberAt, memberPaths, readMember, typeMembers, writeMember, type TypeDecl } from "@briarflow/core";
import { memberGet, memberSet } from "@briarflow/nodes-std";
import { context, field, ir, runNode, struct } from "@briarflow/testing";

const portrait = struct("ty_portrait", "Portrait", [field("image", ir.image()), field("caption", ir.optional(ir.text()))]);
const character = struct("ty_char", "Character", [field("name", ir.text()), field("age", ir.int(), { default: 30 }), field("portrait", ir.named("ty_portrait")), field("friend", ir.optional(ir.named("ty_char")))]);
const decls = new Map<string, TypeDecl>([portrait, character].map((d) => [d.id, d]));
const resolve = (id: string) => decls.get(id);
const ctx = () => context({ types: [portrait, character] });
const img = { uri: "briar-media://m_1", mime: "image/png", bytes: 2048, meta: { width: 640, height: 480, filename: "cat.PNG" } };
const aria = { name: "Aria", portrait: { image: img, caption: null }, friend: null };

describe("typeMembers", () => {
  it("lists media properties (read-only)", () => {
    const m = typeMembers(ir.image(), resolve);
    expect(m.map((x) => x.name)).toEqual(["url", "mime", "extension", "name", "size", "width", "height"]);
    expect(m.every((x) => !x.writable)).toBe(true);
    expect(typeMembers(ir.video(), resolve).map((x) => x.name)).toContain("fps");
    expect(typeMembers(ir.text(), resolve).map((x) => x.name)).toEqual(["length"]);
    expect(typeMembers(ir.int(), resolve)).toEqual([]);
  });

  it("lists struct fields (writable); optional values give optional, read-only members", () => {
    expect(typeMembers(ir.named("ty_char"), resolve).map((x) => [x.name, x.writable])).toEqual([
      ["name", true],
      ["age", true],
      ["portrait", true],
      ["friend", true],
    ]);
    const opt = typeMembers(ir.optional(ir.named("ty_char")), resolve);
    expect(opt.find((x) => x.name === "name")).toMatchObject({ type: ir.optional(ir.text()), writable: false });
  });

  it("follows paths and lists nested members without entering a struct twice", () => {
    expect(memberAt(ir.named("ty_char"), ["portrait", "image", "width"], resolve)).toMatchObject({ type: ir.optional(ir.int()), writable: false });
    expect(memberAt(ir.named("ty_char"), ["portrait", "caption"], resolve)).toMatchObject({ writable: true });
    expect(memberAt(ir.named("ty_char"), ["nope"], resolve)).toMatchObject({ error: expect.stringContaining("Members: name, age, portrait, friend") });
    const paths = memberPaths(ir.named("ty_char"), resolve).map((p) => p.path.join("."));
    expect(paths).toContain("portrait.image.width");
    expect(paths).toContain("friend");
    expect(paths.some((p) => p.startsWith("friend."))).toBe(false);
    expect(paths.some((p) => p.endsWith("length.length"))).toBe(false);
  });

  it("reads and writes values", () => {
    expect(readMember(img, ir.image(), ["extension"], resolve)).toBe("png");
    expect(readMember({ uri: "briar-media://m_2", mime: "image/jpeg" }, ir.image(), ["extension"], resolve)).toBe("jpeg");
    expect(readMember(img, ir.image(), ["width"], resolve)).toBe(640);
    expect(readMember({ uri: "u", mime: "image/png" }, ir.image(), ["width"], resolve)).toBeNull();
    expect(readMember(aria, ir.named("ty_char"), ["portrait", "image", "size"], resolve)).toBe(2048);
    expect(readMember(aria, ir.named("ty_char"), ["age"], resolve)).toBe(30);
    expect(readMember(aria, ir.named("ty_char"), ["friend", "name"], resolve)).toBeNull();
    const next = writeMember(aria, ir.named("ty_char"), ["portrait", "caption"], "Hi", resolve) as typeof aria;
    expect(next.portrait.caption).toBe("Hi");
    expect(aria.portrait.caption).toBeNull();
    expect(next.portrait.image).toBe(img);
  });
});

describe("Get member / Set member", () => {
  it("get: ports follow the member, run reads it", async () => {
    const r = await runNode(memberGet, { value: aria }, { config: { type: ir.named("ty_char"), path: "portrait.image.width" }, context: ctx() });
    expect(r.ports.outputs.map((p) => [p.name, p.title])).toEqual([["width", "Width"]]);
    expect(r.outputs).toEqual({ width: 640 });
    const m = await runNode(memberGet, { value: img }, { config: { type: ir.image(), path: "url" } });
    expect(m.outputs).toEqual({ url: "briar-media://m_1" });
  });

  it("set: replaces a struct field, rejects read-only members", async () => {
    const r = await runNode(memberSet, { value: aria, to: "Bea" }, { config: { type: ir.named("ty_char"), path: "name" }, context: ctx() });
    expect(r.outputs["value"]).toMatchObject({ name: "Bea", portrait: aria.portrait });
    await expect(runNode(memberSet, { value: img, to: 1 }, { config: { type: ir.image(), path: "width" } })).rejects.toThrow(/read-only/);
    await expect(runNode(memberGet, { value: img }, { config: { type: ir.image(), path: "depth" } })).rejects.toThrow(/not a member/);
  });
});
