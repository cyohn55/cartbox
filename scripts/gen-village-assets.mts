/**
 * Author the CC0 "Village Pack" for the in-editor asset library.
 *
 *   npx tsx scripts/gen-village-assets.mts
 *
 * Writes staged payloads under `apps/web/public/library/{sprites,voxels}` — the
 * exact `local` origins that {@link file://./library-sources.mts} references. The
 * art is composed from explicit shape primitives (rects, discs, triangles) rather
 * than noise, so each asset is a deliberate, recognisable icon a creator can drop
 * into a cart. Running `build-library.mts --local` afterwards turns these staged
 * files into the served manifest + thumbnails.
 *
 * These are first-party, public-domain (CC0-1.0) assets; the manifest parser
 * rejects any other licence, so the provenance here is load-bearing, not a label.
 *
 * Two mediums are produced so both HD-2D worlds can be built from the same
 * library: 2D tiles/sprites (the sprite-based `/play` cart world) and voxel
 * sculpts (the 3D `/hd2d` slice world).
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VoxelGrid, encodeVox } from "@cartbox/editor";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const libraryDir = join(repoRoot, "apps", "web", "public", "library");

// --- Tiny RGBA canvas + PNG encoder -----------------------------------------

/** A colour as [r,g,b] (fully opaque) or [r,g,b,a]; missing alpha means opaque. */
type Rgba = readonly number[];
const CLEAR: Rgba = [0, 0, 0, 0];
/** Alpha of a colour, defaulting to fully opaque when only RGB was given. */
const alphaOf = (rgba: Rgba): number => (rgba.length > 3 ? rgba[3]! : 255);

/** A mutable RGBA raster the drawing helpers paint into. */
interface Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array; // RGBA, row-major
}

function makeCanvas(w: number, h: number, fill: Rgba = CLEAR): Canvas {
  const data = new Uint8Array(w * h * 4);
  const a = alphaOf(fill);
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = fill[0]!;
    data[i * 4 + 1] = fill[1]!;
    data[i * 4 + 2] = fill[2]!;
    data[i * 4 + 3] = a;
  }
  return { w, h, data };
}

function px(c: Canvas, x: number, y: number, rgba: Rgba): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const a = alphaOf(rgba);
  if (a === 0) return; // transparent paint is a no-op (keeps holes)
  const o = (y * c.w + x) * 4;
  c.data[o] = rgba[0]!;
  c.data[o + 1] = rgba[1]!;
  c.data[o + 2] = rgba[2]!;
  c.data[o + 3] = a;
}

function rect(c: Canvas, x0: number, y0: number, w: number, h: number, rgba: Rgba): void {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) px(c, x, y, rgba);
}

/** A filled disc centred at (cx,cy) with the given radius. */
function disc(c: Canvas, cx: number, cy: number, r: number, rgba: Rgba): void {
  const r2 = r * r;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) px(c, x, y, rgba);
    }
  }
}

/** An upward-pointing filled triangle: apex at (cx, top), base of `half*2` at `base`. */
function triangle(c: Canvas, cx: number, top: number, base: number, half: number, rgba: Rgba): void {
  const span = base - top;
  for (let y = top; y <= base; y += 1) {
    const t = span === 0 ? 1 : (y - top) / span;
    const w = Math.round(half * t);
    for (let x = cx - w; x <= cx + w; x += 1) px(c, x, y, rgba);
  }
}

