// Rebuild the "Octopath — Cartbox HD-2D" cart so its world is composed from the
// asset library instead of bespoke one-off art.
//
//   node scripts/build-hd2d-octopath.mjs
//
// The sprite-based world runtime reads every terrain/prop/character sprite as a
// 4×4 tile block out of the cart's page-0 tile sheet. So "use the asset library"
// here means: bake the library's Village-Pack tile + sprite art into that sheet
// and point the world sidecar's blocks at it.
//
// To keep the library art looking as authored (Sweetie-16 has no browns), the
// cart gets a custom 16-colour palette tuned to the pack; the existing hero /
// villager billboards are decoded from the old palette and re-quantised to the
// new one so they survive the palette swap. The known-good .tic container is
// reused verbatim except for its palette and page-0 tile chunk, so the cart still
// loads exactly as before — only its art and world layout change.
//
// Outputs (committed fixtures the seed script reads):
//   scripts/fixtures/hd2d-octopath.tic          — palette + tiles rebaked
//   scripts/fixtures/hd2d-octopath.world.json   — village composed from library blocks
//   scripts/fixtures/hd2d-octopath.credits.json — CC0 provenance for the art used

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodePng } from "./lib/png-decode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const libraryDir = join(here, "..", "apps", "web", "public", "library");

// --- Custom 16-colour palette (RGB), tuned to the Village Pack ----------------
// Index 0 is the world runtime's transparent key (a billboard's index-0 pixels
// become holes), so it stays the darkest slot and no opaque art maps onto it.
const PALETTE = [
  [26, 28, 44],    // 0 transparent key / darkest
  [51, 60, 87],    // 1 dark slate (shadow)
  [86, 108, 134],  // 2 steel / stone shadow
  [150, 160, 170], // 3 light stone
  [244, 244, 244], // 4 white highlight
  [58, 110, 58],   // 5 dark green
  [92, 164, 78],   // 6 grass green
  [150, 205, 110], // 7 light green
  [74, 52, 34],    // 8 dark brown (trunk shadow)
  [120, 84, 52],   // 9 brown (trunk / wood)
  [170, 124, 78],  // 10 dirt / light wood
  [214, 182, 132], // 11 sand / wall
  [170, 74, 60],   // 12 roof red
  [64, 132, 196],  // 13 water blue
  [126, 186, 224], // 14 light blue (water highlight / hero)
  [255, 206, 120], // 15 glow amber
];

/** Nearest palette index for an RGB colour. `allowKey` lets index 0 win (for
 *  billboard silhouettes it must not, so opaque art never turns transparent). */
