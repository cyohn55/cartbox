/**
 * The "Xbox 360 foundry" starter — a cart built to read as the Xbox 360 era.
 *
 * The 360 tier has no fixed-function ceiling to reproduce (see ERA_MODELS.md and
 * models.ts: its whole point is the absence of era limits), so this scene cannot
 * demonstrate an *artefact* the way the PS1 one does. What it demonstrates
 * instead is the era's *art direction*, which is just as recognisable:
 *
 * - **Desaturated, gritty realism.** The infamous 360-era "brown and grey": a
 *   concrete-and-steel industrial space, scuffed and rusted, under a hazy sky.
 *   One high-detail 128x128 grunge texture (four times the PS1/N64 page), drawn
 *   sharp because the tier had the fill rate and cache for it — the runtime does
 *   not downsample it (make-xbox360-texture.mjs).
 * - **Geometric density.** Where the PS1 scene is a handful of crates, this is a
 *   foundry: a slab floor, scattered cargo, crossed girders, a stepped reactor
 *   tower and steel drums. The unbounded poly budget is the point, so the scene
 *   spends it.
 * - **HD framing.** The 2D frame is authored at 1280x720 with a bloom-ish banded
 *   sky, and the caption sits at HD coordinates.
 *
 * The geometry is hard-edged (flat-faced boxes and girders) with steel drums for
 * relief — the blocky, high-contrast readability the generation's shooters favoured.
 */

import type { CartEngine } from "../engine/CartEngine";
import {
  serializeMeshAsset,
  type MeshAsset,
  type MeshPrimitive,
} from "./MeshAsset";
import {
  assetsSidecarForTexture,
  bakeIndexedTextureImage,
  indexedTextureSpriteRef,
  paintIndexedTexture,
  type IndexedTexture,
} from "./eraTexture";
import {
  newStreams,
  pushBox,
  pushCylinder,
  pushGround,
  toPrimitive,
} from "./seedGeometry";

/**
 * The foundry's scuffed-concrete / bolted-steel / rust texture, as palette-indexed
 * pixels so it is an editable cart asset — the named "360 grunge" block a creator
 * edits in the Assets tab; the foundry is rebaked from it. 128x128, high contrast
 * and full detail (the tier has no small cache to blur it). The pattern is the
 * TypeScript twin of `scripts/make-xbox360-texture.mjs`.
 */
const GRUNGE_SIZE = 128;
/** The sprite page the grunge occupies — a full page 0, front-and-centre in Assets. */
const GRUNGE_PAGE = 0 as const;
const GRUNGE_SURFACES: ReadonlyArray<readonly [number, number, number]> = [
  [128, 126, 120], // concrete
  [58, 57, 54], // grout / recess
  [96, 92, 86], // steel
  [120, 78, 48], // rust
];
const GRUNGE_GRAIN_STEPS = 8;

function grungeHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function grungeSmoothNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = grungeHash(xi, yi);
  const b = grungeHash(xi + 1, yi);
  const c = grungeHash(xi, yi + 1);
  const d = grungeHash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Fractal noise: several octaves, for grime with detail at every scale. */
function grungeFbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o += 1) {
    sum += grungeSmoothNoise(x * freq, y * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

function grungeSurface(x: number, y: number): number {
  const gx = x % 64;
  const gy = y % 64;
  // A 64px panel grid with a 3px recessed grout line.
  if (gx < 3 || gy < 3) return 1;
  // Bolt heads in each panel's corners.
  const rx = Math.min(gx, 64 - gx);
  const ry = Math.min(gy, 64 - gy);
  if (rx > 5 && rx < 11 && ry > 5 && ry < 11) return 2;
  // Rust blooming out of the grout and around the bolts.
  const grime = grungeFbm(x / 18, y / 18);
  if ((gx < 8 || gy < 8 || (rx < 15 && ry < 15)) && grime > 0.55) return 3;
  // Streaks of exposed steel where the concrete has spalled away.
  if (grime > 0.72) return 2;
  return 0;
}

function buildGrungeTexture(): IndexedTexture {
  const clut: [number, number, number][] = [];
  for (const [r, g, b] of GRUNGE_SURFACES) {
    for (let step = 0; step < GRUNGE_GRAIN_STEPS; step += 1) {
      const shift = (step - (GRUNGE_GRAIN_STEPS - 1) / 2) * 8;
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + shift)));
      clut.push([clamp(r), clamp(g), clamp(b)]);
    }
  }
  const indices = new Uint8Array(GRUNGE_SIZE * GRUNGE_SIZE);
  for (let y = 0; y < GRUNGE_SIZE; y += 1) {
    for (let x = 0; x < GRUNGE_SIZE; x += 1) {
      const grain = Math.floor(grungeFbm(x / 2.2, y / 2.2) * GRUNGE_GRAIN_STEPS * 1.4);
      indices[y * GRUNGE_SIZE + x] =
        grungeSurface(x, y) * GRUNGE_GRAIN_STEPS + Math.max(0, Math.min(GRUNGE_GRAIN_STEPS - 1, grain));
    }
  }
  return { size: GRUNGE_SIZE, indices, clut };
}

