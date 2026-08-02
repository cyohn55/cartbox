/**
 * Gap #3 part 2 — rendering a declared scene.
 *
 * Turns a {@link SceneSpec} (sceneModel.ts) into a composited parallax backdrop:
 * each layer's sprite-sheet region is read to RGBA through a {@link
 * SpriteRegionSource}, becomes a {@link ParallaxLayer}, and the whole set is
 * composited with parallax scroll + aerial-perspective atmosphere by
 * composeParallax. The camera is driven by the scene's auto-scroll plus an
 * optional cart-supplied offset (so gameplay can pan the world).
 *
 * Pure and DOM-free: the sprite source is a tiny interface the real engine (or a
 * test) satisfies, so this is unit-testable without a WASM core or a canvas.
 * Intended app home: packages/player/src/scene/.
 */

import {
  composeParallax,
  type AtmosphereParams,
  type ParallaxCamera,
  type ParallaxLayer,
} from "./parallaxScene.js";
import type { SceneSpec } from "./sceneModel.js";

/** An RGBA image read out of the cart's sprite sheet. */
export interface RegionImage {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Reads a rectangular tile region of the cart's sprite sheet as straight-alpha RGBA. */
export interface SpriteRegionSource {
  readRegion(page: 0 | 1, tile: number, tilesW: number, tilesH: number): RegionImage;
}

/**
 * Resolve a scene's layers to renderable {@link ParallaxLayer}s by reading each
 * region's pixels once. Call this when the scene or the cart's art changes, not
 * every frame — the images are static; only the camera moves.
 */
export function resolveSceneLayers(spec: SceneSpec, source: SpriteRegionSource): ParallaxLayer[] {
  return spec.layers.map((layer) => {
    const image = source.readRegion(layer.source.page, layer.source.tile, layer.source.tilesW, layer.source.tilesH);
    const resolved: ParallaxLayer = {
      pixels: image.pixels,
      width: image.width,
      height: image.height,
      depth: layer.depth,
      wrapX: layer.wrapX,
      offsetY: layer.offsetY,
    };
    if (layer.parallax !== undefined) resolved.parallax = layer.parallax;
    return resolved;
  });
}

/**
 * The camera for a given presented frame: the scene's constant auto-scroll plus
 * an optional cart-supplied base offset (e.g. the player's world position, which
 * a cart can publish for the backdrop to follow).
 */
export function cameraAt(spec: SceneSpec, frame: number, base: ParallaxCamera = { x: 0, y: 0 }): ParallaxCamera {
  return {
    x: base.x + (spec.camera.autoScrollX ?? 0) * frame,
    y: base.y + (spec.camera.autoScrollY ?? 0) * frame,
  };
}

/**
 * Fill `out` with a vertical sky gradient (dark zenith → the atmosphere's fog
 * colour at the horizon), so distant layers hazing toward fog meet a matching
 * sky. Convenience for the common case; a cart can paint its own sky instead.
 */
export function fillSky(out: Uint8ClampedArray, width: number, height: number, atmosphere: AtmosphereParams, horizonY = height): void {
  const zenith: [number, number, number] = [
    Math.round(atmosphere.fog[0] * 0.16),
    Math.round(atmosphere.fog[1] * 0.16),
    Math.round(atmosphere.fog[2] * 0.22),
  ];
  for (let y = 0; y < height; y += 1) {
    const t = Math.min(1, horizonY > 0 ? y / horizonY : 1);
    const r = Math.round(zenith[0] + (atmosphere.fog[0] - zenith[0]) * t);
    const g = Math.round(zenith[1] + (atmosphere.fog[1] - zenith[1]) * t);
    const b = Math.round(zenith[2] + (atmosphere.fog[2] - zenith[2]) * t);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
}

/**
 * Render the full backdrop for one frame into `out`: sky, then the parallax
 * layers with atmosphere at the frame's camera. `layers` come from
 * {@link resolveSceneLayers} (resolved once and reused).
 */
export function renderSceneBackdrop(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  layers: readonly ParallaxLayer[],
  spec: SceneSpec,
  frame: number,
  base?: ParallaxCamera,
): void {
  fillSky(out, width, height, spec.atmosphere);
  composeParallax(out, width, height, layers, cameraAt(spec, frame, base), spec.atmosphere);
}
