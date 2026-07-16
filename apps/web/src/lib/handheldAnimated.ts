/**
 * App-side view of the premade *animated* handheld skins.
 *
 * The pure model (`@cartbox/editor`) owns the catalogue and how each scene is
 * drawn; the asset-prep script bakes every preset into a sprite sheet under
 * `/handheld/animated/`. This module turns a preset into the `HandheldArt` the
 * console plays: it fetches the shipped sheet, inlines it as a `data:` URL (so
 * it satisfies the same art gate as editor-drawn art and needs no base-path or
 * cache-busting at render time), and derives the per-frame dimensions.
 */

import { HANDHELD_ANIMATED_PRESETS, type HandheldAnimatedPreset } from "@cartbox/editor";

import { handheldAssetUrl } from "./handheldAssets";
import type { HandheldArt } from "./handheldArt";

/** A premade animated skin as the picker shows it. */
export interface AnimatedPresetView {
  readonly id: string;
  readonly label: string;
  readonly frames: number;
  readonly durationMs: number;
  /** The card thumbnail (first frame). */
  readonly previewUrl: string;
  /** The full horizontal sprite sheet the console animates. */
  readonly sheetUrl: string;
}

/** The animated presets, ready to render as picker cards. */
export const ANIMATED_PRESETS: readonly AnimatedPresetView[] = HANDHELD_ANIMATED_PRESETS.map(
  (preset: HandheldAnimatedPreset) => ({
    id: preset.id,
    label: preset.label,
    frames: preset.frames,
    durationMs: preset.durationMs,
    previewUrl: handheldAssetUrl(`/handheld/animated/preview/${preset.id}.png`),
    sheetUrl: handheldAssetUrl(`/handheld/animated/${preset.id}.png`),
  }),
);

/** Load an image element from a URL (rejects if it fails to decode). */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

/**
 * Turn an animated preset into playable art: fetch its sprite sheet, re-encode
 * it as an inline PNG data URL, and split the sheet width by the frame count to
 * recover a single frame's dimensions. Throws if the sheet can't be loaded.
 */
export async function loadAnimatedArt(preset: AnimatedPresetView): Promise<HandheldArt> {
  const image = await loadImage(preset.sheetUrl);
  const frames = Math.max(1, preset.frames);
  const frameWidth = Math.round(image.naturalWidth / frames);
  const frameHeight = image.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, 0, 0);

  return {
    url: canvas.toDataURL("image/png"),
    w: frameWidth,
    h: frameHeight,
    frames,
    durationMs: preset.durationMs,
  };
}
