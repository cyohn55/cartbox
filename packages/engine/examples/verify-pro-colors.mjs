// Verifies the pro core's 8bpp / 256-color framebuffer (milestone 2). The classic
// core can show at most 16 colors; this drives a cart that programs 64 palette
// entries and draws a bar in each, then confirms the rendered frame contains far
// more than 16 distinct colors — which is only possible if the framebuffer stores
// 8-bit indices and the palette/blit paths honor them.
//
// Usage:  node packages/engine/examples/verify-pro-colors.mjs [--ppm out.ppm]
// Exit:   0 on success, non-zero if the engine is missing or shows <= 16 colors.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLuaCart } from "./sample-cart.mjs";

const PRO_WIDTH = 640;
const PRO_HEIGHT = 360;
const FRAMEBUFFER_BYTES = PRO_WIDTH * PRO_HEIGHT * 4;
const BAR_COUNT = 64;
const CLASSIC_MAX_COLORS = 16;
const WARMUP_FRAMES = 3;

// The pro palette sits in VRAM immediately after the 8bpp screen
// (640*360 = 0x38400 bytes), one RGB triple per entry. The cart programs a
// gradient across the first 64 entries and fills a vertical bar in each color.
const PRO_PALETTE_ADDR = PRO_WIDTH * PRO_HEIGHT; // 0x38400
const BAR_WIDTH = PRO_WIDTH / BAR_COUNT; // 10px
const CODE = [
  "function TIC()",
  ` for i=0,${BAR_COUNT - 1} do`,
  `  poke(${PRO_PALETTE_ADDR}+i*3,(i*4)%256)`,
  `  poke(${PRO_PALETTE_ADDR}+i*3+1,(i*4+80)%256)`,
  `  poke(${PRO_PALETTE_ADDR}+i*3+2,(255-i*4)%256)`,
  `  rect(i*${BAR_WIDTH},0,${BAR_WIDTH},${PRO_HEIGHT},i)`,
  " end",
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

console.log(`bars drawn:        ${BAR_COUNT} (colors 0..${BAR_COUNT - 1})`);
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

// A 4bpp core could never exceed 16 colors; require well beyond that.
if (colors.size > CLASSIC_MAX_COLORS) {
  console.log(`PASS — pro core rendered ${colors.size} colors (> ${CLASSIC_MAX_COLORS}); 8bpp framebuffer confirmed.`);
  process.exit(0);
}
console.error(`FAIL — only ${colors.size} colors; expected > ${CLASSIC_MAX_COLORS} for an 8bpp framebuffer.`);
process.exit(2);
