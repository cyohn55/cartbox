// Verifies the pro core's 8bpp sprites/tiles (milestone 2b). The default tilesheet
// segment now reads tile pixels at the palette bit depth (8bpp on pro), so spr()
// and map() can use all 256 palette entries instead of 16. This drives a cart that
// programs 64 palette entries, writes a distinct color into each of tile 0's 64
// pixels, and draws ONLY that sprite over a cleared screen — so the distinct-color
// count reflects the sprite path alone (no primitives), isolating 2b.
//
// Usage:  node packages/engine/examples/verify-pro-sprites.mjs [--ppm out.ppm]
// Exit:   0 on success, non-zero if the engine is missing or the sprite shows <= 16 colors.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLuaCart } from "./sample-cart.mjs";

const PRO_WIDTH = 640;
const PRO_HEIGHT = 360;
const FRAMEBUFFER_BYTES = PRO_WIDTH * PRO_HEIGHT * 4;
const CLASSIC_MAX_COLORS = 16;
const WARMUP_FRAMES = 3;

// VRAM palette follows the 8bpp screen (640*360); the tiles bank follows VRAM
// (TIC_VRAM_SIZE = 256KB). One byte per palette channel and per tile pixel.
const PALETTE_ADDR = PRO_WIDTH * PRO_HEIGHT; // 0x38400
const TILES_ADDR = 256 * 1024; // 0x40000
const TILE_PIXELS = 64; // an 8x8 tile

const CODE = [
  "function BOOT()",
  ` for i=0,${TILE_PIXELS - 1} do`,
  `  poke(${PALETTE_ADDR}+i*3,(i*4)%256)`,
  `  poke(${PALETTE_ADDR}+i*3+1,(i*7+40)%256)`,
  `  poke(${PALETTE_ADDR}+i*3+2,(255-i*4)%256)`,
  `  poke(${TILES_ADDR}+i, i)`, // tile 0 pixel i -> color i
  " end",
  "end",
  "function TIC()",
  " cls(0)",
  " spr(0,224,52,-1,24)", // tile 0 only, scaled 24x
  "end",
].join("\n");

const enginePath = fileURLToPath(new URL("../dist/pro/engine.js", import.meta.url));
if (!existsSync(enginePath)) {
  console.error(`Pro engine not built: ${enginePath}`);
  console.error("Run `npm run engine:build:pro` first.");
  process.exit(1);
}

const ppmIndex = process.argv.indexOf("--ppm");
const ppmOut = ppmIndex !== -1 ? process.argv[ppmIndex + 1] : null;

const mod = await (await import(pathToFileURL(enginePath).href)).default();

const cart = buildLuaCart(CODE);
const handle = mod._cbx_create(44100);
if (handle === 0) {
  console.error("cbx_create returned null");
  process.exit(1);
}

const ptr = mod._malloc(cart.byteLength);
mod.HEAPU8.set(cart, ptr);
mod._cbx_load(handle, ptr, cart.byteLength);
mod._free(ptr);

for (let i = 0; i < WARMUP_FRAMES; i++) mod._cbx_tick(handle, 0);

const screenPtr = mod._cbx_screen_ptr(handle);
const fb = mod.HEAPU8.subarray(screenPtr, screenPtr + FRAMEBUFFER_BYTES);

const colors = new Set();
for (let i = 0; i < fb.length; i += 4) {
  colors.add((fb[i] << 16) | (fb[i + 1] << 8) | fb[i + 2]);
}

console.log(`sprite tile:       tile 0, ${TILE_PIXELS} pixels of colors 0..${TILE_PIXELS - 1}`);
console.log(`distinct colors:   ${colors.size}`);

if (ppmOut) {
  const totalPixels = FRAMEBUFFER_BYTES / 4;
  const rgb = Buffer.alloc(totalPixels * 3);
  for (let p = 0; p < totalPixels; p++) {
    rgb[p * 3] = fb[p * 4];
    rgb[p * 3 + 1] = fb[p * 4 + 1];
    rgb[p * 3 + 2] = fb[p * 4 + 2];
  }
  writeFileSync(ppmOut, Buffer.concat([Buffer.from(`P6\n${PRO_WIDTH} ${PRO_HEIGHT}\n255\n`, "ascii"), rgb]));
  console.log(`wrote ${ppmOut}`);
}

mod._cbx_delete(handle);

// Background (1 color) + a 4bpp sprite could contribute at most 16 more. Require
// well beyond that: the sprite alone must present many colors from its 8bpp tile.
if (colors.size > CLASSIC_MAX_COLORS) {
  console.log(`PASS — 8bpp sprite rendered ${colors.size} colors (> ${CLASSIC_MAX_COLORS}); spr()/map() honor 256 colors.`);
  process.exit(0);
}
console.error(`FAIL — only ${colors.size} colors; the sprite path is not reading 8bpp tiles.`);
process.exit(2);
