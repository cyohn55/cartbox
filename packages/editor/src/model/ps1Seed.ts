/**
 * The "PS1 test scene" starter — the cart that answers whether the PS1 model
 * actually reads as the era.
 *
 * Every PS1 trait is pinned by a unit test as a descriptor and as rasteriser
 * behaviour, and the built core is proven to be compiled at the PS1 spec. None
 * of that is evidence about how a PS1 cart *looks*, and that judgement cannot be
 * automated — it needs something to look at. This is that something.
 *
 * ## What it is built to show
 *
 * The scene is arranged around the four artefacts that make the generation
 * recognisable, rather than around being a game:
 *
 * - **Affine texture warping.** The floor is one wide quad with its UVs tiled
 *   six times, which is the worst case for perspective-incorrect interpolation:
 *   long triangles at a shallow angle, with straight painted lines that visibly
 *   bend and swim as the camera moves. A floor made of many small quads would
 *   hide the very thing the model is reproducing.
 * - **Vertex snapping.** Integer vertex precision shows as jitter along edges
 *   while the camera orbits, and it is most legible on tall thin silhouettes —
 *   hence the pillar.
 * - **No depth buffer.** Whole triangles sort back-to-front, so overlapping
 *   geometry at similar depths flickers between orderings. The crates are placed
 *   to overlap from most viewing angles rather than sitting apart.
 * - **Unfiltered 8-bit texels.** One 64x64 CLUT texture, reused on every surface,
 *   magnified hard up close.
 *
 * ## Why it drives its own camera
 *
 * The mesh overlay auto-orbits when a cart publishes none, and that is nearly
 * enough — warping and snapping are motion artefacts, so something has to move.
 * But the auto-orbit auto-fits the whole scene's bounding sphere from a
 * comfortable height, and for a wide flat stage that means far away and looking
 * down: the two angles at which affine warping is least visible. So the cart
 * takes the camera with `cartbox.meshcam` and holds it low and close, which is
 * the viewpoint the artefact actually lives at, and doubles as a worked example
 * of the call.
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

/**
 * The plate texture — riveted metal plates with diagonal hazard stripes — as
 * palette-indexed pixels rather than a committed PNG.
 *
 * It is indexed on purpose: the texture is now an editable cart asset. These
 * pixels are painted into the cart's sprite sheet (a named "PS1 plate" block) and
 * the mesh is rebaked from them on Run/Save, so a creator edits the plate in the
 * Assets tab and the 3D floor changes. Indexed art is also exactly what a PS1
 * held. The pattern is the TypeScript twin of `scripts/make-ps1-texture.mjs`,
 * which documents each choice — chiefly that the stripes give affine
 * interpolation a straight line to bend.
 */
const PLATE_SIZE = 64;
/** The sprite page the plate occupies; page 0 so it is the first thing in Assets. */
const PLATE_PAGE = 0 as const;
const PLATE_SURFACES: ReadonlyArray<readonly [number, number, number]> = [
  [96, 100, 116], // plate
  [42, 44, 54], // seam
  [148, 152, 160], // rivet
  [188, 150, 44], // hazard stripe
];
const PLATE_GRAIN_STEPS = 8;

/** Deterministic value noise, matching the make-ps1-texture generator. */
function plateHash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Which of the four surfaces a texel belongs to. */
function plateSurface(x: number, y: number): number {
  const gx = x % 32;
  const gy = y % 32;
  // A diagonal hazard stripe across one plate in four — the straight edge affine
  // interpolation visibly bends.
  if ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 && (x + y) % 16 < 5) return 3;
  // Rivets near each plate's corners.
  const rx = Math.min(gx, 32 - gx);
  const ry = Math.min(gy, 32 - gy);
  if (rx > 3 && rx < 7 && ry > 3 && ry < 7) return 2;
  // Panel grid: 32px plates with a recessed 2px seam.
  if (gx < 2 || gy < 2) return 1;
  return 0;
}

function buildPlateTexture(): IndexedTexture {
  const clut: [number, number, number][] = [];
  for (const [r, g, b] of PLATE_SURFACES) {
    for (let step = 0; step < PLATE_GRAIN_STEPS; step += 1) {
      const shift = (step - (PLATE_GRAIN_STEPS - 1) / 2) * 7;
      const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v + shift)));
      clut.push([clamp(r), clamp(g), clamp(b)]);
    }
  }
  const indices = new Uint8Array(PLATE_SIZE * PLATE_SIZE);
  for (let y = 0; y < PLATE_SIZE; y += 1) {
    for (let x = 0; x < PLATE_SIZE; x += 1) {
      indices[y * PLATE_SIZE + x] =
        plateSurface(x, y) * PLATE_GRAIN_STEPS + Math.floor(plateHash(x, y) * PLATE_GRAIN_STEPS);
    }
  }
  return { size: PLATE_SIZE, indices, clut };
}

/** Built once: the sheet paint, the mesh bake and the named asset all derive from it. */
const PLATE_TEXTURE: IndexedTexture = buildPlateTexture();

