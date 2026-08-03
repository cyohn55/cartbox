/**
 * Pre-haze equivalence + speed-shape tests (cinematic gap #3, item 4).
 *
 * A parallax layer's aerial haze depends only on its depth and the scene's
 * (constant) atmosphere, so the runtime bakes it into the layer's pixels once
 * (prehazeLayers) and skips it in the per-frame composite. This is a pure
 * optimization: the composited image must be identical to computing the haze per
 * pixel per frame. These tests pin that equivalence — exactly for the binary-alpha
 * layers the region source actually produces, and within a rounding step for
 * partial alpha — and that a pre-hazed layer is flagged so compositing skips haze.
 */

import { describe, expect, it } from "vitest";
import {
  composeParallax,
  fillSky,
  prehazeLayers,
  renderSceneBackdrop,
  type AtmosphereParams,
  type ParallaxLayer,
} from "@cartbox/player";

const W = 48;
const H = 24;
const ATMO: AtmosphereParams = { fog: [92, 116, 168], density: 0.85, desaturate: 0.7, lift: 0.45 };

/** A layer of coloured content; `binaryAlpha` toggles pixels fully on/off vs a ramp. */
function contentLayer(depth: number, binaryAlpha: boolean): ParallaxLayer {
  const pixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    const b = i * 4;
    pixels[b] = (i * 37) % 256;
    pixels[b + 1] = (i * 91) % 256;
    pixels[b + 2] = (i * 13) % 256;
    pixels[b + 3] = binaryAlpha ? (i % 3 === 0 ? 0 : 255) : (i * 5) % 256;
  }
  return { pixels, width: W, height: H, depth, wrapX: true, offsetY: 0 };
}

/** The per-frame haze path (baseline): sky + composite with haze applied live. */
function renderBaseline(layers: ParallaxLayer[], frame: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  const spec = { layers: [], atmosphere: ATMO, camera: { autoScrollX: 0.5, autoScrollY: 0 }, keyColor: 0 };
  renderSceneBackdrop(out, W, H, layers, spec, frame);
  return out;
}

/** The optimized path: bake haze + sky once, then composite pre-hazed layers. */
function renderPrehazed(layers: ParallaxLayer[], frame: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  fillSky(out, W, H, ATMO);
  composeParallax(out, W, H, prehazeLayers(layers, ATMO), { x: frame * 0.5, y: 0 }, ATMO);
  return out;
}

function maxChannelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

describe("prehazeLayers equivalence", () => {
  it("flags baked layers so compositing skips the per-pixel haze", () => {
    const hazed = prehazeLayers([contentLayer(0.8, true)], ATMO);
    expect(hazed[0]!.hazed).toBe(true);
  });

  it("matches the per-frame haze exactly for binary-alpha layers (the real case)", () => {
    // The editor region source emits alpha 0 or 255 only, so baking is exact.
    const layers = [contentLayer(0.9, true), contentLayer(0.4, true), contentLayer(0, true)];
    for (const frame of [0, 30, 120]) {
      expect(maxChannelDiff(renderBaseline(layers, frame), renderPrehazed(layers, frame))).toBe(0);
    }
  });

  it("stays within one rounding step for partial-alpha layers", () => {
    // Baking rounds the hazed colour before the alpha blend rather than after, so
    // partial-alpha edges can differ by at most 1 per channel — imperceptible.
    const layers = [contentLayer(0.7, false), contentLayer(0.2, false)];
    expect(maxChannelDiff(renderBaseline(layers, 45), renderPrehazed(layers, 45))).toBeLessThanOrEqual(1);
  });

  it("does not mutate the caller's layer pixels", () => {
    const layer = contentLayer(0.9, true);
    const before = layer.pixels.slice();
    prehazeLayers([layer], ATMO);
    expect(Array.from(layer.pixels)).toEqual(Array.from(before));
  });
});