function quantize(r, g, b, allowKey) {
  let best = allowKey ? 0 : 1;
  let bestDist = Infinity;
  for (let i = allowKey ? 0 : 1; i < PALETTE.length; i += 1) {
    const [pr, pg, pb] = PALETTE[i];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// --- .tic chunk plumbing ------------------------------------------------------
// Chunk header (4 bytes): [ (bank<<5)|type ][ size lo ][ size hi ][ size hi2 ].

const CHUNK_TILES = 1;
const CHUNK_CODE = 5;
const CHUNK_PALETTE = 12;
const TILE_BYTES = 32; // 8×8 pixels at 4bpp
const SHEET_COLS = 16; // tiles per sheet row
const TILE_COUNT = 256;

function parseChunks(bytes) {
  const chunks = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const type = header & 0x1f;
    const bank = (header >> 5) & 0x7;
    const size = bytes[offset + 1] | (bytes[offset + 2] << 8) | (bytes[offset + 3] << 16);
    const dataStart = offset + 4;
    chunks.push({ type, bank, size, header: bytes.slice(offset, dataStart), data: bytes.slice(dataStart, dataStart + size) });
    offset = dataStart + size;
  }
  return chunks;
}

function encodeChunk(type, bank, data) {
  const header = Buffer.alloc(4);
  header[0] = ((bank & 0x7) << 5) | (type & 0x1f);
  header[1] = data.length & 0xff;
  header[2] = (data.length >> 8) & 0xff;
  header[3] = (data.length >> 16) & 0xff;
  return Buffer.concat([header, Buffer.from(data)]);
}

// --- 4bpp tile read/write -----------------------------------------------------

/** Read a 4bpp pixel value from a tile sheet buffer. */
function readTilePixel(tiles, tileIndex, pixelIndex) {
  const byte = tiles[tileIndex * TILE_BYTES + (pixelIndex >> 1)] ?? 0;
  return pixelIndex & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
}

/** Write a 4bpp pixel value into a tile sheet buffer. */
function writeTilePixel(tiles, tileIndex, pixelIndex, value) {
  const at = tileIndex * TILE_BYTES + (pixelIndex >> 1);
  const byte = tiles[at] ?? 0;
  tiles[at] = pixelIndex & 1 ? (byte & 0x0f) | ((value & 0x0f) << 4) : (byte & 0xf0) | (value & 0x0f);
}

/** Blit a 32×32 RGBA image into the 4 rows × 4 cols of tiles at `blockBase`.
 *  Transparent (alpha 0) → index 0; opaque → nearest non-key palette index. */
function bakeBlock(tiles, blockBase, rgba) {
  for (let ty = 0; ty < 4; ty += 1) {
    for (let tx = 0; tx < 4; tx += 1) {
      const tileIndex = blockBase + ty * SHEET_COLS + tx;
      for (let ly = 0; ly < 8; ly += 1) {
        for (let lx = 0; lx < 8; lx += 1) {
          const px = tx * 8 + lx;
          const py = ty * 8 + ly;
          const o = (py * 32 + px) * 4;
          const value = rgba[o + 3] < 128 ? 0 : quantize(rgba[o], rgba[o + 1], rgba[o + 2], false);
          writeTilePixel(tiles, tileIndex, ly * 8 + lx, value);
        }
      }
    }
  }
}

/** Decode a 32×32 block out of an OLD tile sheet (its own palette) to RGBA, then
 *  re-quantise it into the NEW palette in place on `dstTiles`. Keeps a billboard's
 *  silhouette across the palette swap (index 0 stays transparent). */
function requantiseBlock(srcTiles, dstTiles, blockBase, oldPalette) {
  for (let ty = 0; ty < 4; ty += 1) {
    for (let tx = 0; tx < 4; tx += 1) {
      const tileIndex = blockBase + ty * SHEET_COLS + tx;
      for (let p = 0; p < 64; p += 1) {
        const idx = readTilePixel(srcTiles, tileIndex, p);
        if (idx === 0) {
          writeTilePixel(dstTiles, tileIndex, p, 0); // stays transparent
          continue;
        }
        const [r, g, b] = oldPalette[idx] ?? [0, 0, 0];
        writeTilePixel(dstTiles, tileIndex, p, quantize(r, g, b, false));
      }
    }
  }
}

// --- Library art → 32×32 RGBA -------------------------------------------------

/** Load a library sprite id as a 32×32 RGBA block. Tiles a 16×16 terrain tile
 *  2×2 to fill the block seamlessly; copies a 32×32 sprite as-is; nearest-scales
 *  anything else. */
function loadBlockRgba(assetId) {
  const png = decodePng(readFileSync(join(libraryDir, "sprites", `${assetId}.png`)));
  const out = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const sx = png.width === 32 ? x : png.width === 16 ? x % 16 : Math.floor((x * png.width) / 32);
      const sy = png.height === 32 ? y : png.height === 16 ? y % 16 : Math.floor((y * png.height) / 32);
      const s = (sy * png.width + sx) * 4;
      const o = (y * 32 + x) * 4;
      out[o] = png.data[s];
      out[o + 1] = png.data[s + 1];
      out[o + 2] = png.data[s + 2];
      out[o + 3] = png.data[s + 3];
    }
  }
  return out;
}

// --- Block assignments (the world sidecar references these ids) ---------------
// Block-row 0 (0,4,8,12): terrain. Block-row 1 (64,68,72,76): nature props.
// Block-row 2 (128,132,136,140): hero frames + villager — KEPT from the old cart.
// Block-row 3 (192,196,200,204): structure props.

const TERRAIN_BLOCKS = { grass: 0, dirt: 4, water: 8, flowers: 12 };
const PROP_BLOCKS = {
  pine: 64, oak: 68, rock: 72, bush: 76,
  house: 192, well: 196, lantern: 200, fence: 204,
};
const HERO_BLOCKS = [128, 132, 136, 140]; // frame0, frame1, frame2, villager

const BAKED = [
  ["village-grass", TERRAIN_BLOCKS.grass],
  ["village-dirt-path", TERRAIN_BLOCKS.dirt],
  ["village-water", TERRAIN_BLOCKS.water],
  ["village-flowers", TERRAIN_BLOCKS.flowers],
  ["village-pine", PROP_BLOCKS.pine],
  ["village-oak", PROP_BLOCKS.oak],
  ["village-rock", PROP_BLOCKS.rock],
  ["village-bush", PROP_BLOCKS.bush],
  ["village-house", PROP_BLOCKS.house],
  ["village-well", PROP_BLOCKS.well],
  ["village-lantern", PROP_BLOCKS.lantern],
  ["village-fence", PROP_BLOCKS.fence],
];

// --- World layout (8×8), composed from the library blocks ---------------------
// Terrain map picks a block per cell; props are billboards placed at cell centres.

