/**
 * Lit, material-mapped pixel-art backdrop.
 *
 * A decorative pixel-art panel wall rendered with the console's own lighting
 * model — 16-direction normals plus height, specular, roughness and emissive
 * channels — relit each frame by a single moving light. It gives the site chrome
 * dimensionality and texture ("lit pixels") without any WebGL: the scene is a
 * small low-resolution buffer the caller upscales with nearest-neighbour.
 *
 * The module is pure (no DOM). The shading math mirrors the engine's source of
 * truth — `packages/editor/src/model/normals.ts` (the 16 normal directions) and
 * `lighting.ts` (`shade` = Lambert diffuse + an ambient floor) — kept inline so
 * this stays unit-testable without loading the WASM-backed editor barrel, the
 * same reason `Working/normal-lit-demo/lighting-core.mjs` duplicates it.
 */

import {
  ARCADE,
  CARTRIDGE,
  COIN,
  CONSOLE,
  GAMEPAD,
  GHOST,
  HEART,
  INVADER,
  ROBOT,
  STAR,
  stampSprite,
  type Sprite,
} from "./retroSprites";

/** A pixel stores one of 16 normal-direction indices (mirror of normals.ts). */
export const NORMAL_DIRECTION_COUNT = 16;
const COMPASS_TILT = 0.55;

type Vec3 = readonly [number, number, number];

