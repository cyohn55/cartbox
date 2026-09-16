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
import { base64ToBytes } from "./base64";
import {
  serializeMeshAsset,
  type EncodedImage,
  type MeshAsset,
  type MeshPrimitive,
} from "./MeshAsset";
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
 * The ground's grass/dirt texture: a 64x64, 24-entry-CLUT PNG. Soft and low
 * contrast on purpose — the N64's 4KB cache halves it until it fits, and a busy
 * texture would blur into mush where a soft one blurs into the era's look.
 * Regenerate with `node scripts/make-n64-texture.mjs`.
 */
const GRASS_PNG_BASE64 =
  "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";

function grassTexture(): EncodedImage {
  return { mime: "image/png", bytes: base64ToBytes(GRASS_PNG_BASE64) };
}

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
      baseColorImage: grassTexture(),
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