const GRID = 8;
const TILE_CHAR = { g: TERRAIN_BLOCKS.grass, d: TERRAIN_BLOCKS.dirt, w: TERRAIN_BLOCKS.water, f: TERRAIN_BLOCKS.flowers };
const TERRAIN_ROWS = [
  "ggggfggg",
  "gggdgggf",
  "wwgdgggg",
  "wwgddddg",
  "ggggggdg",
  "gfgggddg",
  "ggggggdg",
  "gfggggdg",
];
// Heights (village knoll top-right where the cottage sits).
const HEIGHT_ROWS = [
  "00000000",
  "00000011",
  "00000011",
  "00000000",
  "00000000",
  "00000000",
  "00000000",
  "00000000",
];

/** Prop proportions (world units) so each billboard matches its sprite's shape. */
const PROP_SIZE = {
  [PROP_BLOCKS.pine]: [1.7, 2.7], [PROP_BLOCKS.oak]: [1.8, 2.4],
  [PROP_BLOCKS.rock]: [1.1, 0.9], [PROP_BLOCKS.bush]: [1.2, 1.0],
  [PROP_BLOCKS.house]: [2.4, 2.2], [PROP_BLOCKS.well]: [1.5, 1.6],
  [PROP_BLOCKS.lantern]: [0.8, 1.8], [PROP_BLOCKS.fence]: [1.4, 1.1],
};

/** Authored scenery placements: [blockId, col, row]. */
const PLACEMENTS = [
  [PROP_BLOCKS.house, 6, 1],
  [PROP_BLOCKS.well, 4, 5],
  [PROP_BLOCKS.pine, 0, 0],
  [PROP_BLOCKS.pine, 7, 6],
  [PROP_BLOCKS.oak, 1, 6],
  [PROP_BLOCKS.oak, 6, 4],
  [PROP_BLOCKS.lantern, 3, 1],
  [PROP_BLOCKS.lantern, 5, 3],
  [PROP_BLOCKS.lantern, 6, 6],
  [PROP_BLOCKS.rock, 2, 4],
  [PROP_BLOCKS.rock, 5, 7],
  [PROP_BLOCKS.bush, 1, 2],
  [PROP_BLOCKS.bush, 7, 2],
  [PROP_BLOCKS.fence, 3, 7],
];

function heightAt(col, row) {
  return Number(HEIGHT_ROWS[row][col]) || 0;
}

function buildWorldSidecar() {
  const cells = [];
  for (let j = 0; j < GRID; j += 1) {
    for (let i = 0; i < GRID; i += 1) {
      cells.push({ h: heightAt(i, j), sprite: TILE_CHAR[TERRAIN_ROWS[j][i]] });
    }
  }
  const props = PLACEMENTS.map(([sprite, col, row]) => {
    const [width, height] = PROP_SIZE[sprite];
    return { sprite, x: col + 0.5, y: heightAt(col, row), z: row + 0.5, width, height };
  });
  const billboards = [
    { sprite: HERO_BLOCKS[0], width: 1.5, height: 2.3 },
    { sprite: HERO_BLOCKS[1], width: 1.5, height: 2.3 },
    { sprite: HERO_BLOCKS[2], width: 1.5, height: 2.3 },
    { sprite: HERO_BLOCKS[3], width: 1.4, height: 2.2 },
  ];
  return { cols: GRID, rows: GRID, tilesPerSide: 4, cells, props, billboards, camera: { yaw: 0.55, pitch: 0.5, distance: 0, fov: 0 } };
}

// --- Cart Lua -----------------------------------------------------------------
// Same hero walk + camera logic as before; only the layout, villager spot, and
// on-screen text/credits change. The world itself lives in the sidecar.

function buildCartCode() {
  return `-- OCTOPATH - CARTBOX HD-2D  (a village built from the asset library)
-- The world is real 3D: a height-mapped tile terrain and 2D-sprite scenery whose
-- art all comes from the CC0 "Village Pack" in the in-editor asset library
-- (grass/dirt/water tiles, pine & oak trees, a cottage, a well, lamp posts,
-- rocks, bushes and a fence). The hero is a depth-sorted 2D billboard walking a
-- three-frame cycle. Golden-hour sun + the post-FX stack give the HD-2D finish.
-- Art: Cartbox Village Pack (CC0-1.0).

local W,H=8,8
local px,pz=4.0,6.0
local t=0

function TIC()
 t=t+1
 local sp=0.05
 local moving=false
 if btn(0) then pz=pz-sp moving=true end
 if btn(1) then pz=pz+sp moving=true end
 if btn(2) then px=px-sp moving=true end
 if btn(3) then px=px+sp moving=true end
 if px<0 then px=0 end
 if px>W-1 then px=W-1 end
 if pz<0 then pz=0 end
 if pz>H-1 then pz=H-1 end

 cls(0)

 if cartbox then
  cartbox.clearlights()
  cartbox.sun(0.45, 0.8, 0.5, 255, 208, 150, 1.0)
  cartbox.worldcam(0.62 + math.sin(t/520) * 0.05, 0.44, 10, 0, px, 1.2, pz)
  cartbox.clearbillboards()
  local frame = 0
  if moving then frame = 1 + (math.floor(t / 8) % 2) end
  local bob = moving and math.abs(math.sin(t / 6)) * 0.06 or math.sin(t / 45) * 0.02
  for s = 0, 2 do
   if s == frame then cartbox.billboard(s, px, bob, pz, 1.35) else cartbox.billboard(s, px, 0, pz, 0) end
  end
  -- A villager standing on the raised knoll by the cottage.
  cartbox.billboard(3, 6.5, 1, 1.6, 1.1)
 end

 print("OCTOPATH . CARTBOX HD-2D", 6, 6, 15)
 print("Built from the asset library (Village Pack, CC0)", 6, 16, 13)
 print("ARROWS: explore the village", 6, 128, 14)
end`;
}

