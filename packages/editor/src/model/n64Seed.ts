/**
 * The "N64 courtyard" starter — a cart built to read as the Nintendo 64 era,
 * not to A/B-test the renderer.
 *
 * The PS1 starter (see ps1Seed.ts) shares its geometry with a matching N64 test
 * scene so the two differ only in rasterisation. That comparison is worth having,
 * and it still exists. This is the other thing a creator wants from an era model:
 * a cart that simply *looks* like the generation, to open on and build from.
 *
 * ## What makes it read as N64
 *
 * - **Rounded, smooth-shaded forms.** The PS1 could afford flat facets; the N64,
 *   with a depth buffer and vertex lighting, filled its worlds with low-poly but
 *   *curved* shapes — Mario's hills, Banjo's mounds. So the terrain rolls, and
 *   the hills and trees are smooth spheres and cones (see seedGeometry), lit with
 *   Gouraud shading rather than the crate-hard faces of the PS1 scene.
 * - **Soft, filtered ground.** One 64x64 grass texture, tiled, and drawn through
 *   the model's trilinear filter and 4KB texture cache — the runtime downsamples
 *   it and the result is the warm blur the era is remembered for. The texture is
 *   deliberately soft-edged so it blurs well (make-n64-texture.mjs).
 * - **Bright, saturated palette.** The 2D frame is a cheerful blue sky over a
 *   green field — the opposite of the PS1 scene's dusk, and of the 360 scene's
 *   grey. Colour is most of what dates a console generation.
 * - **A collectible.** A gold octahedron gem spins over the centre — the "go get
 *   it" object that furnished every N64 platformer.
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
  pushCone,
  pushCylinder,
  pushGround,
  pushOctahedron,
  pushSphere,
  toPrimitive,
} from "./seedGeometry";

/**
 * The ground's grass/dirt texture, as palette-indexed pixels so it is an editable
 * cart asset — the named "N64 grass" block a creator edits in the Assets tab; the
 * ground is rebaked from it. Soft and low contrast on purpose: the era look is a
 * texture blurred by filtering, and a busy source blurs into mush. The pattern is
 * the TypeScript twin of `scripts/make-n64-texture.mjs`.
 */
const GRASS_SIZE = 64;
/** The sprite page the grass occupies; page 0 so it is the first thing in Assets. */
const GRASS_PAGE = 0 as const;
const GRASS_SURFACES: ReadonlyArray<readonly [number, number, number]> = [
  [86, 138, 66], // grass
  [120, 96, 60], // dirt
  [176, 166, 122], // sand
];
const GRASS_GRAIN_STEPS = 8;

function grassHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smooth 2D value noise (bilerp of the integer lattice), for soft blobs. */
function grassSmoothNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = grassHash(xi, yi);
  const b = grassHash(xi + 1, yi);
  const c = grassHash(xi, yi + 1);
  const d = grassHash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function grassSurface(x: number, y: number): number {
  const dirt = grassSmoothNoise(x / 22, y / 22);
  if (dirt > 0.62) return 1;
  if (dirt > 0.74 && grassSmoothNoise((x + 40) / 14, (y + 40) / 14) > 0.5) return 2;
  return 0;
}

function buildGrassTexture(): IndexedTexture {
  const clut: [number, number, number][] = [];
  for (const [r, g, b] of GRASS_SURFACES) {
    for (let step = 0; step < GRASS_GRAIN_STEPS; step += 1) {
      const shift = (step - (GRASS_GRAIN_STEPS - 1) / 2) * 3;
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + shift)));
      clut.push([clamp(r), clamp(g), clamp(b)]);
    }
  }
  const indices = new Uint8Array(GRASS_SIZE * GRASS_SIZE);
  for (let y = 0; y < GRASS_SIZE; y += 1) {
    for (let x = 0; x < GRASS_SIZE; x += 1) {
      const grain = Math.floor(grassSmoothNoise(x / 3.5, y / 3.5) * GRASS_GRAIN_STEPS);
      indices[y * GRASS_SIZE + x] = grassSurface(x, y) * GRASS_GRAIN_STEPS + Math.min(GRASS_GRAIN_STEPS - 1, grain);
    }
  }
  return { size: GRASS_SIZE, indices, clut };
}

const GRASS_TEXTURE: IndexedTexture = buildGrassTexture();

/** The cart's assets sidecar carrying the editable "N64 grass" sprite block. */
export const N64_ASSETS_SIDECAR: string = assetsSidecarForTexture(
  "n64-grass",
  "N64 grass",
  GRASS_SIZE,
  GRASS_PAGE,
);

const GROUND_CELLS = 12;
const GROUND_HALF = 6;

/** Gentle rolling terrain: two low sine ridges crossing, nothing steep. */
function terrainHeight(x: number, z: number): number {
  return Math.sin(x * 0.55) * 0.35 + Math.cos(z * 0.4) * 0.3;
}

/** Where the smooth mounds sit, as [x, z, radius]. */
const MOUNDS: ReadonlyArray<readonly [number, number, number]> = [
  [-3.4, -2.2, 2.1],
  [3.0, 2.6, 1.6],
];

/** Trees, as [x, z, height]. Trunk is a cylinder, canopy a cone above it. */
const TREES: ReadonlyArray<readonly [number, number, number]> = [
  [-4.2, 2.8, 1.4],
  [4.3, -3.0, 1.7],
  [1.4, 4.4, 1.2],
];

