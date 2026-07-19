/**
 * Browser loader for the handheld skin template. Fetches the shipped chrome
 * (`base.png`) and region mask (`mask.png`, region id packed in the red channel)
 * and assembles the `HandheldTemplate` the pure `renderHandheld` model consumes,
 * so the selection screen can recolour a handheld live on a canvas.
 *
 * DOM-only (uses Image + canvas); call from client components after mount.
 */

import type { HandheldTemplate } from "@cartbox/editor";

import { handheldAssetUrl } from "@/lib/handheldAssets";

// Plain-string fetches carry the base path (so they resolve under the GitHub
// Pages /cartbox path) plus a revision query so a re-extracted skin isn't masked
// by a cached copy of these stable filenames.
const BASE_URL = handheldAssetUrl("/handheld/base.png");
const MASK_URL = handheldAssetUrl("/handheld/mask.png");

// The crisp @2x chrome (see scripts/bake-handheld-hires.mjs). The console shows a
// single chassis at up to ~1290 physical pixels on a phone, so downscaling this
// 1734-wide art reads sharp where upscaling the 867-wide 1x art reads soft. Same
// aspect ratio and region ids, so it is a drop-in higher-resolution template.
const BASE_HIRES_URL = handheldAssetUrl("/handheld/base@2x.png");
const MASK_HIRES_URL = handheldAssetUrl("/handheld/mask@2x.png");

/** Decode an image URL to its raw RGBA pixels via an offscreen canvas. */
function loadImageData(url: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Canvas 2D context unavailable."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

/** Assemble a template from an already-decoded base + mask pair. */
function toTemplate(base: ImageData, mask: ImageData): HandheldTemplate {
  const regionMask = new Uint8Array(mask.width * mask.height);
  for (let pixel = 0; pixel < regionMask.length; pixel += 1) {
    regionMask[pixel] = mask.data[pixel * 4] ?? 0; // region id lives in the red channel
  }
  return { width: base.width, height: base.height, base: base.data, regionMask };
}

/** Load the shared handheld template (chrome + per-pixel region mask). */
export async function loadHandheldTemplate(): Promise<HandheldTemplate> {
  const [base, mask] = await Promise.all([loadImageData(BASE_URL), loadImageData(MASK_URL)]);
  return toTemplate(base, mask);
}

/**
 * Load the crisp @2x chassis template for the console, falling back to the 1x
 * template if the higher-resolution asset is unavailable (e.g. an older build
 * that predates the bake). Reserved for the console's single chassis render —
 * the onboarding picker keeps the 1x template because it recolours many devices
 * live per turn and the @2x buffer is four times the pixels.
 */
export async function loadHandheldTemplateHiRes(): Promise<HandheldTemplate> {
  try {
    const [base, mask] = await Promise.all([loadImageData(BASE_HIRES_URL), loadImageData(MASK_HIRES_URL)]);
    return toTemplate(base, mask);
  } catch {
    return loadHandheldTemplate();
  }
}