// --- Credits sidecar ----------------------------------------------------------

function buildCredits() {
  const sourcesPath = join(here, "library-sources.mts");
  const text = readFileSync(sourcesPath, "utf8");
  // Pull the ids we baked and record their one-line provenance from the registry.
  const ids = BAKED.map(([id]) => id);
  const credits = ids.map((id) => {
    // Match the registry block for this id and read its name/provenance loosely.
    const block = text.slice(text.indexOf(`id: "${id}"`));
    const name = /name:\s*"([^"]+)"/.exec(block)?.[1] ?? id;
    return { id, name, source: "Cartbox Village Pack", license: "CC0-1.0" };
  });
  return { pack: "Cartbox Village Pack", license: "CC0-1.0", assets: credits };
}

// --- Assemble -----------------------------------------------------------------

function main() {
  const original = readFileSync(join(fixtures, "hd2d-octopath.tic"));
  const chunks = parseChunks(original);

  const oldPaletteChunk = chunks.find((c) => c.type === CHUNK_PALETTE);
  if (!oldPaletteChunk) throw new Error("cart has no palette chunk");
  const oldPalette = [];
  for (let i = 0; i < 16; i += 1) {
    oldPalette.push([oldPaletteChunk.data[i * 3], oldPaletteChunk.data[i * 3 + 1], oldPaletteChunk.data[i * 3 + 2]]);
  }

  const oldTilesChunk = chunks.find((c) => c.type === CHUNK_TILES && c.bank === 0);
  if (!oldTilesChunk) throw new Error("cart has no page-0 tiles chunk");
  // Old sheet padded to a full 256 tiles so out-of-range (trimmed) tiles read 0.
  const oldTiles = new Uint8Array(TILE_COUNT * TILE_BYTES);
  oldTiles.set(oldTilesChunk.data.subarray(0, oldTiles.length));

  const newTiles = new Uint8Array(TILE_COUNT * TILE_BYTES);
  // 1) Bake every library block.
  for (const [assetId, blockBase] of BAKED) bakeBlock(newTiles, blockBase, loadBlockRgba(assetId));
  // 2) Carry the hero + villager over, re-quantised to the new palette.
  for (const blockBase of HERO_BLOCKS) requantiseBlock(oldTiles, newTiles, blockBase, oldPalette);

  const newPalette = Buffer.from(PALETTE.flat());
  const newCode = Buffer.from(buildCartCode(), "utf8");

  // Reassemble: replace palette, page-0 tiles and code; copy every other chunk.
  const out = [];
  for (const chunk of chunks) {
    if (chunk.type === CHUNK_PALETTE) out.push(encodeChunk(CHUNK_PALETTE, chunk.bank, newPalette));
    else if (chunk.type === CHUNK_TILES && chunk.bank === 0) out.push(encodeChunk(CHUNK_TILES, 0, newTiles));
    else if (chunk.type === CHUNK_CODE) out.push(encodeChunk(CHUNK_CODE, chunk.bank, newCode));
    else out.push(Buffer.concat([chunk.header, chunk.data]));
  }
  const ticBytes = Buffer.concat(out);

  writeFileSync(join(fixtures, "hd2d-octopath.tic"), ticBytes);
  writeFileSync(join(fixtures, "hd2d-octopath.world.json"), `${JSON.stringify(buildWorldSidecar())}\n`);
  writeFileSync(join(fixtures, "hd2d-octopath.credits.json"), `${JSON.stringify(buildCredits(), null, 2)}\n`);

  console.log(
    `Rebuilt hd2d-octopath: .tic ${ticBytes.length} B (was ${original.length}), ` +
      `${BAKED.length} library blocks baked, ${HERO_BLOCKS.length} billboards re-quantised.`,
  );
}

main();
