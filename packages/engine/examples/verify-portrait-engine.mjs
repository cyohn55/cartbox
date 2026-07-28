// Verifies the built "portrait" core end-to-end: loads a real cartridge, ticks
// it, and confirms the 360x640 framebuffer contains rendered content. Same cbx_*
// contract and sample cart as verify-engine.mjs / verify-pro-engine.mjs; only
// the engine path and the framebuffer dimensions differ.
//
// The dimension check is the point of this script. Portrait is the first model
// taller than it is wide, and the overscan buffer's height was derived upstream
// from its width at 16:9 — a landscape assumption that silently produced a
// 288-line buffer for a 640-line screen. A core built without the
// TIC80_FULLHEIGHT override still creates and ticks; it just renders garbage
// past line 288. So this asserts the *whole* frame is opaque and that content
// reaches the bottom of the screen, not merely that pixels exist.
//
// Usage:  node packages/engine/examples/verify-portrait-engine.mjs [--ppm out.ppm]
// Exit:   0 on success, non-zero if the engine is missing or renders wrong.

import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildLuaCart } from "./sample-cart.mjs";

const PORTRAIT_WIDTH = 360;
const PORTRAIT_HEIGHT = 640;
const FRAMEBUFFER_BYTES = PORTRAIT_WIDTH * PORTRAIT_HEIGHT * 4;
const WARMUP_FRAMES = 30;

const enginePath = fileURLToPath(new URL("../dist/portrait/engine.js", import.meta.url));
if (!existsSync(enginePath)) {
  console.error(`Portrait engine not built: ${enginePath}`);
  console.error("Run `npm run engine:build:portrait` first.");
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

/**
 * Opacity of the bottom band — the region a 16:9-derived overscan buffer would
 * never have covered. The cart's cls() fills the whole screen, so every row must
 * come back opaque; a short buffer leaves this band unwritten.
 */
const bandRows = 64;
const bandStart = (PORTRAIT_HEIGHT - bandRows) * PORTRAIT_WIDTH * 4;
let bottomOpaque = 0;
for (let i = bandStart; i < fb.length; i += 4) {
  if (fb[i + 3] === 255) bottomOpaque++;
}
const bottomPixels = bandRows * PORTRAIT_WIDTH;

console.log(`framebuffer:       ${PORTRAIT_WIDTH}x${PORTRAIT_HEIGHT} (${FRAMEBUFFER_BYTES} bytes)`);
console.log(`distinct colors:   ${colors.size}`);
console.log(`non-black pixels:  ${((nonBlack / totalPixels) * 100).toFixed(1)}%`);
console.log(`opaque pixels:     ${((opaque / totalPixels) * 100).toFixed(1)}%`);
console.log(`bottom ${bandRows} rows opaque: ${((bottomOpaque / bottomPixels) * 100).toFixed(1)}%`);

if (ppmOut) {
  const rgb = Buffer.alloc(totalPixels * 3);
  for (let p = 0; p < totalPixels; p++) {
    rgb[p * 3] = fb[p * 4];
    rgb[p * 3 + 1] = fb[p * 4 + 1];
    rgb[p * 3 + 2] = fb[p * 4 + 2];
  }
  writeFileSync(
    ppmOut,
    Buffer.concat([Buffer.from(`P6\n${PORTRAIT_WIDTH} ${PORTRAIT_HEIGHT}\n255\n`, "ascii"), rgb]),
  );
  console.log(`wrote ${ppmOut}`);
}

mod._cbx_delete(handle);

const passed =
  colors.size >= 3 &&
  nonBlack > totalPixels * 0.02 &&
  opaque === totalPixels &&
  bottomOpaque === bottomPixels;
if (passed) {
  console.log(`PASS — portrait core rendered real cartridge content at ${PORTRAIT_WIDTH}x${PORTRAIT_HEIGHT}.`);
  process.exit(0);
}
console.error("FAIL — framebuffer looks blank, uniform, non-opaque, or short of the bottom rows.");
process.exit(2);
