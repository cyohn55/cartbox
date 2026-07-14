/**
 * End-to-end integration test for the material G-buffer (Phase 1 + Phase 2).
 *
 * Drives the REAL TIC-80 WASM core (packages/engine/dist/tic80.js), not a mock:
 * it authors carts with known sprites and material maps via the same
 * WasmCartEngine the editor uses, runs them with material capture enabled, then
 * reads the emitted material + emissive planes (cbx_material_ptr /
 * cbx_emissive_ptr) and asserts:
 *   - authored normal/height/specular/roughness/emissive land at the exact screen
 *     pixels a sprite was drawn to, and undrawn pixels stay flat-matte;
 *   - capture off leaves the planes untouched (unlit carts pay nothing);
 *   - material persists across frames like VRAM when a cart draws without cls;
 *   - a foreign tile-bank sync suppresses capture (material is only authored for
 *     bank 0), falling back to matte instead of emitting wrong material;
 *   - textured triangles (ttri) also emit material.
 *
 * No hard-coded framebuffer offsets: every expected position/value derives from
 * the sprite's draw coordinates and the authored ramp levels.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/materialGBuffer.integration.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const enginePath = path.resolve(root, "packages/engine/dist/tic80.js");
const engineFactory = (await import(pathToFileURL(enginePath).href)).default;
const { createWasmCartEngine } = await import(
  pathToFileURL(path.resolve(root, "packages/editor/src/engine/WasmCartEngine.ts")).href
);

// Visible framebuffer dimensions of the classic core (matches the shim's planes).
const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 136;
const MATERIAL_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT * 4;
const EMISSIVE_BYTES = SCREEN_WIDTH * SCREEN_HEIGHT;

// 0..15 ramp level -> full 0..255 byte. The core uses the same *17 scaling; kept
// here independently so a drift between core and test is caught.
const rampByte = (level) => level * 17;

const SPRITE_TILE = 5; // an arbitrary sprite index we fully control
const DRAW_X = 80;
const DRAW_Y = 40;
// Distinct values per channel so a mis-wired channel fails loudly.
const PIXELS = [
  { dx: 0, dy: 0, normal: 7, height: 15, specular: 9, roughness: 3, emissive: 11 },
  { dx: 3, dy: 2, normal: 12, height: 4, specular: 15, roughness: 1, emissive: 0 },
];

// Author SPRITE_TILE's albedo + all five material channels for the PIXELS above.
function authorSprite(engine) {
  for (const p of PIXELS) {
    engine.setPixel(0, SPRITE_TILE, p.dx, p.dy, 12); // non-zero albedo
    engine.setMaterial("normal", 0, SPRITE_TILE, p.dx, p.dy, p.normal);
    engine.setMaterial("height", 0, SPRITE_TILE, p.dx, p.dy, p.height);
    engine.setMaterial("specular", 0, SPRITE_TILE, p.dx, p.dy, p.specular);
    engine.setMaterial("roughness", 0, SPRITE_TILE, p.dx, p.dy, p.roughness);
    engine.setMaterial("emissive", 0, SPRITE_TILE, p.dx, p.dy, p.emissive);
  }
}

// Build .tic bytes for a cart with the given Lua source and SPRITE_TILE authored.
function buildCart(module, code) {
  const engine = createWasmCartEngine(module);
  engine.setLanguage("lua");
  engine.setCode(code);
  authorSprite(engine);
  const bytes = engine.saveTic();
  engine.dispose();
  return bytes;
}

// Load a cart into a fresh console, run `frames` ticks, and return copies of the
// material + emissive planes.
function run(module, bytes, { capture, frames = 1 }) {
  const handle = module._cbx_create(44100);
  assert.notEqual(handle, 0, "cbx_create should return a console");

  const ptr = module._malloc(bytes.length);
  module.HEAPU8.set(bytes, ptr);
  const loaded = module._cbx_load(handle, ptr, bytes.length);
  module._free(ptr);
  assert.equal(loaded, 1, "the core should accept the authored cart");

  module._cbx_set_material_capture(handle, capture ? 1 : 0);
  for (let f = 0; f < frames; f += 1) module._cbx_tick(handle, 0);

  const matPtr = module._cbx_material_ptr(handle);
  const emisPtr = module._cbx_emissive_ptr(handle);
  const material = module.HEAPU8.slice(matPtr, matPtr + MATERIAL_BYTES);
  const emissive = module.HEAPU8.slice(emisPtr, emisPtr + EMISSIVE_BYTES);
  module._cbx_delete(handle);
  return { material, emissive };
}

const matAt = (material, x, y) => {
  const base = (y * SCREEN_WIDTH + x) * 4;
  return [material[base], material[base + 1], material[base + 2], material[base + 3]];
};
const emisAt = (emissive, x, y) => emissive[y * SCREEN_WIDTH + x];

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("authored material + emissive land at the sprite's drawn pixels", async () => {
  const module = await engineFactory();
  const bytes = buildCart(module, `function TIC() cls(0) spr(${SPRITE_TILE},${DRAW_X},${DRAW_Y},-1) end`);
  const { material, emissive } = run(module, bytes, { capture: true });

  for (const p of PIXELS) {
    const [r, g, b, a] = matAt(material, DRAW_X + p.dx, DRAW_Y + p.dy);
    assert.equal(r, p.normal, `normal index at (${p.dx},${p.dy})`);
    assert.equal(g, rampByte(p.height), `height at (${p.dx},${p.dy})`);
    assert.equal(b, rampByte(p.specular), `specular at (${p.dx},${p.dy})`);
    assert.equal(a, rampByte(p.roughness), `roughness at (${p.dx},${p.dy})`);
    assert.equal(emisAt(emissive, DRAW_X + p.dx, DRAW_Y + p.dy), rampByte(p.emissive), `emissive at (${p.dx},${p.dy})`);
  }
});

test("undrawn regions keep the flat-matte default (0,0,0,255) and emissive 0", async () => {
  const module = await engineFactory();
  const bytes = buildCart(module, `function TIC() cls(0) spr(${SPRITE_TILE},${DRAW_X},${DRAW_Y},-1) end`);
  const { material, emissive } = run(module, bytes, { capture: true });

  assert.deepEqual(matAt(material, 200, 120), [0, 0, 0, 255], "matte default away from the sprite");
  assert.equal(emisAt(emissive, 200, 120), 0, "no emission away from the sprite");
});

test("capture disabled leaves the planes untouched (unlit carts pay nothing)", async () => {
  const module = await engineFactory();
  const bytes = buildCart(module, `function TIC() cls(0) spr(${SPRITE_TILE},${DRAW_X},${DRAW_Y},-1) end`);
  const { material } = run(module, bytes, { capture: false });

  // With capture off the core never seeds or writes the planes; they stay zeroed.
  assert.deepEqual(matAt(material, DRAW_X, DRAW_Y), [0, 0, 0, 0], "no material written when capture is off");
});

test("material persists across frames like VRAM when a cart draws without cls", async () => {
  const module = await engineFactory();
  // Draw the sprite only on the first frame; never clear. VRAM keeps the pixels,
  // and material must persist alongside them rather than reverting to matte.
  const code = `t=0 function TIC() t=t+1 if t==1 then spr(${SPRITE_TILE},${DRAW_X},${DRAW_Y},-1) end end`;
  const bytes = buildCart(module, code);
  const { material } = run(module, bytes, { capture: true, frames: 3 });

  const p = PIXELS[0];
  const [r, g] = matAt(material, DRAW_X + p.dx, DRAW_Y + p.dy);
  assert.equal(r, p.normal, "normal index still present three frames after a single draw");
  assert.equal(g, rampByte(p.height), "height still present after persistence");
});

test("a foreign tile-bank sync suppresses capture (falls back to matte)", async () => {
  const module = await engineFactory();
  // Sync bank 2's tiles into RAM each frame, then draw. Material is authored only
  // for bank 0, so the guard must skip capture -> the cleared matte remains.
  const code = `function TIC() cls(0) sync(1,2) spr(${SPRITE_TILE},${DRAW_X},${DRAW_Y},-1) end`;
  const bytes = buildCart(module, code);
  const { material } = run(module, bytes, { capture: true });

  assert.deepEqual(
    matAt(material, DRAW_X, DRAW_Y),
    [0, 0, 0, 255],
    "a foreign-bank sync must leave matte, not emit bank-0 material",
  );
});

test("textured triangles (ttri) emit material", async () => {
  const module = await engineFactory();
  // A big tile-textured triangle covering the sprite's authored texel at UV (0,0),
  // which the sprite lives at (SPRITE_TILE is at sheet column SPRITE_TILE*8).
  const u0 = SPRITE_TILE * 8; // sheet u of the tile's left edge
  const code = [
    "function TIC()",
    " cls(0)",
    ` ttri(10,10, 200,10, 10,120, ${u0},0, ${u0 + 7},0, ${u0},7, 0)`,
    "end",
  ].join("\n");
  const bytes = buildCart(module, code);
  const { material } = run(module, bytes, { capture: true });

  // Somewhere inside the triangle the tile's authored pixel (0,0) is sampled; scan
  // for the authored normal index to confirm ttri wrote material at all.
  let found = false;
  for (let i = 0; i < material.length && !found; i += 4) {
    if (material[i] === PIXELS[0].normal && material[i + 1] === rampByte(PIXELS[0].height)) found = true;
  }
  assert.ok(found, "the textured triangle should have emitted the tile's authored material");
});

let passed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nmaterialGBuffer.integration: ${passed}/${cases.length} passed`);