// --- PNG output (8-bit RGBA) -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}
function encodePng(c: Canvas): Buffer {
  const raw = Buffer.alloc((c.w * 4 + 1) * c.h);
  let p = 0;
  for (let y = 0; y < c.h; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < c.w; x += 1) {
      const o = (y * c.w + x) * 4;
      raw[p++] = c.data[o]!;
      raw[p++] = c.data[o + 1]!;
      raw[p++] = c.data[o + 2]!;
      raw[p++] = c.data[o + 3]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A deterministic value hash in [0,1) for stable, seed-free texture speckle. */
function noise(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// --- Palette -----------------------------------------------------------------

const C = {
  grass: [86, 156, 74] as Rgba,
  grassLo: [66, 130, 60] as Rgba,
  grassHi: [122, 186, 96] as Rgba,
  dirt: [150, 111, 74] as Rgba,
  dirtLo: [124, 90, 58] as Rgba,
  dirtHi: [176, 138, 96] as Rgba,
  stone: [140, 142, 150] as Rgba,
  stoneLo: [104, 106, 116] as Rgba,
  stoneHi: [176, 178, 186] as Rgba,
  mortar: [78, 80, 90] as Rgba,
  water: [64, 132, 196] as Rgba,
  waterLo: [46, 104, 168] as Rgba,
  waterHi: [126, 186, 224] as Rgba,
  trunk: [110, 78, 48] as Rgba,
  trunkLo: [86, 60, 38] as Rgba,
  leaf: [64, 148, 78] as Rgba,
  leafLo: [44, 116, 62] as Rgba,
  leafHi: [104, 184, 104] as Rgba,
  rock: [128, 130, 138] as Rgba,
  rockLo: [96, 98, 108] as Rgba,
  rockHi: [166, 168, 176] as Rgba,
  wall: [206, 178, 132] as Rgba,
  wallLo: [176, 148, 106] as Rgba,
  roof: [168, 74, 60] as Rgba,
  roofLo: [138, 56, 46] as Rgba,
  wood: [132, 94, 58] as Rgba,
  woodLo: [104, 72, 44] as Rgba,
  glow: [255, 212, 128] as Rgba,
  glowHot: [255, 236, 176] as Rgba,
  metal: [70, 74, 86] as Rgba,
  window: [96, 150, 176] as Rgba,
  flowerA: [232, 96, 120] as Rgba,
  flowerB: [244, 208, 96] as Rgba,
  flowerC: [180, 140, 232] as Rgba,
} as const;

// --- 2D tiles (16×16, opaque, terrain) --------------------------------------

const TILE = 16;

function grassTile(withFlowers = false): Canvas {
  const c = makeCanvas(TILE, TILE, C.grass);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const n = noise(x, y);
      if (n > 0.82) px(c, x, y, C.grassHi);
      else if (n < 0.2) px(c, x, y, C.grassLo);
      // upright blade flecks
      if (noise(x * 2.1, y * 1.7) > 0.93) {
        px(c, x, y, C.grassHi);
        px(c, x, y - 1, C.grassHi);
      }
    }
  }
  if (withFlowers) {
    const spots: Array<[number, number, Rgba]> = [
      [3, 4, C.flowerA],
      [11, 3, C.flowerB],
      [6, 10, C.flowerC],
      [13, 12, C.flowerA],
      [9, 7, C.flowerB],
    ];
    for (const [x, y, col] of spots) {
      px(c, x, y, col);
      px(c, x + 1, y, col);
      px(c, x, y + 1, col);
      px(c, x + 1, y + 1, col);
    }
  }
  return c;
}

function dirtPathTile(): Canvas {
  const c = makeCanvas(TILE, TILE, C.dirt);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const n = noise(x * 1.3, y * 0.9);
      if (n > 0.8) px(c, x, y, C.dirtHi);
      else if (n < 0.22) px(c, x, y, C.dirtLo);
    }
  }
  // a few small pebbles
  disc(c, 4, 5, 1.2, C.dirtHi);
  disc(c, 11, 10, 1.4, C.stoneLo);
  disc(c, 8, 3, 1, C.dirtLo);
  return c;
}

function cobbleTile(): Canvas {
  const c = makeCanvas(TILE, TILE, C.mortar);
  // 2×2 grid of rounded stones separated by mortar seams.
  const stones: Array<[number, number, number, number]> = [
    [1, 1, 6, 6],
    [9, 1, 6, 6],
    [1, 9, 6, 6],
    [9, 9, 6, 6],
  ];
  for (const [sx, sy, sw, sh] of stones) {
    for (let y = sy; y < sy + sh; y += 1) {
      for (let x = sx; x < sx + sw; x += 1) {
        const edge = x === sx || y === sy || x === sx + sw - 1 || y === sy + sh - 1;
        const n = noise(x, y);
        px(c, x, y, edge ? C.stoneLo : n > 0.7 ? C.stoneHi : C.stone);
      }
    }
  }
  return c;
}