/**
 * The cart's assets sidecar, carrying the editable "PS1 plate" sprite block. A
 * fresh PS1 cart opens with it in the Assets tab; the starter seeds it (see
 * starters.ts) the same way it seeds the mesh.
 */
export const PS1_ASSETS_SIDECAR: string = assetsSidecarForTexture(
  "ps1-plate",
  "PS1 plate",
  PLATE_SIZE,
  PLATE_PAGE,
);

/** The six faces of an axis-aligned box, as corner offsets and a face normal. */
const FACES: ReadonlyArray<{
  readonly normal: readonly [number, number, number];
  readonly corners: ReadonlyArray<readonly [number, number, number]>;
}> = [
  { normal: [0, 1, 0], corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
];

interface Box {
  readonly center: readonly [number, number, number];
  /** Half-extents on each axis. */
  readonly half: readonly [number, number, number];
  /** How many times the texture repeats across each face. */
  readonly uvRepeat: number;
}

/**
 * Emit one box into the shared attribute streams.
 *
 * Faces are flat-shaded — each face gets its own four vertices carrying the face
 * normal, rather than eight shared corner vertices with averaged normals. Shared
 * corners would round the crates off, and the era's look is hard-edged.
 */
function pushBox(
  box: Box,
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
): void {
  for (const face of FACES) {
    const base = positions.length / 3;
    for (const [cx, cy, cz] of face.corners) {
      positions.push(
        box.center[0] + cx * box.half[0],
        box.center[1] + cy * box.half[1],
        box.center[2] + cz * box.half[2],
      );
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    // One repeat per face corner, so the texture tiles rather than stretching to
    // fit — a stretched texture on a wide floor would read as a low-res blur
    // instead of as a tiled surface.
    const r = box.uvRepeat;
    uvs.push(0, 0, r, 0, r, r, 0, r);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * The stage the props stand on, as an N x N grid of quads rather than one slab.
 *
 * This is the scene's one concession, and it is an era-authentic one. With no
 * depth buffer the rasteriser sorts whole triangles back-to-front by depth, so a
 * single floor quad has one depth for its entire surface — the scene's middle —
 * and everything standing nearer than that gets painted over by the floor. The
 * first version of this scene did exactly that and lost every crate.
 *
 * Subdividing is what PS1-era games did about it, for exactly this reason, and
 * it is a real trade rather than a fix: more cells sort better and warp less,
 * because affine error grows with a triangle's screen size. The count was tuned
 * by looking — at four cells a side the props on the near half still lost to the
 * floor, because a 2-unit cell's centroid can sit nearer than a crate standing
 * on its far edge. Six puts a cell's footprint near a crate's, which sorts, and
 * still leaves cells large enough on screen to swim visibly.
 */
const FLOOR_CELLS = 6;
const FLOOR_HALF = 4;
/** One cell's world-space edge. */
const FLOOR_CELL_SIZE = (FLOOR_HALF * 2) / FLOOR_CELLS;
/**
 * Texture repeats across one cell, derived from the cell size so texel density
 * stays fixed as the subdivision is tuned. A literal here would silently make
 * the floor coarser or noisier every time FLOOR_CELLS changed.
 */
const FLOOR_UV_REPEAT = FLOOR_CELL_SIZE * 0.75;

function pushFloor(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
): void {
  const step = FLOOR_CELL_SIZE;
  for (let cz = 0; cz < FLOOR_CELLS; cz += 1) {
    for (let cx = 0; cx < FLOOR_CELLS; cx += 1) {
      const x0 = -FLOOR_HALF + cx * step;
      const z0 = -FLOOR_HALF + cz * step;
      const base = positions.length / 3;
      for (const [dx, dz] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        positions.push(x0 + dx * step, 0, z0 + dz * step);
        normals.push(0, 1, 0);
      }
      const r = FLOOR_UV_REPEAT;
      uvs.push(0, 0, r, 0, r, r, 0, r);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/**
 * What stands on the stage.
 *
 * An open arrangement, not a room: the rasteriser is two-sided (no backface
 * culling), so walls around the subject would simply occlude the orbiting camera
 * from outside. The crates overlap one another from most angles on purpose —
 * without a depth buffer, overlapping geometry at similar depths is where the
 * sort order becomes visible.
 */
const BOXES: readonly Box[] = [
  // Two pillars: tall thin silhouettes, where vertex snapping reads most
  // clearly, and far enough apart that one is near the camera for half the orbit.
  { center: [-2.4, 1.8, -1.9], half: [0.4, 1.8, 0.4], uvRepeat: 1.5 },
  { center: [2.6, 1.4, 2.2], half: [0.35, 1.4, 0.35], uvRepeat: 1.2 },
  // A stack, so there is geometry at eye level rather than all of it underfoot.
  { center: [1.4, 0.9, -0.8], half: [0.9, 0.9, 0.9], uvRepeat: 1.2 },
  { center: [1.4, 2.25, -0.8], half: [0.55, 0.45, 0.55], uvRepeat: 1 },
  { center: [2.7, 0.7, -0.4], half: [0.7, 0.7, 0.7], uvRepeat: 1 },
  { center: [-1.5, 0.75, 1.6], half: [0.75, 0.75, 0.75], uvRepeat: 1 },
  // A low wide step: a second large surface at a different height, so the
  // warping across it can be compared with the floor's.
  { center: [-2.8, 0.35, 1.9], half: [1.5, 0.35, 1.1], uvRepeat: 2 },
];

function buildMesh(): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  pushFloor(positions, normals, uvs, indices);
  for (const box of BOXES) pushBox(box, positions, normals, uvs, indices);

  const primitive: MeshPrimitive = {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    material: {
      name: "plate",
      // Left white: the texture carries the colour, and tinting it would make
      // the palette the cart's rather than the texture's.
      baseColorFactor: [1, 1, 1, 1],
      // Initial bake from the plate pixels; the editor rebakes it from the sprite
      // sheet on Run/Save so a creator's edits in the Assets tab show here.
      baseColorImage: bakeIndexedTextureImage(PLATE_TEXTURE),
      textureSprite: indexedTextureSpriteRef(PLATE_SIZE, PLATE_PAGE),
    },
  };
  return { name: "PS1 test scene", primitives: [primitive] };
}

/**
 * The starter's mesh sidecar, in the stored envelope shape (`meshSidecar.ts` in
 * the web app writes the same JSON; this builds it directly because the editor
 * package cannot import from the app).
 *
 * Built once at module load: it is a pure function of constants, and every fresh
 * PS1 cart gets an identical copy.
 */
export const PS1_MESH_SIDECAR: string = JSON.stringify({
  version: 1,
  meshes: [
    {
      id: "ps1-test-scene",
      name: "PS1 test scene",
      mesh: serializeMeshAsset(buildMesh()),
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ],
});

/** Triangles in the scene — checked against the model's poly budget by a test. */
export const PS1_SCENE_TRIANGLES =
  FLOOR_CELLS * FLOOR_CELLS * 2 + BOXES.length * FACES.length * 2;

/**
 * The cart's own code.
 *
 * Short on purpose. The mesh overlay composites over whatever frame the core
 * produces, so the core's job here is the sky behind the scene and a caption —
 * and a caption is worth having, because it names the artefacts a viewer is
 * meant to be looking for. Anything more would make this a game demo rather
 * than a test scene.
 */
export const PS1_CODE = `-- title:  PS1 test scene
-- author: you
-- desc:   an era check -- watch the floor swim and the edges jitter
-- script: lua

-- The 3D is a mesh sidecar; the player draws it over this frame. This code owns
-- the sky, the caption, and the camera.

local t = 0

-- Low and close. The auto-orbit would frame the whole stage from above, which is
-- the angle at which affine warping is least visible -- a shallow view across the
-- floor is where the era shows.
local PITCH = 0.42   -- radians above the floor
local DIST  = 11.0   -- world units from the scene centre

function TIC()
 t = t + 1
 cls(1)
 -- A horizon band, so the floor has something to meet.
 rect(0, 104, 320, 136, 2)

 -- Orbit slowly: the artefacts are motion artefacts, and too fast reads as
 -- juddering rather than as swimming.
 cartbox.meshcam(t / 260, PITCH, DIST, 0)

 print("PS1 -- 320x240, 256 colors", 6, 6, 12)
 print("no z-buffer . affine uv . integer verts", 6, 16, 13)
 -- Above the horizon: the mesh composites over this frame, so anything printed
 -- low is painted over by the floor.
 print("watch: floor texture swims, edges jitter", 6, 92, 13)
end
`;

/**
 * Seed a fresh cart with the PS1 test scene's code, palette, and plate texture.
 *
 * The geometry is not seeded here — it rides along as the starter's mesh sidecar,
 * the same way the Platformer's collision layer does. The *texture*, though, is
 * painted into the sprite sheet so it is an editable cart asset (the named "PS1
 * plate" block, seeded via PS1_ASSETS_SIDECAR); the mesh is rebaked from it.
 */
export function seedPs1Cart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(PS1_CODE);
  applyDuskPalette(engine);
  paintIndexedTexture(engine, PLATE_TEXTURE, PLATE_PAGE);
}

/**
 * The PS1 scene's dusk palette: the geometry's colour comes from its texture, so
 * the cart needs only a sky, a horizon band and legible caption ink. The N64 and
 * 360 starters set their own, brighter and hazier palettes — see n64Seed.ts and
 * xbox360Seed.ts — because those carts represent their eras rather than A/B-test
 * this one's geometry.
 */
function applyDuskPalette(engine: CartEngine): void {
  const entries: ReadonlyArray<readonly [number, string]> = [
    [1, "#161a2c"],
    [2, "#242a44"],
    [12, "#d8d2f0"],
    [13, "#9990bb"],
  ];
  for (const [index, hex] of entries) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    engine.setPaletteColor(index, r, g, b);
  }
}