function normalize([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** The 16 unit normals: index 0 faces the camera, 1..8 are tilted compass dirs. */
export const NORMAL_VECTORS: readonly Vec3[] = (() => {
  const offsets: Array<[number, number]> = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  const directions: Vec3[] = [[0, 0, 1]];
  for (const [ox, oy] of offsets) {
    const x = ox * COMPASS_TILT;
    const y = oy * COMPASS_TILT;
    const z = Math.sqrt(Math.max(0.0001, 1 - x * x - y * y));
    directions.push(normalize([x, y, z]));
  }
  while (directions.length < NORMAL_DIRECTION_COUNT) directions.push([0, 0, 1]);
  return directions;
})();

/** The direction index whose stored normal is closest to `vec`. */
export function nearestDirection(vec: Vec3): number {
  const [tx, ty, tz] = normalize(vec);
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < NORMAL_VECTORS.length; i += 1) {
    const [nx, ny, nz] = NORMAL_VECTORS[i]!;
    const dot = nx * tx + ny * ty + nz * tz;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
}

/** RGB triple, each channel 0..255. */
export type Rgb = readonly [number, number, number];

/** A material-mapped pixel-art scene, all channels aligned to one w×h grid. */
export interface BackdropScene {
  readonly width: number;
  readonly height: number;
  readonly albedo: Uint8ClampedArray; // width*height*3
  readonly normalIdx: Uint8Array; // width*height
  readonly heightField: Float32Array; // 0..1
  readonly specular: Float32Array; // 0..1
  readonly roughness: Float32Array; // 0..1
  readonly emissive: Float32Array; // 0..1 strength
  readonly emissiveColor: Uint8ClampedArray; // width*height*3
}

/** Colours the generator paints the wall with. Dark by default so UI stays legible. */
export interface BackdropPalette {
  readonly panel: Rgb;
  readonly grout: Rgb;
  readonly rivet: Rgb;
  readonly neonA: Rgb; // horizontal conduits
  readonly neonB: Rgb; // vertical accent
}

export const DEFAULT_BACKDROP_PALETTE: BackdropPalette = {
  panel: [34, 42, 56],
  grout: [14, 18, 26],
  rivet: [150, 160, 176],
  neonA: [34, 210, 240],
  neonB: [255, 60, 140],
};

/** A point light in screen space; `z` is its height above the panel plane. */
export interface BackdropLight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Deterministic value hash so the same scene rebuilds identically. */
function hash(seed: number): number {
  const value = Math.sin(seed * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Build the panel-wall scene: beveled panels (normals from the height field),
 * recessed grout, polished corner rivets (specular), and glowing neon conduits
 * (emissive). `tile` sets the panel size in pixels.
 */
export function buildBackdropScene(
  width: number,
  height: number,
  palette: BackdropPalette = DEFAULT_BACKDROP_PALETTE,
  tile = 12,
): BackdropScene {
  const count = width * height;
  const albedo = new Uint8ClampedArray(count * 3);
  const normalIdx = new Uint8Array(count);
  const heightField = new Float32Array(count);
  const specular = new Float32Array(count);
  const roughness = new Float32Array(count);
  const emissive = new Float32Array(count);
  const emissiveColor = new Uint8ClampedArray(count * 3);

  const setAlbedo = (i: number, r: number, g: number, b: number) => {
    albedo[i * 3] = r;
    albedo[i * 3 + 1] = g;
    albedo[i * 3 + 2] = b;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const col = Math.floor(x / tile);
      const row = Math.floor(y / tile);
      const localX = x - col * tile;
      const localY = y - row * tile;
      const edge = Math.min(localX, tile - 1 - localX, localY, tile - 1 - localY);
      const variation = hash(col * 7 + row * 13);

      let r = palette.panel[0] + variation * 16;
      let g = palette.panel[1] + variation * 18;
      let b = palette.panel[2] + variation * 20;
      let h: number;
      let spec: number;
      let rough: number;

      if (edge <= 0) {
        // Recessed grout channel between panels.
        r = palette.grout[0];
        g = palette.grout[1];
        b = palette.grout[2];
        h = 0.05;
        spec = 0.08;
        rough = 0.9;
      } else {
        const bevel = Math.min(1, edge / 3);
        h = 0.28 + bevel * 0.5;
        spec = 0.22;
        rough = 0.72;
      }

      // Polished rivet near each panel's top-left corner.
      const rivetDist = Math.hypot(localX - 2.5, localY - 2.5);
      if (rivetDist < 1.7 && edge > 0) {
        const dome = 1 - rivetDist / 1.7;
        h = 0.85 + dome * 0.12;
        spec = 0.92;
        rough = 0.16;
        [r, g, b] = palette.rivet;
      }

      setAlbedo(i, r, g, b);
      heightField[i] = h;
      specular[i] = spec;
      roughness[i] = rough;
    }
  }

  // Neon conduits: two horizontal lines and one vertical accent strip. Each is
  // raised slightly and self-glowing.
  const stampEmissive = (i: number, [er, eg, eb]: Rgb) => {
    emissive[i] = 1;
    emissiveColor[i * 3] = er;
    emissiveColor[i * 3 + 1] = eg;
    emissiveColor[i * 3 + 2] = eb;
    setAlbedo(i, er, eg, eb);
    heightField[i] = Math.max(heightField[i]!, 0.6);
    specular[i] = 0.3;
    roughness[i] = 0.5;
  };
  const rowA = Math.floor(height * 0.22);
  const rowB = Math.floor(height * 0.78);
  for (let x = 0; x < width; x += 1) {
    stampEmissive(rowA * width + x, palette.neonA);
    stampEmissive(rowB * width + x, palette.neonA);
  }
  const colStrip = width - Math.max(6, Math.floor(width * 0.04));
  for (let y = 0; y < height; y += 1) stampEmissive(y * width + colStrip, palette.neonB);

  // Derive normals from the height field via the engine's nearest-direction
  // quantiser, so every bevel/rivet gets an authentic 16-direction normal.
  const at = (x: number, y: number) =>
    heightField[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]!;
  const slope = 2.6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      normalIdx[y * width + x] = nearestDirection([-dx * slope, -dy * slope, 1]);
    }
  }

  return { width, height, albedo, normalIdx, heightField, specular, roughness, emissive, emissiveColor };
}

/**
 * Recompute `normalIdx` from the scene's height field via the engine's
 * nearest-direction quantiser, so every raised sprite and bevel gets an
 * authentic 16-direction normal. Call after all geometry is painted.
 */
export function deriveSceneNormals(scene: BackdropScene): void {
  const { width, height, heightField, normalIdx } = scene;
  const at = (x: number, y: number) =>
    heightField[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))]!;
  const slope = 2.6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      normalIdx[y * width + x] = nearestDirection([-dx * slope, -dy * slope, 1]);
    }
  }
}

/** Colours for the retro-arcade backdrop's back wall and floor. */
export interface RetroWallPalette {
  readonly wallTop: Rgb;
  readonly wallBottom: Rgb;
  readonly floor: Rgb;
  readonly star: Rgb;
}

export const DEFAULT_RETRO_WALL: RetroWallPalette = {
  wallTop: [34, 38, 74],
  wallBottom: [58, 42, 88],
  floor: [40, 34, 58],
  star: [168, 184, 224],
};

/** One placed sprite: which art, where (top-left as 0..1 fractions), how big. */
interface SpritePlacement {
  readonly sprite: Sprite;
  readonly fx: number;
  readonly fy: number;
  readonly scale: number;
}

