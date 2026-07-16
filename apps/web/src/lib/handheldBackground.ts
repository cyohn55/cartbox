/**
 * App-side helper for the "upload an image as the chassis background" option.
 *
 * The pure model (`@cartbox/editor`) knows how to composite a background image
 * into the chassis (`face`) region; this module bridges the browser to it:
 * it decodes an uploaded file into straight-alpha RGBA pixels, and renders the
 * recoloured skin-with-background to a PNG data URL the rest of the picker and
 * the console already know how to display (as static custom art).
 */

import {
  renderHandheldWithBackground,
  type HandheldBackground,
  type HandheldScheme,
  type HandheldTemplate,
} from "@cartbox/editor";

import type { HandheldArt } from "./handheldArt";

/**
 * Cap the decoded background so a large photo does not bloat memory: the chassis
 * sampling is nearest-neighbour, so more than this on the long edge buys nothing
 * visible while costing a much larger buffer.
 */
const MAX_BACKGROUND_EDGE = 640;

/** Reject files that are not images up front, with a clear message. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Decode an uploaded image file into straight-alpha RGBA pixels, downscaled so
 * its long edge is at most `MAX_BACKGROUND_EDGE`. Rejects if the file is not an
 * image or the browser cannot decode it.
 */
export async function readImageBackground(file: File): Promise<HandheldBackground> {
  if (!isImageFile(file)) throw new Error("Please choose an image file.");

  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) throw new Error("That image is empty.");

    const scale = Math.min(1, MAX_BACKGROUND_EDGE / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return { width, height, data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Load an <img> from a URL, resolving once it has decoded. */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read that image."));
    image.src = url;
  });
}

/**
 * Render the recoloured skin with the uploaded image showing through the chassis
 * to a PNG data URL. Returns a single-frame `HandheldArt`, so it flows through
 * the same save/console path as a hand-drawn skin.
 */
export function renderBackgroundArt(
  template: HandheldTemplate,
  scheme: HandheldScheme,
  background: HandheldBackground,
): HandheldArt {
  const rgba = renderHandheldWithBackground(template, scheme, background);
  const canvas = document.createElement("canvas");
  canvas.width = template.width;
  canvas.height = template.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), template.width, template.height), 0, 0);
  return { url: canvas.toDataURL("image/png"), w: template.width, h: template.height };
}