function buildMesh(): MeshAsset {
  const primitives: MeshPrimitive[] = [];

  // Ground: textured, smooth, rolling. One repeat per two cells keeps texels
  // large so the filter has something to soften.
  const ground = newStreams();
  pushGround(ground, {
    cells: GROUND_CELLS,
    half: GROUND_HALF,
    uvRepeat: 1.5,
    height: terrainHeight,
  });
  primitives.push(
    toPrimitive(ground, {
      name: "grass",
      baseColorFactor: [1, 1, 1, 1],
      baseColorImage: bakeIndexedTextureImage(GRASS_TEXTURE),
      textureSprite: indexedTextureSpriteRef(GRASS_SIZE, GRASS_PAGE),
    }),
  );

  // Hills: smooth green hemispheres sitting on the terrain, flat-coloured so the
  // Gouraud shading is the whole surface — the rounded N64 silhouette.
  const hills = newStreams();
  for (const [x, z, r] of MOUNDS) {
    pushSphere(hills, [x, terrainHeight(x, z) - r * 0.15, z], r, 14, 7, { hemisphere: true });
  }
  primitives.push(
    toPrimitive(hills, {
      name: "hill",
      baseColorFactor: [0.36, 0.6, 0.28, 1],
      baseColorImage: null,
    }),
  );

  // Tree trunks and canopies are two materials, so two primitives.
  const trunks = newStreams();
  const canopy = newStreams();
  for (const [x, z, h] of TREES) {
    const y = terrainHeight(x, z);
    pushCylinder(trunks, [x, y, z], 0.22, h, 8);
    pushCone(canopy, [x, y + h - 0.2, z], 1.0, 1.7, 10);
    pushCone(canopy, [x, y + h + 0.6, z], 0.7, 1.3, 10);
  }
  primitives.push(
    toPrimitive(trunks, {
      name: "trunk",
      baseColorFactor: [0.46, 0.32, 0.2, 1],
      baseColorImage: null,
    }),
  );
  primitives.push(
    toPrimitive(canopy, {
      name: "canopy",
      baseColorFactor: [0.26, 0.5, 0.24, 1],
      baseColorImage: null,
    }),
  );

  // The collectible: a gold gem floating over the courtyard's centre.
  const gem = newStreams();
  pushOctahedron(gem, [0, 2.6, 0], 0.7);
  primitives.push(
    toPrimitive(gem, {
      name: "gem",
      baseColorFactor: [0.96, 0.78, 0.26, 1],
      baseColorImage: null,
    }),
  );

  return { name: "N64 courtyard", primitives };
}

/**
 * The starter's mesh sidecar, in the stored envelope shape — built directly
 * because the editor package cannot import the web app's meshSidecar writer.
 */
export const N64_MESH_SIDECAR: string = JSON.stringify({
  version: 1,
  meshes: [
    {
      id: "n64-courtyard",
      name: "N64 courtyard",
      mesh: serializeMeshAsset(buildMesh()),
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ],
});

/** Triangles in the scene — checked against the model's poly budget by a test. */
export const N64_SCENE_TRIANGLES = (() => {
  const mesh = buildMesh();
  return mesh.primitives.reduce((sum, p) => sum + p.indices.length / 3, 0);
})();

/**
 * The cart's own code: sky, caption and a slow orbit. The gem's spin is a
 * comment for the creator to wire up — the mesh overlay draws the sidecar as
 * authored, and animating an instance is the natural first edit this cart invites.
 */
export const N64_CODE = `-- title:  N64 courtyard
-- author: you
-- desc:   an N64-era scene -- rolling hills, filtered grass, a gold gem
-- script: lua

-- The 3D is a mesh sidecar; the player draws it over this frame. This code owns
-- the bright sky, the caption, and the camera. Try editing the gem's transform
-- in the Mesh tab to make it spin -- that is the era's "go get it" collectible.

local t = 0

-- Framed a little higher and further than the PS1 scene: the N64 look is the
-- whole cheerful courtyard read at once, with the ground filtering into softness.
local PITCH = 0.52
local DIST  = 15.0

function TIC()
 t = t + 1
 cls(1)                       -- sky
 rect(0, 150, 320, 90, 2)     -- distant hills band on the horizon
 cartbox.meshcam(t / 320, PITCH, DIST, 0)
 print("N64 -- 320x240, filtered 3D", 6, 6, 12)
 print("z-buffer . smooth shading . 4KB textures", 6, 16, 13)
 print("rounded hills, soft grass, a gold gem", 6, 226, 12)
end
`;

/**
 * Seed a fresh cart with the N64 courtyard's code and a bright outdoor palette.
 * The geometry rides along as the starter's mesh sidecar, the same way the PS1
 * scene's does.
 */
export function seedN64Cart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(N64_CODE);
  applyCourtyardPalette(engine);
  paintIndexedTexture(engine, GRASS_TEXTURE, GRASS_PAGE);
}

/**
 * The bright courtyard palette: a saturated blue sky, a hazy horizon band, and
 * legible ink. The geometry's own colours come from its materials, so the frame
 * only needs a sky and captions.
 */
function applyCourtyardPalette(engine: CartEngine): void {
  const entries: ReadonlyArray<readonly [number, string]> = [
    [1, "#5bb8f5"], // sky
    [2, "#9fd8b0"], // distant hills
    [12, "#0e2a3a"], // dark ink, legible on the bright sky
    [13, "#0e3a2a"], // dark green ink
  ];
  for (const [index, hex] of entries) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    engine.setPaletteColor(index, r, g, b);
  }
}