/**
 * The backdrop composition: a curated, deterministic arrangement of the retro
 * props across the wall. Positions are viewport fractions so the layout holds
 * at any buffer size; off-buffer pixels clip harmlessly. Tuned to frame a
 * roughly 260×160 buffer while leaving the centre calm for the picker on top.
 */
const RETRO_LAYOUT: readonly SpritePlacement[] = [
  { sprite: ARCADE, fx: 0.03, fy: 0.24, scale: 3 },
  { sprite: CONSOLE, fx: 0.68, fy: 0.7, scale: 2 },
  { sprite: GAMEPAD, fx: 0.38, fy: 0.72, scale: 2 },
  { sprite: CARTRIDGE, fx: 0.26, fy: 0.08, scale: 2 },
  { sprite: CARTRIDGE, fx: 0.86, fy: 0.12, scale: 2 },
  { sprite: INVADER, fx: 0.55, fy: 0.08, scale: 2 },
  { sprite: GHOST, fx: 0.74, fy: 0.32, scale: 2 },
  { sprite: ROBOT, fx: 0.14, fy: 0.66, scale: 2 },
  { sprite: COIN, fx: 0.47, fy: 0.4, scale: 2 },
  { sprite: HEART, fx: 0.9, fy: 0.46, scale: 2 },
  { sprite: STAR, fx: 0.34, fy: 0.5, scale: 2 },
  { sprite: STAR, fx: 0.62, fy: 0.56, scale: 1 },
  { sprite: STAR, fx: 0.2, fy: 0.34, scale: 1 },
  { sprite: STAR, fx: 0.94, fy: 0.72, scale: 1 },
];

/**
 * Build just the night-lit game-room back wall — a vertical gradient, faint CRT
 * scanlines, sparse pinpoint "stars", and a stage floor — with no props. This is
 * the backdrop the 3D voxel props are composited over; it still feeds the same
 * lighting model, so the orbiting light plays gently across it each frame.
 */
export function buildRetroWall(
  width: number,
  height: number,
  wall: RetroWallPalette = DEFAULT_RETRO_WALL,
): BackdropScene {
  const count = width * height;
  const scene: BackdropScene = {
    width,
    height,
    albedo: new Uint8ClampedArray(count * 3),
    normalIdx: new Uint8Array(count),
    heightField: new Float32Array(count),
    specular: new Float32Array(count),
    roughness: new Float32Array(count),
    emissive: new Float32Array(count),
    emissiveColor: new Uint8ClampedArray(count * 3),
  };
  const { albedo, heightField, specular, roughness, emissive, emissiveColor } = scene;

  const floorStart = Math.floor(height * 0.76);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;

  for (let y = 0; y < height; y += 1) {
    const gradient = y / Math.max(1, height - 1);
    const onFloor = y >= floorStart;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;

      let r: number;
      let g: number;
      let b: number;
      if (onFloor) {
        // Stage floor: recedes to a slightly darker foreground.
        const depth = (y - floorStart) / Math.max(1, height - floorStart);
        r = mix(wall.floor[0], wall.floor[0] * 0.72, depth);
        g = mix(wall.floor[1], wall.floor[1] * 0.72, depth);
        b = mix(wall.floor[2], wall.floor[2] * 0.72, depth);
      } else {
        r = mix(wall.wallTop[0], wall.wallBottom[0], gradient);
        g = mix(wall.wallTop[1], wall.wallBottom[1], gradient);
        b = mix(wall.wallTop[2], wall.wallBottom[2], gradient);
      }

      // Faint CRT scanline every third row keeps the flat wall alive without a
      // literal grid of blocks.
      if (y % 3 === 2) {
        r *= 0.9;
        g *= 0.9;
        b *= 0.9;
      }
      // Gentle per-pixel grain so the wall is never dead-flat.
      const grain = (hash(x * 3 + y * 11) - 0.5) * 8;

      albedo[i * 3] = r + grain;
      albedo[i * 3 + 1] = g + grain;
      albedo[i * 3 + 2] = b + grain;
      heightField[i] = 0.18;
      specular[i] = 0.06;
      roughness[i] = 0.9;

      // Sparse pinpoint stars on the upper wall (self-lit, so always visible).
      if (!onFloor && hash(x * 41.3 + y * 71.7) > 0.992) {
        emissive[i] = 0.8;
        emissiveColor[i * 3] = wall.star[0];
        emissiveColor[i * 3 + 1] = wall.star[1];
        emissiveColor[i * 3 + 2] = wall.star[2];
        heightField[i] = 0.3;
      }
    }
  }

  deriveSceneNormals(scene);
  return scene;
}

