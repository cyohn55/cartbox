/**
 * Browser loader for the handheld skin template. Fetches the shipped chrome
 * (`base.png`) and region mask (`mask.png`, region id packed in the red channel)
 * and assembles the `HandheldTemplate` the pure `renderHandheld` model consumes,
 * so the selection screen can recolour a handheld live on a canvas.
 *
 * DOM-only (uses Image + canvas); call from client components after mount.
 */

import type { HandheldTemplate } from "@cartbox/editor";

import { withBasePath } from "@/lib/staticSite";

// Plain-string fetches must carry the base path so they resolve under a GitHub
// Pages project path (/cartbox) as well as at the domain root.
const BASE_URL = withBasePath("/handheld/base.png");
const MASK_URL = withBasePath("/handheld/mask.png");

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

/** Load the shared handheld template (chrome + per-pixel region mask). */
export async function loadHandheldTemplate(): Promise<HandheldTemplate> {
  const [base, mask] = await Promise.all([loadImageData(BASE_URL), loadImageData(MASK_URL)]);
  const regionMask = new Uint8Array(mask.width * mask.height);
  for (let pixel = 0; pixel < regionMask.length; pixel += 1) {
    regionMask[pixel] = mask.data[pixel * 4] ?? 0; // region id lives in the red channel
  }
  return { width: base.width, height: base.height, base: base.data, regionMask };
}
