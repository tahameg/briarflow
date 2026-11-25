/**
 * types.md §12: members of a type and the Get member / Set member nodes.
 */
import { describe, expect, it } from "vitest";
import { builtinType, createMedia, createMemoryMediaRegistry, mediaValue, memberAt, memberPaths, readMember, typeMembers, writeMember, type TypeDecl } from "@briarflow/core";
import { memberGet, memberSet } from "@briarflow/nodes-std";
import { context, field, ir, runNode, struct } from "@briarflow/testing";

const portrait = struct("ty_portrait", "Portrait", [field("image", ir.image()), field("caption", ir.optional(ir.string()))]);
const character = struct("ty_char", "Character", [field("name", ir.string()), field("age", ir.int(), { default: 30 }), field("portrait", ir.named("ty_portrait")), field("friend", ir.optional(ir.named("ty_char")))]);
const decls = new Map<string, TypeDecl>([portrait, character].map((d) => [d.id, d]));
const resolve = (id: string) => decls.get(id) ?? builtinType(id);
const ctx = () => context({ types: [portrait, character] });
const media = createMedia({ registry: createMemoryMediaRegistry() });
const cat = await media.registry.add({ mime: "image/png", source: { kind: "link", url: "https://x.test/cat.PNG" }, bytes: 2048, meta: { width: 640, height: 480, filename: "cat.PNG" } });
const img = mediaValue("image", { mediaId: cat.id }, { mime: "image/png", bytes: 2048, meta: { width: 640, height: 480, filename: "cat.PNG" } });
const aria = { name: "Aria", portrait: { image: img, caption: null }, friend: null };

describe("typeMembers", () => {
  it("lists a media struct's fields (writable) and its limits (static, read-only)", () => {
    const m = typeMembers(ir.image(), resolve);
    expect(m.map((x) => [x.name, x.writable])).toEqual([
      ["data", true],
      ["mime", true],
      ["name", true],
      ["size", true],
      ["width", true],
      ["height", true],
      ["formats", false],
      ["maxBytes", false],
      ["minWidth", false],
      ["maxWidth", false],
      ["minHeight", false],
      ["maxHeight", false],
    ]);
    expect(typeMembers(ir.video(), resolve).map((x) => x.name)).toContain("fps");
    expect(typeMembers(ir.string(), resolve).map((x) => x.name)).toEqual(["length"]);
    expect(typeMembers(ir.text(), resolve).map((x) => x.name)).toEqual(["value", "minLength", "maxLength", "pattern", "multiline"]);
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
    expect(opt.find((x) => x.name === "name")).toMatchObject({ type: ir.optional(ir.string()), writable: false });
  });

  it("follows paths and lists nested members without entering a struct twice", () => {
    expect(memberAt(ir.named("ty_char"), ["portrait", "image", "width"], resolve)).toMatchObject({ type: ir.optional(ir.int()), writable: true });
    expect(memberAt(ir.named("ty_char"), ["portrait", "image", "maxWidth"], resolve)).toMatchObject({ type: ir.optional(ir.int()), writable: false });
    expect(memberAt(ir.named("ty_char"), ["portrait", "caption"], resolve)).toMatchObject({ writable: true });
    expect(memberAt(ir.named("ty_char"), ["nope"], resolve)).toMatchObject({ error: expect.stringContaining("Members: name, age, portrait, friend") });
    const paths = memberPaths(ir.named("ty_char"), resolve).map((p) => p.path.join("."));
    expect(paths).toContain("portrait.image.width");
    expect(paths).toContain("friend");
    expect(paths.some((p) => p.startsWith("friend."))).toBe(false);
    expect(paths.some((p) => p.endsWith("length.length"))).toBe(false);
  });

  it("reads media fields from the value, static fields from the type, and writes struct fields", () => {
    expect(readMember(img, ir.image(), ["width"], resolve)).toBe(640);
    expect(readMember(img, ir.image(), ["data", "mediaId"], resolve)).toBeNull();
    expect(readMember(img, ir.image(), ["data"], resolve)).toEqual({ mediaId: cat.id });
    expect(readMember(img, ir.image(), ["formats"], resolve)).toEqual([]);
    expect(readMember({ value: "hi" }, ir.text(), ["value", "length"], resolve)).toBe(2);
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
    const r = await runNode(memberGet, { value: aria }, { config: { type: ir.named("ty_char"), path: "portrait.image.width" }, context: ctx(), media });
    expect(r.ports.outputs.map((p) => [p.name, p.title])).toEqual([["width", "width"]]);
    expect(r.outputs).toEqual({ width: 640 });
    const m = await runNode(memberGet, { value: img }, { config: { type: ir.image(), path: "name" }, media });
    expect(m.outputs).toEqual({ name: "cat.PNG" });
  });

  it("set: replaces a struct field, rejects read-only members", async () => {
    const r = await runNode(memberSet, { value: aria, to: "Bea" }, { config: { type: ir.named("ty_char"), path: "name" }, context: ctx() });
    expect(r.outputs["value"]).toMatchObject({ name: "Bea", portrait: aria.portrait });
    await expect(runNode(memberSet, { value: img, to: 1 }, { config: { type: ir.image(), path: "maxWidth" } })).rejects.toThrow(/read-only/);
    await expect(runNode(memberGet, { value: img }, { config: { type: ir.image(), path: "depth" } })).rejects.toThrow(/not a member/);
  });
});
