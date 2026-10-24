import { describe, expect, it } from "vitest";
import { readMedia, type MediaRef, type MediaStore } from "@briarflow/core";
import { describeNodePack, memoryMediaStore, runNode } from "@briarflow/testing";
import { blank, decodeImage, encodeImage, imageCrop, imageMake, imagePack, imageResize, imageSplit, imageTransform, resample, type Pixels } from "../../src/index.js";

/** A 4×2 image: left half red, right half half-transparent blue. */
function sample(): Pixels {
  const p = blank(4, 2);
  for (let i = 0; i < 8; i++) p.data.set(i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 128], i * 4);
  return p;
}

async function put(media: MediaStore, p: Pixels, format: "png" | "jpeg" = "png"): Promise<MediaRef> {
  const { bytes, mime } = encodeImage(p, format);
  return media.put(bytes, { mime, meta: { width: p.width, height: p.height } });
}

const pixelsOf = async (media: MediaStore, ref: unknown) => decodeImage(await readMedia(ref as MediaRef, { media }));
const at = (p: Pixels, x: number, y: number) => [...p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];

const media = memoryMediaStore();
const ref = await put(media, sample());

describeNodePack(imagePack, {
  requireSamples: true,
  samples: {
    "image.make": [{ variant: "color", inputs: { width: 2, height: 3, red: 9 }, check: (r) => expect(r.outputs["image"]).toMatchObject({ mime: "image/png", meta: { width: 2, height: 3 } }) }],
    "image.split": [{ media, inputs: { image: ref }, check: (r) => expect(Object.keys(r.outputs)).toEqual(["red", "green", "blue", "alpha"]) }],
    "image.resize": [{ media, inputs: { image: ref, width: 2 }, check: (r) => expect(r.outputs["image"]).toMatchObject({ meta: { width: 2, height: 1 } }) }],
    "image.crop": [{ media, inputs: { image: ref, x: 1, width: 2, height: 1 }, check: (r) => expect(r.outputs["image"]).toMatchObject({ meta: { width: 2, height: 1 } }) }],
    "image.transform": [{ media, inputs: { image: ref }, check: (r) => expect(r.outputs["image"]).toMatchObject({ meta: { width: 2, height: 4 } }) }],
    "image.grayscale": [{ media, inputs: { image: ref } }],
    "image.invert": [{ media, inputs: { image: ref } }],
    "image.convert": [{ media, inputs: { image: ref }, config: { format: "jpeg" }, check: (r) => expect(r.outputs["image"]).toMatchObject({ mime: "image/jpeg" }) }],
  },
});

describe("image nodes", () => {
  it("split channels and make image round-trip the pixels", async () => {
    const parts = await runNode(imageSplit, { image: ref }, { media });
    expect(at(await pixelsOf(media, parts.outputs["alpha"]), 3, 0)).toEqual([128, 128, 128, 255]);
    const made = await runNode(imageMake, parts.outputs, { media, variant: "rgba" });
    const back = await pixelsOf(media, made.outputs["image"]);
    expect(at(back, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(back, 3, 1)).toEqual([0, 0, 255, 128]);
    const rgb = await runNode(imageMake, { red: parts.outputs["red"], green: parts.outputs["green"], blue: parts.outputs["blue"] }, { media, variant: "rgb" });
    expect(at(await pixelsOf(media, rgb.outputs["image"]), 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it("make image rejects channels of different sizes", async () => {
    const small = await put(media, blank(1, 1));
    await expect(runNode(imageMake, { red: ref, green: ref, blue: small }, { media, variant: "rgb" })).rejects.toMatchObject({ code: "image.size_mismatch" });
  });

  it("resize keeps the aspect ratio, fits or covers, and averages when shrinking", async () => {
    const box = async (w: number | null, h: number | null, fit: string) => (await runNode(imageResize, { image: ref, width: w, height: h }, { media, config: { fit } })).outputs["image"];
    expect(await box(null, 4, "contain")).toMatchObject({ meta: { width: 8, height: 4 } });
    expect(await box(8, 8, "contain")).toMatchObject({ meta: { width: 8, height: 4 } });
    expect(await box(2, 2, "cover")).toMatchObject({ meta: { width: 2, height: 2 } });
    expect(await box(3, 3, "stretch")).toMatchObject({ meta: { width: 3, height: 3 } });
    await expect(box(null, null, "contain")).rejects.toMatchObject({ code: "image.invalid_size" });
    const half = resample(sample(), 2, 1);
    expect(at(half, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(half, 1, 0)).toEqual([0, 0, 255, 128]);
  });

  it("crops, rotates and flips", async () => {
    const crop = await runNode(imageCrop, { image: ref, x: 1, y: 1, width: 2, height: 1 }, { media });
    expect(at(await pixelsOf(media, crop.outputs["image"]), 1, 0)).toEqual([0, 0, 255, 128]);
    await expect(runNode(imageCrop, { image: ref, x: 3, width: 2, height: 1 }, { media })).rejects.toMatchObject({ code: "image.invalid_size" });
    const rot = await pixelsOf(media, (await runNode(imageTransform, { image: ref }, { media, config: { op: "rotate90" } })).outputs["image"]);
    expect([rot.width, rot.height]).toEqual([2, 4]);
    expect(at(rot, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(rot, 0, 3)).toEqual([0, 0, 255, 128]);
    const flip = await pixelsOf(media, (await runNode(imageTransform, { image: ref }, { media, config: { op: "flipHorizontal" } })).outputs["image"]);
    expect(at(flip, 0, 0)).toEqual([0, 0, 255, 128]);
  });

  it("reads JPEG, refuses other formats", async () => {
    const jpg = await put(media, blank(2, 2), "jpeg");
    const r = await runNode(imageResize, { image: jpg, width: 4 }, { media });
    expect(r.outputs["image"]).toMatchObject({ meta: { width: 4, height: 4 } });
    const webp = await media.put(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]), { mime: "image/webp" });
    await expect(runNode(imageResize, { image: webp, width: 4 }, { media })).rejects.toMatchObject({ code: "image.unsupported_format" });
  });
});
