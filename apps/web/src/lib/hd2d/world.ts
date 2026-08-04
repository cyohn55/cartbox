// The HD-2D vertical slice's 3D world: real voxel geometry wearing hand-authored
// pixel-art face tiles (the "3D objects with pixel-art materials" half of the
// spec). A REPLACED teal-night street corner — wet asphalt ground, two neon-lit
// building blocks behind, a streetlamp, and a foreground pillar that proves the
// character shares the world's z-buffer (it occludes / is occluded correctly).
//
// Built from the real editor primitives (VoxelGrid → voxelGridToModel) so this is
// the same 3D renderer the editor's Voxel tab and /world use — nothing faked.

import {
  VoxelGrid,
  voxelGridToModel,
  spriteToFaceTexture,
  type PlacedModel,
  type TextureAtlas,
  type FaceTexture,
} from "@cartbox/editor";
import { makeCanvas, fillRect, setPixel, hashNoise, type Rgb } from "./pixelArt";

const TILE = 16; // face-tile resolution in texels

// ---- pixel-art face tiles (the "materials") --------------------------------
type Emissive = Uint8Array;
function emissiveBuf(): Emissive { return new Uint8Array(TILE * TILE); }
function setEmis(e: Emissive, x: number, y: number, v: number) { e[y * TILE + x] = v; }

/** Wet dark asphalt: near-black speckle with faint wet streaks + rare puddle fleck. */
function asphaltTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const n = hashNoise(x, y);
    const streak = Math.sin(y * 0.9 + x * 0.1) > 0.7;
    const base: Rgb = n > 0.93 ? [46, 60, 84] : streak ? [26, 32, 46] : [16, 19, 28];
    setPixel(c, x, y, base);
  }
  return spriteToFaceTexture(c.data, TILE, TILE);
}

/** Sidewalk cobble: slightly lighter with a grid of mortar lines. */
function cobbleTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const seam = x % 8 === 0 || y % 8 === 0;
    setPixel(c, x, y, seam ? [12, 15, 22] : [30, 36, 48]);
  }
  return spriteToFaceTexture(c.data, TILE, TILE);
}

/** A REPLACED wall: dark teal brick courses with mortar lines. */
function brickTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const course = Math.floor(y / 4);
    const stagger = course % 2 === 0 ? 0 : 4;
    const mortar = y % 4 === 0 || (x + stagger) % 8 === 0;
    const tint = hashNoise(x, y) > 0.85 ? 8 : 0;
    setPixel(c, x, y, mortar ? [10, 14, 20] : [26 + tint, 34 + tint, 50 + tint]);
  }
  return spriteToFaceTexture(c.data, TILE, TILE);
}

/** A lit window pane grid — warm interior glow (emissive). */
function windowTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  const e = emissiveBuf();
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const paneOn = x % 6 >= 1 && x % 6 <= 4 && y % 8 >= 1 && y % 8 <= 6 && hashNoise(Math.floor(x / 6), Math.floor(y / 8)) > 0.35;
    if (paneOn) { setPixel(c, x, y, [255, 198, 120]); setEmis(e, x, y, 230); }
    else setPixel(c, x, y, [14, 18, 28]);
  }
  return spriteToFaceTexture(c.data, TILE, TILE, e);
}

/** A saturated neon panel (emissive). */
function neonTile(rgb: Rgb): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  const e = emissiveBuf();
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    const bar = (y % 5) < 3 && (x % 4) < 3;
    if (bar) { setPixel(c, x, y, rgb); setEmis(e, x, y, 255); }
    else setPixel(c, x, y, [10, 12, 20]);
  }
  return spriteToFaceTexture(c.data, TILE, TILE, e);
}

/** Dark brushed metal (lamp post, railings). */
function metalTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) {
    setPixel(c, x, y, x % 8 === 2 ? [40, 46, 60] : [20, 24, 34]);
  }
  return spriteToFaceTexture(c.data, TILE, TILE);
}

/** A glowing amber lamp head (fully emissive). */
function lampTile(): FaceTexture {
  const c = makeCanvas(TILE, TILE);
  const e = emissiveBuf();
  for (let y = 0; y < TILE; y += 1) for (let x = 0; x < TILE; x += 1) { setPixel(c, x, y, [255, 210, 138]); setEmis(e, x, y, 255); }
  return spriteToFaceTexture(c.data, TILE, TILE, e);
}

