/**
 * What has actually been painted on a sprite's non-albedo layers.
 *
 * A block of pixels carries seven parallel planes — colour, plus normal,
 * height, specular, roughness and emissive — but the canvas shows one at a time,
 * and the palette shows the values of whichever one is active. So the work you
 * did on the other six is invisible: nothing in the editor said which pixels
 * carry a normal, which colours stamp a material profile, or even which of the
 * seven layers this sprite uses at all. The only way to find out was to click
 * through every layer and look.
 *
 * These functions answer those questions from the same {@link PaintSurface} the
 * canvas paints through, which is what makes them correct for multi-tile blocks
 * too: the block wrapper is a surface, so "the open block" is whatever surface
 * it is handed.
 *
 * Pure reads — no React, no canvas, no mutation — so what the badges and the
 * overlay claim can be asserted directly against a sprite sheet.
 */

import type { SpritePage } from "@cartbox/editor";

import type { PaintSurface } from "./paintSurface";

/**
 * A layer that can be probed, and the value that means "nothing painted here".
 *
 * Every non-albedo plane in the cart uses 0 for empty — a normal of 0 is flat
 * (facing the camera) and a material ramp of 0 is the bottom of the ramp — so
 * `empty` defaults to 0 and callers rarely set it. It stays a parameter because
 * "unpainted" is a property of the layer, not of this module, and a future
 * channel with a different resting value should not need this file rewritten.
 */
export interface CoverageChannel<Id extends string> {
  readonly id: Id;
  readonly surface: PaintSurface;
  readonly empty?: number;
}

/** What a block carries, per channel and per pixel. */
export interface Coverage<Id extends string> {
  /** Channels with at least one painted pixel, in the order they were probed. */
  readonly channels: readonly Id[];
  /** How many pixels each probed channel covers. Zero for untouched channels. */
  readonly counts: Readonly<Record<Id, number>>;
  /** Pixels ({@link pixelKey}) carrying data on at least one probed channel. */
  readonly pixels: ReadonlySet<number>;
}

/** A pixel's position packed into one number, row-major within the block. */
export function pixelKey(x: number, y: number, size: number): number {
  return y * size + x;
}

/**
 * Measure what a block carries across a set of channels.
 *
 * One pass over the block per channel rather than one pass with an inner loop
 * over channels: a block is at most 32×32 and the channel count is fixed, so
 * either is cheap, and this way each channel's count falls out without a second
 * traversal.
 */
export function measureCoverage<Id extends string>(
  channels: readonly CoverageChannel<Id>[],
  page: SpritePage,
  tile: number,
  size: number,
): Coverage<Id> {
  const counts = {} as Record<Id, number>;
  const painted: Id[] = [];
  const pixels = new Set<number>();

  for (const channel of channels) {
    const empty = channel.empty ?? 0;
    let count = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (channel.surface.getPixel(page, tile, x, y) === empty) continue;
        count += 1;
        pixels.add(pixelKey(x, y, size));
      }
    }
    counts[channel.id] = count;
    if (count > 0) painted.push(channel.id);
  }

  return { channels: painted, counts, pixels };
}

/**
 * Every channel's value at one pixel.
 *
 * The readout behind "what is applied to *this* pixel" — the question the HUD
 * could never answer, since it only ever showed the layer you were on.
 */
export function sampleChannels<Id extends string>(
  channels: readonly CoverageChannel<Id>[],
  page: SpritePage,
  tile: number,
  x: number,
  y: number,
): Readonly<Record<Id, number>> {
  const sample = {} as Record<Id, number>;
  for (const channel of channels) sample[channel.id] = channel.surface.getPixel(page, tile, x, y);
  return sample;
}

/**
 * How many pixels of the block use each value of a surface.
 *
 * For the albedo layer this is palette usage, which is what lets the palette
 * hide the colours a sprite does not contain. Returned as a Map keyed by value
 * rather than an array indexed by it, because the caller wants "is this used?"
 * and "how often?", not a dense vector it has to size correctly.
 */
export function valueUsage(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  size: number,
): ReadonlyMap<number, number> {
  const usage = new Map<number, number>();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = surface.getPixel(page, tile, x, y);
      usage.set(value, (usage.get(value) ?? 0) + 1);
    }
  }
  return usage;
}