function waterTile(): Canvas {
  const c = makeCanvas(TILE, TILE, C.water);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const wave = Math.sin((x + y) * 0.9) + Math.sin(y * 1.7);
      if (wave > 1.2) px(c, x, y, C.waterHi);
      else if (wave < -1.2) px(c, x, y, C.waterLo);
    }
  }
  // sparkle glints
  px(c, 4, 5, C.waterHi);
  px(c, 12, 9, C.waterHi);
  px(c, 8, 2, C.waterHi);
  return c;
}

// --- 2D sprite props (32×32, transparent, camera-facing billboards) ----------

const PROP = 32;

/** Shade a column of ground contact so a prop reads as planted, not floating. */
function groundShadow(c: Canvas, cx: number, cy: number, rx: number): void {
  for (let x = cx - rx; x <= cx + rx; x += 1) {
    const t = 1 - Math.abs(x - cx) / (rx + 1);
    if (t > 0.15 && (x + cy) % 2 === 0) px(c, x, cy, [20, 26, 30, 150]);
    if (t > 0.4) px(c, x, cy, [22, 28, 32, 190]);
  }
}

function pineTree(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 30, 8);
  rect(c, 14, 24, 4, 6, C.trunk);
  rect(c, 14, 24, 1, 6, C.trunkLo);
  // three stacked conifer skirts, darkest at the base
  triangle(c, 16, 16, 26, 11, C.leafLo);
  triangle(c, 16, 9, 20, 9, C.leaf);
  triangle(c, 16, 3, 14, 7, C.leafHi);
  // highlight flecks
  px(c, 13, 14, C.leafHi);
  px(c, 19, 18, C.leafHi);
  px(c, 16, 7, C.leafHi);
  return c;
}

function oakTree(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 30, 8);
  rect(c, 14, 22, 4, 8, C.trunk);
  rect(c, 14, 22, 1, 8, C.trunkLo);
  disc(c, 16, 12, 10, C.leafLo);
  disc(c, 12, 11, 7, C.leaf);
  disc(c, 20, 12, 7, C.leaf);
  disc(c, 16, 8, 7, C.leafHi);
  disc(c, 13, 8, 3, C.leafHi);
  return c;
}

function rockSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 27, 9);
  disc(c, 16, 20, 9, C.rockLo);
  disc(c, 15, 18, 8, C.rock);
  disc(c, 13, 15, 4, C.rockHi);
  // a crack
  rect(c, 17, 16, 1, 8, C.rockLo);
  return c;
}

function bushSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 28, 9);
  disc(c, 11, 22, 6, C.leafLo);
  disc(c, 21, 22, 6, C.leafLo);
  disc(c, 16, 20, 8, C.leaf);
  disc(c, 13, 17, 4, C.leafHi);
  disc(c, 20, 18, 3, C.leafHi);
  // little berries
  px(c, 12, 21, C.flowerA);
  px(c, 19, 23, C.flowerA);
  return c;
}

function lanternSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 30, 4);
  rect(c, 15, 12, 2, 18, C.metal); // post
  rect(c, 12, 28, 8, 2, C.metal); // base
  // lamp head + glass
  rect(c, 11, 5, 10, 8, C.metal);
  rect(c, 12, 6, 8, 6, C.glow);
  disc(c, 16, 9, 2.4, C.glowHot);
  rect(c, 13, 3, 6, 2, C.metal); // cap
  return c;
}

function houseSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 31, 12);
  rect(c, 5, 15, 22, 16, C.wall); // body
  rect(c, 5, 15, 22, 2, C.wallLo);
  rect(c, 5, 29, 22, 2, C.wallLo);
  // roof
  triangle(c, 16, 3, 15, 15, C.roof);
  triangle(c, 16, 3, 14, 14, C.roofLo);
  for (let x = 2; x <= 30; x += 1) px(c, x, 15, C.roofLo); // eaves line
  // door + windows
  rect(c, 14, 22, 5, 9, C.woodLo);
  px(c, 17, 26, C.glow); // door knob
  rect(c, 8, 19, 4, 4, C.window);
  rect(c, 21, 19, 4, 4, C.window);
  return c;
}

function fenceSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 30, 12);
  for (const postX of [6, 16, 26]) {
    rect(c, postX - 1, 14, 3, 16, C.wood);
    rect(c, postX - 1, 14, 1, 16, C.woodLo);
    triangle(c, postX, 11, 14, 2, C.wood); // pointed cap
  }
  rect(c, 4, 18, 24, 2, C.woodLo); // upper rail
  rect(c, 4, 24, 24, 2, C.woodLo); // lower rail
  return c;
}

function wellSprite(): Canvas {
  const c = makeCanvas(PROP, PROP);
  groundShadow(c, 16, 31, 11);
  // stone ring
  rect(c, 7, 22, 18, 9, C.stoneLo);
  for (let y = 22; y < 31; y += 1)
    for (let x = 7; x < 25; x += 1) if (noise(x, y) > 0.6) px(c, x, y, C.stone);
  rect(c, 9, 22, 14, 3, [22, 24, 30, 255]); // dark water mouth
  // posts + roof
  rect(c, 8, 8, 2, 15, C.wood);
  rect(c, 22, 8, 2, 15, C.wood);
  triangle(c, 16, 2, 9, 12, C.roof);
  triangle(c, 16, 2, 8, 11, C.roofLo);
  rect(c, 15, 9, 2, 4, C.woodLo); // bucket rope
  rect(c, 13, 13, 6, 4, C.wood); // bucket
  return c;
}

// --- 3D voxel props (for the /hd2d slice) -----------------------------------

type Rgb = readonly [number, number, number];
const rgb = (r: Rgba): Rgb => [r[0], r[1], r[2]];

/** Fill a solid box of cells in a grid with one colour. */
function voxBox(g: VoxelGrid, x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, col: Rgb): void {
  for (let z = z0; z < z0 + sz; z += 1)
    for (let y = y0; y < y0 + sy; y += 1)
      for (let x = x0; x < x0 + sx; x += 1) g.set(x, y, z, col[0], col[1], col[2], 0);
}

/** Fill a solid sphere of cells centred at (cx,cy,cz). */
function voxSphere(g: VoxelGrid, cx: number, cy: number, cz: number, r: number, col: Rgb): void {
  const r2 = r * r;
  for (let z = Math.floor(cz - r); z <= cz + r; z += 1)
    for (let y = Math.floor(cy - r); y <= cy + r; y += 1)
      for (let x = Math.floor(cx - r); x <= cx + r; x += 1) {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const inBounds = x >= 0 && y >= 0 && z >= 0 && x < g.sizeX && y < g.sizeY && z < g.sizeZ;
        if (inBounds && dx * dx + dy * dy + dz * dz <= r2) {
          g.set(x, y, z, col[0], col[1], col[2], 0);
        }
      }
}

// Prop sizes are kept small (≈2–3× a ~2-unit hero) so they read in proportion in
// the /hd2d camera, where one voxel is one world unit.

function voxTree(): VoxelGrid {
  const g = new VoxelGrid(7, 7, 7);
  voxBox(g, 3, 0, 3, 1, 3, 1, rgb(C.trunk)); // trunk
  voxSphere(g, 3, 5, 3, 2.6, rgb(C.leaf)); // canopy
  voxSphere(g, 2, 4, 4, 1.6, rgb(C.leafLo));
  voxSphere(g, 4, 6, 2, 1.4, rgb(C.leafHi));
  return g;
}

function voxRock(): VoxelGrid {
  // A simple dome that sits on the ground: a half-sphere, no bottom trim (which
  // left downward-facing holes). Content starts at y=0 so it rests flush.
  const g = new VoxelGrid(5, 4, 5);
  voxSphere(g, 2, 1, 2, 2.4, rgb(C.rock));
  voxSphere(g, 1, 2, 1, 1.2, rgb(C.rockHi));
  // clear anything below the ground plane so the base is flat
  voxBox(g, 0, 0, 0, 5, 1, 5, rgb(C.rockLo));
  return g;
}