// Atlas slots (a voxel's `tile` is one of these indices; one tile skins all faces).
const T = { asphalt: 0, cobble: 1, brick: 2, window: 3, neonCyan: 4, neonMagenta: 5, metal: 6, lamp: 7 } as const;
export function buildAtlas(): TextureAtlas {
  return {
    tiles: [
      asphaltTile(), cobbleTile(), brickTile(), windowTile(),
      neonTile([92, 226, 242]), neonTile([255, 88, 182]), metalTile(), lampTile(),
    ],
  };
}

// ---- voxel geometry --------------------------------------------------------
/** A solid box grid filled with one colour + tile, returned as a placed model. */
function box(
  sx: number, sy: number, sz: number,
  rgb: Rgb, tile: number, position: readonly [number, number, number],
  atlas: TextureAtlas, skin?: (x: number, y: number, z: number) => number,
): PlacedModel {
  const grid = new VoxelGrid(sx, sy, sz);
  for (let z = 0; z < sz; z += 1) for (let y = 0; y < sy; y += 1) for (let x = 0; x < sx; x += 1) {
    grid.set(x, y, z, rgb[0], rgb[1], rgb[2], 0, skin ? skin(x, y, z) : tile);
  }
  return { model: voxelGridToModel(grid, { center: "content" }), position, atlas };
}

export interface Hd2dWorld {
  readonly models: readonly PlacedModel[];
  /** Where the character starts (foot centre), world units. */
  readonly start: readonly [number, number, number];
  /** How far the character may roam from centre (kept over the ground). */
  readonly bounds: { readonly radiusX: number; readonly radiusZ: number };
}

const NEONS = [T.neonMagenta, T.neonCyan] as const;
function hash(n: number): number { const s = Math.sin(n * 12.9898 + 4.13) * 43758.5453; return s - Math.floor(s); }

/** A building block skinned brick, with lit-window rows and a neon band up top. */
function building(
  px: number, pz: number, w: number, h: number, d: number, neon: number, atlas: TextureAtlas,
): PlacedModel {
  return box(w, h, d, [255, 255, 255], T.brick, [px, h / 2 - 0.5, pz], atlas, (x, y, z) => {
    const front = z === d - 1;
    if (front && y % 3 === 1 && x % 2 === 0) return T.window;
    if (front && y === h - 2 && x >= 1 && x <= w - 2) return neon;
    return T.brick;
  });
}

/**
 * Assemble a REPLACED night street that runs along X. +x right, +y up, +z toward
 * the camera. The ground top sits at y≈0 so the character's foot rests at y=0. The
 * street is long enough to walk (the camera follows), lined with varied neon-lit
 * buildings at the back and streetlamps + occluder pillars near the front.
 */
export function buildWorld(atlas: TextureAtlas = buildAtlas()): Hd2dWorld {
  const models: PlacedModel[] = [];
  const LENGTH = 56;   // ground span along X
  const DEPTH = 12;    // ground span along Z
  const halfLen = LENGTH / 2;

  // Wet asphalt roadway with a cobble sidewalk strip at the back edge (far from camera).
  models.push(box(LENGTH, 1, DEPTH, [255, 255, 255], T.asphalt, [0, -0.5, -DEPTH / 2 + 3], atlas,
    (_x, _y, z) => (z < 2 ? T.cobble : T.asphalt)));

  // Buildings line the back edge at intervals, hashed for varied height/width/neon.
  for (let bx = -halfLen + 4; bx < halfLen - 4; bx += 9) {
    const h = 10 + Math.floor(hash(bx) * 10);
    const w = 5 + Math.floor(hash(bx + 1.3) * 3);
    const neon = NEONS[Math.floor(hash(bx + 2.7) * NEONS.length)]!;
    models.push(building(bx, -DEPTH + 3, w, h, 5, neon, atlas));
  }

  // Streetlamps down the near sidewalk; occasional foreground pillars as occluders.
  for (let lx = -halfLen + 6; lx < halfLen - 4; lx += 12) {
    models.push(box(1, 8, 1, [80, 90, 110], T.metal, [lx, 3.5, 3], atlas));
    models.push(box(2, 1, 2, [255, 210, 138], T.lamp, [lx, 7.5, 3], atlas));
    if (hash(lx + 5) > 0.5) models.push(box(2, 9, 2, [255, 255, 255], T.brick, [lx + 6, 4, 5], atlas));
  }

  return { models, start: [0, 0, 0], bounds: { radiusX: halfLen - 3, radiusZ: 3 } };
}