const GRUNGE_TEXTURE: IndexedTexture = buildGrungeTexture();

/** The cart's assets sidecar carrying the editable "360 grunge" sprite block (a full page). */
export const XBOX360_ASSETS_SIDECAR: string = assetsSidecarForTexture(
  "xbox360-grunge",
  "360 grunge",
  GRUNGE_SIZE,
  GRUNGE_PAGE,
);

/** Cargo crates and blocks, as [x, y, z, halfX, halfY, halfZ]. */
const CRATES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-4.5, 0.8, -3.2, 0.8, 0.8, 0.8],
  [-3.1, 0.8, -3.4, 0.8, 0.8, 0.8],
  [-3.8, 2.2, -3.3, 0.7, 0.6, 0.7],
  [4.6, 1.0, 3.0, 1.0, 1.0, 1.0],
  [4.4, 2.6, 3.1, 0.7, 0.6, 0.7],
  [2.7, 0.7, 4.4, 0.7, 0.7, 0.7],
  [-5.0, 0.6, 2.6, 0.6, 0.6, 1.2],
  [-4.6, 0.6, 4.2, 0.9, 0.6, 0.6],
  [5.2, 0.7, -3.6, 0.7, 0.7, 0.9],
  [3.6, 0.6, -4.6, 0.6, 0.6, 0.6],
  [0.4, 0.5, -5.2, 1.3, 0.5, 0.5],
  [-1.6, 0.9, 4.9, 0.9, 0.9, 0.7],
];

/** Crossed overhead girders, as [x, y, z, halfX, halfY, halfZ]. */
const GIRDERS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 5.4, -2.0, 6.5, 0.22, 0.35],
  [0, 5.4, 2.0, 6.5, 0.22, 0.35],
  [-2.0, 5.7, 0, 0.35, 0.22, 6.5],
  [2.0, 5.7, 0, 0.35, 0.22, 6.5],
];

/** The central reactor: a stepped tower of shrinking boxes, as [y, half]. */
const TOWER: ReadonlyArray<readonly [number, number]> = [
  [0.9, 1.6],
  [2.4, 1.25],
  [3.7, 0.95],
  [4.7, 0.7],
];

/** Steel drums flanking the tower, as [x, z]. */
const DRUMS: ReadonlyArray<readonly [number, number]> = [
  [-1.9, -1.4],
  [1.9, 1.4],
  [-1.7, 1.7],
];

