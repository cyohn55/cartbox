/**
 * Gap #3 part 2 — the cart-facing `scene` model.
 *
 * A cart declares a parallax scene the way it declares fx / rig / materials:
 * a JSON sidecar validated on load. Each layer points at a region of the cart's
 * OWN sprite sheet (authored in the editor), sits at a depth, and the runtime
 * composites the layers with parallax scroll + aerial-perspective atmosphere
 * (see parallaxScene.ts) BEHIND the cart's interactive foreground. This is what
 * turns "hand-roll parallax + fake haze in Lua" into "author art, declare depth".
 *
 * This module is the pure, DOM-free data + validation half (mirrors the defensive
 * parse style of apps/web/src/lib/rig.ts): parse untrusted JSON into a safe
 * SceneSpec, dropping anything malformed rather than throwing. The rendering half
 * is sceneRender.ts. Intended app homes: apps/web/src/lib/scene.ts (parse) +
 * packages/player/src/scene/ (render).
 */

import type { AtmosphereParams, Rgb } from "./parallaxScene.js";

/** A region of the sprite sheet backing one parallax layer. */
export interface SpriteRegion {
  /** Sprite page: 0 (fg) or 1 (bg). */
  page: 0 | 1;
  /** Top-left tile index of the region within the page. */
  tile: number;
  /** Region size in tiles. */
  tilesW: number;
  tilesH: number;
}

/** One declared parallax layer. */
export interface SceneLayer {
  source: SpriteRegion;
  /** 0 (nearest) .. 1 (horizon) — drives parallax factor + atmosphere. */
  depth: number;
  /** Optional explicit parallax factor (else derived from depth). */
  parallax?: number;
  /** Tile horizontally as the camera scrolls. Default true. */
  wrapX?: boolean;
  /** Vertical placement in the backdrop, in pixels. Default 0. */
  offsetY?: number;
}

/** How the scene camera moves each frame. */
export interface SceneCamera {
  /** Auto-scroll in px/frame (a living backdrop with no cart input). Default 0. */
  autoScrollX?: number;
  autoScrollY?: number;
}

/** A full declared scene. */
export interface SceneSpec {
  layers: SceneLayer[];
  atmosphere: AtmosphereParams;
  camera: SceneCamera;
  /**
   * The palette index the cart leaves as "background": the runtime shows the
   * parallax backdrop through every pixel the cart drew in this colour, and keeps
   * the rest as the cart's own foreground. Default 0 (TIC-80's conventional
   * background colour).
   */
  keyColor: number;
}

const MAX_LAYERS = 8;
const MAX_TILE = 255;
const MAX_TILES_PER_SIDE = 32;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampInt = (v: number, lo: number, hi: number) => Math.round(clamp(v, lo, hi));

/** Parse an 0..255 RGB triplet, defaulting per channel. */
function parseRgb(raw: unknown, fallback: Rgb): Rgb {
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  return [
    clampInt(num(raw[0], fallback[0]), 0, 255),
    clampInt(num(raw[1], fallback[1]), 0, 255),
    clampInt(num(raw[2], fallback[2]), 0, 255),
  ];
}

/** The default atmosphere — a cool dusk haze, if a cart omits it. */
export const DEFAULT_ATMOSPHERE: AtmosphereParams = {
  fog: [96, 116, 168],
  density: 0.85,
  desaturate: 0.7,
  lift: 0.4,
};

function parseRegion(raw: unknown): SpriteRegion | null {
  if (!isObject(raw)) return null;
  const page = raw.page === 1 ? 1 : 0;
  const tile = clampInt(num(raw.tile, -1), 0, MAX_TILE);
  const tilesW = clampInt(num(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE);
  const tilesH = clampInt(num(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE);
  if (!Number.isInteger(tile) || num(raw.tile, -1) < 0) return null;
  return { page, tile, tilesW, tilesH };
}

function parseLayer(raw: unknown): SceneLayer | null {
  if (!isObject(raw)) return null;
  const source = parseRegion(raw.source);
  if (!source) return null; // a layer with no valid art is dropped, not defaulted
  const layer: SceneLayer = {
    source,
    depth: clamp(num(raw.depth, 0.5), 0, 1),
    wrapX: raw.wrapX === undefined ? true : Boolean(raw.wrapX),
    offsetY: Math.round(num(raw.offsetY, 0)),
  };
  if (typeof raw.parallax === "number" && Number.isFinite(raw.parallax)) {
    layer.parallax = clamp(raw.parallax, 0, 4);
  }
  return layer;
}

/**
 * Parse untrusted sidecar JSON into a SceneSpec, or null when there is no usable
 * scene (no object, or every layer malformed). Layers are validated individually
 * and bad ones dropped — losing one layer beats refusing the whole backdrop.
 */
export function parseScene(raw: unknown): SceneSpec | null {
  if (!isObject(raw)) return null;
  const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
  const layers: SceneLayer[] = [];
  for (const entry of layersRaw) {
    if (layers.length >= MAX_LAYERS) break;
    const layer = parseLayer(entry);
    if (layer) layers.push(layer);
  }
  if (layers.length === 0) return null;

  const atmoRaw = isObject(raw.atmosphere) ? raw.atmosphere : {};
  const atmosphere: AtmosphereParams = {
    fog: parseRgb(atmoRaw.fog, DEFAULT_ATMOSPHERE.fog),
    density: clamp(num(atmoRaw.density, DEFAULT_ATMOSPHERE.density), 0, 1),
    desaturate: clamp(num(atmoRaw.desaturate, DEFAULT_ATMOSPHERE.desaturate), 0, 1),
    lift: clamp(num(atmoRaw.lift, DEFAULT_ATMOSPHERE.lift), 0, 1),
  };

  const camRaw = isObject(raw.camera) ? raw.camera : {};
  const camera: SceneCamera = {
    autoScrollX: num(camRaw.autoScrollX, 0),
    autoScrollY: num(camRaw.autoScrollY, 0),
  };

  const keyColor = clampInt(num(raw.keyColor, 0), 0, MAX_TILE);

  return { layers, atmosphere, camera, keyColor };
}
