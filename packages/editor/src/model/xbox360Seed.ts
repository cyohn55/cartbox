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
import { base64ToBytes } from "./base64";
import {
  serializeMeshAsset,
  type EncodedImage,
  type MeshAsset,
  type MeshPrimitive,
} from "./MeshAsset";
import {
  newStreams,
  pushBox,
  pushCylinder,
  pushGround,
  toPrimitive,
} from "./seedGeometry";

/**
 * The shared surface texture: a 128x128, 32-entry-CLUT PNG of scuffed concrete,
 * bolted steel panels and rust bloom. High contrast and full-detail — the 360
 * has no small texture cache to blur it. Regenerate with
 * `node scripts/make-xbox360-texture.mjs`.
 */
const GRUNGE_PNG_BASE64 =
  "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";

function grungeTexture(): EncodedImage {
  return { mime: "image/png", bytes: base64ToBytes(GRUNGE_PNG_BASE64) };
}

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
      baseColorImage: grungeTexture(),
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
