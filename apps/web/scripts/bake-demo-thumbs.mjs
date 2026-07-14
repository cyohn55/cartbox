#!/usr/bin/env node
/**
 * Regenerates cover-art thumbnails for the demo carts under
 * public/demo/thumbs/.
 *
 * The static "demo" build has no render worker (services/render) and no object
 * storage, so the cart covers that the worker would normally produce and upload
 * are baked into the site as static PNGs instead. Each cover is rendered by the
 * exact same headless pipeline the worker uses: load the cart into the real
 * TIC-80 WASM core, advance a few frames so the title/attract screen settles,
 * capture the framebuffer, upscale, and PNG-encode it.
 *
 * The cart ids and models mirror src/lib/demoCatalog.ts and must stay in sync.
 *
 * Run from apps/web: node scripts/bake-demo-thumbs.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const webAppRoot = fileURLToPath(new URL("../", import.meta.url));
const monorepoRoot = join(webAppRoot, "..", "..");
const cartsDir = join(webAppRoot, "public", "demo", "carts");
const outputDir = join(webAppRoot, "public", "demo", "thumbs");

// Resolve the built player against this module's URL so spaces in the repo path
// survive the import (same pattern as scripts/bake-demo-carts.mjs).
const { createConsole, getModel, loadEngineModule } = await import(
  new URL("../../../packages/player/dist/index.js", import.meta.url).href
);

/** Built WASM cores, one per model (the side-by-side compatibility split). */
const ENGINE_PATHS = {
  classic: join(monorepoRoot, "packages", "engine", "dist", "tic80.js"),
  pro: join(monorepoRoot, "packages", "engine", "dist", "pro", "engine.js"),
};

/**
 * Demo carts to render, keyed by their catalog id. Upscale keeps every cover
 * near ~480–640px wide: the classic 240x136 screen doubles, the larger pro
 * 640x360 screen ships at native size.
 */
const DEMO_CARTS = [
  { id: "00000000-0000-4000-8000-000000000012", model: "pro", upscale: 1 },
  { id: "00000000-0000-4000-8000-000000000011", model: "classic", upscale: 2 },
  { id: "00000000-0000-4000-8000-000000000010", model: "pro", upscale: 1 },
  { id: "00000000-0000-4000-8000-000000000002", model: "classic", upscale: 2 },
  { id: "00000000-0000-4000-8000-000000000001", model: "classic", upscale: 2 },
];

/** Frames advanced before capture — long enough for intro animations to settle. */
const WARMUP_FRAMES = 30;
/** Neutral gamepad state (no buttons held) used while warming up. */
const NO_INPUT = 0;

/** Nearest-neighbour integer upscale, preserving crisp pixel edges. */
function upscale(rgba, width, height, factor) {
  if (factor === 1) return rgba;
  const outWidth = width * factor;
  const outHeight = height * factor;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const sourceRow = Math.floor(y / factor) * width;
    for (let x = 0; x < outWidth; x += 1) {
      const source = (sourceRow + Math.floor(x / factor)) * 4;
      const target = (y * outWidth + x) * 4;
      out[target] = rgba[source];
      out[target + 1] = rgba[source + 1];
      out[target + 2] = rgba[source + 2];
      out[target + 3] = rgba[source + 3];
    }
  }
  return out;
}

/** Encodes an RGBA buffer as a PNG (RGBA byte order matches pngjs). */
function encodePng(rgba, width, height) {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  return PNG.sync.write(png);
}

// Cores are cached per model so a batch loads each WASM build only once.
const engineCache = new Map();
async function engineFor(modelId) {
  if (!engineCache.has(modelId)) {
    const path = ENGINE_PATHS[modelId];
    engineCache.set(modelId, await loadEngineModule(pathToFileURL(path).href));
  }
  return engineCache.get(modelId);
}

mkdirSync(outputDir, { recursive: true });

let rendered = 0;
for (const { id, model: modelId, upscale: factor } of DEMO_CARTS) {
  const cartPath = join(cartsDir, `${id}.tic`);
  if (!existsSync(cartPath)) {
    console.warn(`skipped ${id}.png — cart not found: ${cartPath}`);
    continue;
  }

  const module = await engineFor(modelId);
  const model = getModel(modelId);
  const console_ = createConsole(module, model, model.sampleRate);
  try {
    const cartBytes = new Uint8Array(readFileSync(cartPath));
    if (!console_.loadCartridge(cartBytes)) {
      console.warn(`skipped ${id}.png — core rejected the cartridge`);
      continue;
    }
    for (let frame = 0; frame < WARMUP_FRAMES; frame += 1) {
      console_.tick(NO_INPUT);
    }
    const framebuffer = console_.readFramebuffer();
    const scaled = upscale(framebuffer, model.width, model.height, factor);
    const png = encodePng(scaled, model.width * factor, model.height * factor);
    writeFileSync(join(outputDir, `${id}.png`), png);
    rendered += 1;
    console.log(`rendered ${id}.png (${model.width * factor}x${model.height * factor}, ${png.byteLength} bytes)`);
  } finally {
    console_.dispose();
  }
}

console.log(`Done: ${rendered}/${DEMO_CARTS.length} demo thumbnails rendered into public/demo/thumbs/`);