function voxHouse(): VoxelGrid {
  const g = new VoxelGrid(7, 6, 7);
  voxBox(g, 0, 0, 0, 7, 3, 7, rgb(C.wall)); // body
  voxBox(g, 0, 0, 0, 7, 1, 7, rgb(C.wallLo)); // darker base course
  // roof: three shrinking courses to a ridge
  for (let layer = 0; layer < 3; layer += 1)
    voxBox(g, layer, 3 + layer, layer, 7 - layer * 2, 1, 7 - layer * 2, rgb(layer % 2 ? C.roofLo : C.roof));
  voxBox(g, 3, 0, 0, 1, 2, 1, rgb(C.woodLo)); // door
  return g;
}

function voxWell(): VoxelGrid {
  const g = new VoxelGrid(6, 5, 6);
  voxBox(g, 0, 0, 0, 6, 2, 6, rgb(C.stone)); // stone ring
  voxBox(g, 1, 1, 1, 4, 2, 4, rgb(C.water)); // water inside
  // four roof posts + a peaked roof
  for (const [px, pz] of [
    [0, 0],
    [5, 0],
    [0, 5],
    [5, 5],
  ] as const)
    voxBox(g, px, 2, pz, 1, 2, 1, rgb(C.wood));
  for (let layer = 0; layer < 2; layer += 1)
    voxBox(g, layer, 4 + layer, layer, 6 - layer * 2, 1, 6 - layer * 2, rgb(layer % 2 ? C.roofLo : C.roof));
  return g;
}

function voxLamp(): VoxelGrid {
  const g = new VoxelGrid(3, 5, 3);
  voxBox(g, 1, 0, 1, 1, 4, 1, rgb(C.metal)); // post
  voxBox(g, 0, 0, 0, 3, 1, 3, rgb(C.metal)); // base
  voxBox(g, 0, 4, 0, 3, 1, 3, rgb(C.glow)); // glowing head
  g.set(1, 4, 1, C.glowHot[0], C.glowHot[1], C.glowHot[2], 220);
  return g;
}

// --- Emit --------------------------------------------------------------------

interface Staged {
  readonly dir: "sprites" | "voxels";
  readonly file: string;
  readonly bytes: Uint8Array;
}

function stagePng(dir: "sprites", file: string, canvas: Canvas): Staged {
  return { dir, file, bytes: encodePng(canvas) };
}
function stageVox(file: string, grid: VoxelGrid): Staged {
  return { dir: "voxels", file, bytes: encodeVox(grid) };
}

const staged: Staged[] = [
  // tiles
  stagePng("sprites", "village-grass.png", grassTile(false)),
  stagePng("sprites", "village-flowers.png", grassTile(true)),
  stagePng("sprites", "village-dirt-path.png", dirtPathTile()),
  stagePng("sprites", "village-cobble.png", cobbleTile()),
  stagePng("sprites", "village-water.png", waterTile()),
  // sprite props
  stagePng("sprites", "village-pine.png", pineTree()),
  stagePng("sprites", "village-oak.png", oakTree()),
  stagePng("sprites", "village-rock.png", rockSprite()),
  stagePng("sprites", "village-bush.png", bushSprite()),
  stagePng("sprites", "village-lantern.png", lanternSprite()),
  stagePng("sprites", "village-house.png", houseSprite()),
  stagePng("sprites", "village-fence.png", fenceSprite()),
  stagePng("sprites", "village-well.png", wellSprite()),
  // voxel props
  stageVox("village-tree.vox", voxTree()),
  stageVox("village-rock.vox", voxRock()),
  stageVox("village-house.vox", voxHouse()),
  stageVox("village-well.vox", voxWell()),
  stageVox("village-lamp.vox", voxLamp()),
];

for (const asset of staged) {
  const path = join(libraryDir, asset.dir, asset.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, asset.bytes);
  console.log(`  wrote ${asset.dir}/${asset.file}  (${asset.bytes.length} B)`);
}
console.log(`\nStaged ${staged.length} village-pack payloads under public/library.`);