function buildMesh(): MeshAsset {
  const primitives: MeshPrimitive[] = [];

  // Everything textured shares one grunge material and one stream, so the whole
  // foundry is one draw of one page — the 360 reused texture atlases hard.
  const shell = newStreams();
  // A finely tessellated slab: the tier has no poly ceiling, so the floor alone
  // outspends a whole PS1 scene. Fine tessellation also keeps perspective-correct
  // texturing honest across the large surface.
  pushGround(shell, { cells: 20, half: 8, uvRepeat: 4 });
  for (const [x, y, z, hx, hy, hz] of CRATES) pushBox(shell, [x, y, z], [hx, hy, hz], 1);
  for (const [x, y, z, hx, hy, hz] of GIRDERS) pushBox(shell, [x, y, z], [hx, hy, hz], 2);
  for (const [y, half] of TOWER) pushBox(shell, [0, y, 0], [half, y === TOWER[0]![0] ? 0.9 : 0.65, half], 1);
  primitives.push(
    toPrimitive(shell, {
      name: "grunge",
      baseColorFactor: [1, 1, 1, 1],
      baseColorImage: bakeIndexedTextureImage(GRUNGE_TEXTURE),
      textureSprite: indexedTextureSpriteRef(GRUNGE_SIZE, GRUNGE_PAGE),
    }),
  );

  // Steel drums: flat dark metal, smooth cylinders — the one relief from the
  // hard-edged geometry, and a splash of the era's cold specular grey.
  const steel = newStreams();
  for (const [x, z] of DRUMS) pushCylinder(steel, [x, 0, z], 0.55, 1.5, 16);
  primitives.push(
    toPrimitive(steel, {
      name: "steel",
      baseColorFactor: [0.3, 0.31, 0.34, 1],
      baseColorImage: null,
    }),
  );

  return { name: "Xbox 360 foundry", primitives };
}

/**
 * The starter's mesh sidecar, in the stored envelope shape — built directly
 * because the editor package cannot import the web app's meshSidecar writer.
 */
export const XBOX360_MESH_SIDECAR: string = JSON.stringify({
  version: 1,
  meshes: [
    {
      id: "xbox360-foundry",
      name: "Xbox 360 foundry",
      mesh: serializeMeshAsset(buildMesh()),
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ],
});

/** Triangles in the scene — leverages the tier's unbounded poly budget. */
export const XBOX360_SCENE_TRIANGLES = (() => {
  const mesh = buildMesh();
  return mesh.primitives.reduce((sum, p) => sum + p.indices.length / 3, 0);
})();

/**
 * The cart's own code: an HD banded sky, a caption at 720p coordinates, and a
 * slow high orbit that takes in the whole foundry.
 */
export const XBOX360_CODE = `-- title:  Xbox 360 foundry
-- author: you
-- desc:   an Xbox 360-era scene -- 720p, gritty concrete and steel
-- script: lua

-- The 3D is a mesh sidecar; the player draws it over this 1280x720 frame. This
-- code owns the hazy sky, the caption and the camera. There is no era artefact
-- to point at here -- the 360 is the modern render path -- so this is about the
-- look: desaturated realism, dense geometry, sharp full-detail textures.

local t = 0
local PITCH = 0.36
local DIST  = 19.0

function TIC()
 t = t + 1
 cls(1)                        -- upper sky
 rect(0, 240, 1280, 200, 2)    -- haze band
 rect(0, 440, 1280, 280, 3)    -- ground-glow / smog near the horizon (bloom-ish)
 cartbox.meshcam(t / 380, PITCH, DIST, 0)
 print("Xbox 360 -- 1280x720 HD", 24, 24, 12)
 print("z-buffer . perspective . filtered . full-detail textures", 24, 48, 13)
 print("desaturated realism -- the modern render tier", 24, 684, 12)
end
`;

/**
 * Seed a fresh cart with the foundry's code and a hazy, desaturated palette.
 * The geometry rides along as the starter's mesh sidecar.
 */
export function seedXbox360Cart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(XBOX360_CODE);
  applyFoundryPalette(engine);
  paintIndexedTexture(engine, GRUNGE_TEXTURE, GRUNGE_PAGE);
}

/**
 * The foundry palette: a muted grey-blue sky grading into brown-grey smog at the
 * horizon, with pale ink. The geometry's colour comes from its texture and
 * materials, so the frame is just atmosphere and captions.
 */
function applyFoundryPalette(engine: CartEngine): void {
  const entries: ReadonlyArray<readonly [number, string]> = [
    [1, "#6b7480"], // upper sky
    [2, "#8a8478"], // haze
    [3, "#5a5148"], // smog / ground glow
    [12, "#e8e4dc"], // pale ink
    [13, "#c2bcb0"], // dimmer ink
  ];
  for (const [index, hex] of entries) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    engine.setPaletteColor(index, r, g, b);
  }
}
