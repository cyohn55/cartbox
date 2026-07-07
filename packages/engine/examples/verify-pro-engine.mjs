// Verifies the built "pro" core end-to-end: loads a real cartridge, ticks it,
// and confirms the 640x360 framebuffer contains rendered content. Same cbx_*
// contract and sample cart as verify-engine.mjs; only the engine path and the
// framebuffer dimensions differ (the pro core's fixed spec). A classic-authored
// cart renders into the top-left region and its cls() fills the full pro screen,
// which is enough to prove the larger framebuffer is produced and blittable.
//
// Usage:  node packages/engine/examples/verify-pro-engine.mjs [--ppm out.ppm]
// Exit:   0 on success, non-zero if the engine is missing or renders blank.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLuaCart } from "./sample-cart.mjs";

const PRO_WIDTH = 640;
const PRO_HEIGHT = 360;
const FRAMEBUFFER_BYTES = PRO_WIDTH * PRO_HEIGHT * 4;
const WARMUP_FRAMES = 30;

const enginePath = fileURLToPath(new URL("../dist/pro/engine.js", import.meta.url));
if (!existsSync(enginePath)) {
  console.error(`Pro engine not built: ${enginePath}`);
  console.error("Run `npm run engine:build:pro` first.");
  process.exit(1);
}

const ppmIndex = process.argv.indexOf("--ppm");
const ppmOut = ppmIndex !== -1 ? process.argv[ppmIndex + 1] : null;

const factoryModule = await import(pathToFileURL(enginePath).href);
const mod = await factoryModule.default();

for (const fn of ["_cbx_create", "_cbx_load", "_cbx_tick", "_cbx_screen_ptr", "_malloc", "_free"]) {
  if (typeof mod[fn] !== "function") {
    console.error(`Engine is missing export: ${fn}`);
    process.exit(1);
  }
}

const cart = buildLuaCart();
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

const totalPixels = FRAMEBUFFER_BYTES / 4;
const colors = new Set();
let nonBlack = 0;
let opaque = 0;
for (let i = 0; i < fb.length; i += 4) {
  colors.add((fb[i] << 24) | (fb[i + 1] << 16) | (fb[i + 2] << 8) | fb[i + 3]);
  if (fb[i] || fb[i + 1] || fb[i + 2]) nonBlack++;
  if (fb[i + 3] === 255) opaque++;
}

console.log(`framebuffer:       ${PRO_WIDTH}x${PRO_HEIGHT} (${FRAMEBUFFER_BYTES} bytes)`);
console.log(`distinct colors:   ${colors.size}`);
console.log(`non-black pixels:  ${((nonBlack / totalPixels) * 100).toFixed(1)}%`);
console.log(`opaque pixels:     ${((opaque / totalPixels) * 100).toFixed(1)}%`);

if (ppmOut) {
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

const passed = colors.size >= 3 && nonBlack > totalPixels * 0.02 && opaque === totalPixels;
if (passed) {
  console.log(`PASS — pro core rendered real cartridge content at ${PRO_WIDTH}x${PRO_HEIGHT}.`);
  process.exit(0);
}
console.error("FAIL — framebuffer looks blank, uniform, or non-opaque.");
process.exit(2);
