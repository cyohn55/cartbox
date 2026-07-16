/**
 * App-side view of the *animated* handheld skins.
 *
 * The pure model (`@cartbox/editor`) owns the catalogue and how each arcade
 * scene is drawn on the chassis marquee. Unlike the plain premades, an animation
 * is NOT welded to a fixed colour scheme: this module renders the chosen scene
 * live from whatever chassis `scheme` the player has, so the animation always
 * matches their colours and can ride on any handheld. Recolouring the chassis
 * re-renders the animation in the new colours.
 *
 * The card thumbnails still come from the baked preview PNGs (a cheap, static
 * representative look); only the selected animation is rendered live.
 */

import {
  HANDHELD_ANIMATED_PRESETS,
  renderAnimatedFrames,
  type HandheldAnimatedPreset,
  type HandheldGameId,
  type HandheldScheme,
  type HandheldTemplate,
} from "@cartbox/editor";

import { handheldAssetUrl } from "./handheldAssets";
import type { HandheldArt } from "./handheldArt";

/** A selectable animation as the picker shows it. */
export interface AnimatedPresetView {
  readonly id: string;
  readonly label: string;
  /** Which arcade scene plays on the marquee. */
  readonly game: HandheldGameId;
  readonly frames: number;
  readonly durationMs: number;
  /** The card thumbnail (a baked representative frame). */
  readonly previewUrl: string;
}

/** The animations, ready to render as picker cards. */
export const ANIMATED_PRESETS: readonly AnimatedPresetView[] = HANDHELD_ANIMATED_PRESETS.map(
  (preset: HandheldAnimatedPreset) => ({
    id: preset.id,
    label: preset.label,
    game: preset.game,
    frames: preset.frames,
    durationMs: preset.durationMs,
    previewUrl: handheldAssetUrl(`/handheld/animated/preview/${preset.id}.png`),
  }),
);

/** Look up an animation view by its preset id. */
export function animatedPresetView(id: string): AnimatedPresetView | undefined {
  return ANIMATED_PRESETS.find((view) => view.id === id);
}

/**
 * The shipped animated sheets bake frames ~360px wide; live frames are rendered
 * at the full template resolution and downscaled to match, so the produced data
 * URL stays within the art gate (and localStorage) budget.
 */
const TARGET_FRAME_WIDTH = 360;

/**
 * Render an animation live in the player's chassis colours: draw every frame of
 * the scene onto the recoloured skin, downscale, and assemble a horizontal
 * sprite sheet the console plays back. Returns the `HandheldArt` (a data URL
 * sheet with per-frame dims), or throws if a canvas is unavailable.
 */
export function renderAnimatedArt(
  template: HandheldTemplate,
  scheme: HandheldScheme,
  view: AnimatedPresetView,
): HandheldArt {
  const preset: HandheldAnimatedPreset = {
    id: view.id,
    label: view.label,
    game: view.game,
    scheme,
    frames: view.frames,
    durationMs: view.durationMs,
  };
  const frames = renderAnimatedFrames(template, preset);

  const scale = Math.min(1, TARGET_FRAME_WIDTH / template.width);
  const frameWidth = Math.max(1, Math.round(template.width * scale));
  const frameHeight = Math.max(1, Math.round(template.height * scale));

  const source = document.createElement("canvas");
  source.width = template.width;
  source.height = template.height;
  const sourceContext = source.getContext("2d");

  const sheet = document.createElement("canvas");
  sheet.width = frameWidth * frames.length;
  sheet.height = frameHeight;
  const sheetContext = sheet.getContext("2d");
  if (!sourceContext || !sheetContext) throw new Error("Canvas is unavailable.");

  sheetContext.imageSmoothingEnabled = true;
  frames.forEach((rgba, index) => {
    sourceContext.putImageData(new ImageData(new Uint8ClampedArray(rgba), template.width, template.height), 0, 0);
    sheetContext.drawImage(source, 0, 0, template.width, template.height, index * frameWidth, 0, frameWidth, frameHeight);
  });

  return {
    url: sheet.toDataURL("image/png"),
    w: frameWidth,
    h: frameHeight,
    frames: frames.length,
    durationMs: view.durationMs,
  };
}
