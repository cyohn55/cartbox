/**
 * Pure edit operations for the Scene tab's parallax backdrop.
 *
 * The Scene tab lets an author declare a `SceneSpec` — depth layers pointing at
 * regions of the cart's own sprite sheet, plus aerial-perspective atmosphere and
 * camera scroll. This module owns every mutation as an immutable transform on the
 * spec, kept out of the React component so the authoring logic can be tested on
 * its own inputs and outputs. Values are clamped to the same ranges the runtime
 * parser enforces, so the live preview and the saved-then-reloaded scene agree.
 */

import type { SceneSpec, SceneLayer, SpriteRegion, AtmosphereParams } from "@cartbox/player";
import { DEFAULT_ATMOSPHERE } from "@cartbox/player";

/** The runtime caps a scene at 8 layers; the tab refuses to add beyond that. */
export const MAX_SCENE_LAYERS = 8;
const MAX_TILE = 255;
const MAX_TILES_PER_SIDE = 32;
const MAX_PARALLAX = 4;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const clampInt = (value: number, lo: number, hi: number): number => Math.round(clamp(value, lo, hi));

/** A new layer at the given depth, pointing at a small default sprite region. */
export function defaultSceneLayer(depth = 0.5): SceneLayer {
  return {
    source: { page: 0, tile: 0, tilesW: 4, tilesH: 4 },
    depth: clamp(depth, 0, 1),
    wrapX: true,
    offsetY: 0,
  };
}

/** The empty scene an author starts from before adding any layers. */
export function emptyScene(): SceneSpec {
  return {
    layers: [],
    atmosphere: { ...DEFAULT_ATMOSPHERE },
    camera: { autoScrollX: 0, autoScrollY: 0 },
    keyColor: 0,
  };
}

/**
 * Append a layer, creating the scene if there is none yet. Returns the scene
 * unchanged once the layer cap is reached. New layers are seeded at a depth just
 * behind the current farthest layer, so successive adds read front-to-back.
 */
export function withLayerAdded(scene: SceneSpec | null): SceneSpec {
  const base = scene ?? emptyScene();
  if (base.layers.length >= MAX_SCENE_LAYERS) return base;
  const farthest = base.layers.reduce((max, layer) => Math.max(max, layer.depth), 0);
  const depth = base.layers.length === 0 ? 0.2 : clamp(farthest + 0.2, 0, 1);
  return { ...base, layers: [...base.layers, defaultSceneLayer(depth)] };
}

/**
 * Remove the layer at `index`. Returns null when the last layer goes, so an
 * author who clears the backdrop stores no empty scene (the runtime parser also
 * treats a layer-less scene as none).
 */
export function withLayerRemoved(scene: SceneSpec, index: number): SceneSpec | null {
  const layers = scene.layers.filter((_, i) => i !== index);
  return layers.length === 0 ? null : { ...scene, layers };
}

/** Replace non-source fields of the layer at `index`, clamping to valid ranges. */
export function withLayerUpdated(scene: SceneSpec, index: number, patch: Partial<SceneLayer>): SceneSpec {
  return { ...scene, layers: scene.layers.map((layer, i) => (i === index ? clampLayer({ ...layer, ...patch }) : layer)) };
}

/** Replace fields of the sprite region backing the layer at `index`. */
export function withLayerSource(scene: SceneSpec, index: number, patch: Partial<SpriteRegion>): SceneSpec {
  return {
    ...scene,
    layers: scene.layers.map((layer, i) =>
      i === index ? clampLayer({ ...layer, source: { ...layer.source, ...patch } }) : layer,
    ),
  };
}

/** Move the layer at `index` one step toward the front (dir -1) or back (dir +1). */
export function withLayerMoved(scene: SceneSpec, index: number, dir: -1 | 1): SceneSpec {
  const target = index + dir;
  if (target < 0 || target >= scene.layers.length) return scene;
  const layers = [...scene.layers];
  const moved = layers[index]!;
  layers[index] = layers[target]!;
  layers[target] = moved;
  return { ...scene, layers };
}

/** Merge atmosphere changes, clamping density/desaturate/lift to 0..1 and RGB to 0..255. */
export function withAtmosphere(scene: SceneSpec, patch: Partial<AtmosphereParams>): SceneSpec {
  const merged = { ...scene.atmosphere, ...patch };
  const atmosphere: AtmosphereParams = {
    fog: [
      clampInt(merged.fog[0], 0, 255),
      clampInt(merged.fog[1], 0, 255),
      clampInt(merged.fog[2], 0, 255),
    ],
    density: clamp(merged.density, 0, 1),
    desaturate: clamp(merged.desaturate, 0, 1),
    lift: clamp(merged.lift, 0, 1),
  };
  return { ...scene, atmosphere };
}

/** Merge camera auto-scroll changes (px/frame). */
export function withCamera(scene: SceneSpec, patch: Partial<SceneSpec["camera"]>): SceneSpec {
  return { ...scene, camera: { ...scene.camera, ...patch } };
}

/** Set the chroma-key palette index the runtime shows the backdrop through. */
export function withKeyColor(scene: SceneSpec, keyColor: number): SceneSpec {
  return { ...scene, keyColor: clampInt(keyColor, 0, MAX_TILE) };
}

/** Clamp a layer's own fields to the ranges the runtime parser accepts. */
function clampLayer(layer: SceneLayer): SceneLayer {
  const clamped: SceneLayer = {
    source: {
      page: layer.source.page === 1 ? 1 : 0,
      tile: clampInt(layer.source.tile, 0, MAX_TILE),
      tilesW: clampInt(layer.source.tilesW, 1, MAX_TILES_PER_SIDE),
      tilesH: clampInt(layer.source.tilesH, 1, MAX_TILES_PER_SIDE),
    },
    depth: clamp(layer.depth, 0, 1),
    wrapX: layer.wrapX ?? true,
    offsetY: Math.round(layer.offsetY ?? 0),
  };
  if (layer.parallax !== undefined) clamped.parallax = clamp(layer.parallax, 0, MAX_PARALLAX);
  return clamped;
}