/**
 * Build the retro-arcade scene: {@link buildRetroWall} stamped with an
 * arrangement of the original pixel-art props as flat, material-lit reliefs.
 * This is the 2D relief form of the scene (the 3D voxel backdrop composites
 * rotating voxel models over the wall instead); kept for the material-lighting
 * tests and as a static fallback.
 */
export function buildRetroScene(
  width: number,
  height: number,
  wall: RetroWallPalette = DEFAULT_RETRO_WALL,
): BackdropScene {
  const scene = buildRetroWall(width, height, wall);

  for (const { sprite, fx, fy, scale } of RETRO_LAYOUT) {
    stampSprite(scene, sprite, Math.round(fx * width), Math.round(fy * height), scale);
  }

  deriveSceneNormals(scene);
  return scene;
}

/** How the light animates: an eased orbit clear of the corners. */
export function orbitLight(width: number, height: number, seconds: number): BackdropLight {
  return {
    x: width * 0.5 + Math.cos(seconds * 0.6) * width * 0.34,
    y: height * 0.5 + Math.sin(seconds * 0.8) * height * 0.3,
    z: 34,
  };
}

const HEIGHT_SCALE = 10;
const AMBIENT = 0.2;
const VIEW: Vec3 = [0, 0, 1];

/**
 * Relight the scene from one light: Lambert diffuse + ambient floor (the engine
 * `shade` formula), Blinn-Phong specular tightened by roughness, a short height
 * self-shadow, and self-emissive neon. Returns straight-alpha RGBA (w*h*4).
 * Pass `out` to reuse a buffer across frames.
 */
export function renderBackdropFrame(
  scene: BackdropScene,
  light: BackdropLight,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const { width, height, albedo, normalIdx, heightField, specular, roughness, emissive, emissiveColor } = scene;
  const buffer = out ?? new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const n = NORMAL_VECTORS[normalIdx[i]!]!;
      const ar = albedo[i * 3]!;
      const ag = albedo[i * 3 + 1]!;
      const ab = albedo[i * 3 + 2]!;

      let toLx = light.x - x;
      let toLy = light.y - y;
      let toLz = light.z - heightField[i]! * HEIGHT_SCALE;
      const len = Math.hypot(toLx, toLy, toLz) || 1;
      toLx /= len;
      toLy /= len;
      toLz /= len;

      const diffuse = Math.max(0, n[0] * toLx + n[1] * toLy + n[2] * toLz);

      // Short march toward the light; a taller neighbour casts a soft shadow.
      let shadow = 1;
      for (let step = 1; step <= 6; step += 1) {
        const sx = Math.round(x + toLx * step);
        const sy = Math.round(y + toLy * step);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) break;
        const rayHeight = heightField[i]! * HEIGHT_SCALE + toLz * step * HEIGHT_SCALE * 0.9;
        if (heightField[sy * width + sx]! * HEIGHT_SCALE > rayHeight + 0.6) {
          shadow = 0.35;
          break;
        }
      }

      const intensity = (AMBIENT + (1 - AMBIENT) * diffuse) * (shadow * 0.6 + 0.4);
      let outR = ar * intensity;
      let outG = ag * intensity;
      let outB = ab * intensity;

      if (specular[i]! > 0.02 && diffuse > 0) {
        let hx = toLx + VIEW[0];
        let hy = toLy + VIEW[1];
        let hz = toLz + VIEW[2];
        const hl = Math.hypot(hx, hy, hz) || 1;
        hx /= hl;
        hy /= hl;
        hz /= hl;
        const nh = Math.max(0, n[0] * hx + n[1] * hy + n[2] * hz);
        const shininess = 6 + (1 - roughness[i]!) * 114;
        const glint = Math.pow(nh, shininess) * specular[i]! * shadow * 255;
        outR += glint;
        outG += glint;
        outB += glint;
      }

      if (emissive[i]! > 0) {
        const e = emissive[i]!;
        outR = Math.max(outR, emissiveColor[i * 3]! * e);
        outG = Math.max(outG, emissiveColor[i * 3 + 1]! * e);
        outB = Math.max(outB, emissiveColor[i * 3 + 2]! * e);
      }

      const o = i * 4;
      buffer[o] = outR;
      buffer[o + 1] = outG;
      buffer[o + 2] = outB;
      buffer[o + 3] = 255;
    }
  }
  return buffer;
}
