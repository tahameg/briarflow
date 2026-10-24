/**
 * @briarflow/nodes-image — image processing nodes (pack `image`): Make image, Split channels,
 * Resize, Crop, Rotate / flip, Grayscale, Invert colors, Convert. Reads PNG and JPEG; writes
 * PNG (default) or JPEG. Pure JavaScript codecs, no native modules.
 *
 * @example
 * ```ts
 * const briar = createBriar({ packs: [imagePack] });
 * ```
 */
import { definePack, type NodePack } from "@briarflow/core";
import { imageConvert, imageCrop, imageGrayscale, imageInvert, imageMake, imageResize, imageSplit, imageTransform } from "./nodes.js";

export const PACKAGE_NAME = "@briarflow/nodes-image";

export { imageConvert, imageCrop, imageGrayscale, imageInvert, imageMake, imageResize, imageSplit, imageTransform, cropPixels, resample, transformPixels } from "./nodes.js";
export { blank, decodeImage, encodeImage, MAX_PIXELS, type OutputFormat, type Pixels } from "./pixels.js";

/** The `image` pack. */
export const imagePack: NodePack = definePack({
  name: "image",
  version: "0.1.0",
  title: "Image",
  description: "Make, split, resize, crop, rotate, grayscale, invert and convert images (PNG and JPEG).",
  nodes: [imageMake, imageSplit, imageResize, imageCrop, imageTransform, imageGrayscale, imageInvert, imageConvert],
});
