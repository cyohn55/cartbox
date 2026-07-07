/**
 * Tests the material-channel storage (packages/editor/src/engine/CartEngine.ts +
 * StubCartEngine) and the MaterialMap model. Proves each channel round-trips,
 * the four channels are independent (they live in separate banks), values are
 * clamped, getNormal/setNormal still work as the delegated "normal" channel, and
 * MaterialMap resolves levels to a greyscale ramp.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/materialMap.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);
const { StubCartEngine, MATERIAL_BANK, MATERIAL_LEVELS, BANK_COUNT } = await load("../packages/editor/src/engine/CartEngine.ts")
  .then(async (cart) => ({ ...cart, ...(await load("../packages/editor/src/engine/StubCartEngine.ts")) }));
const { MaterialMap } = await load("../packages/editor/src/model/MaterialMap.ts");

const CHANNELS = ["normal", "height", "specular", "roughness"];

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("each channel is backed by its own bank, counting down from the top", () => {
  assert.equal(MATERIAL_BANK.normal, BANK_COUNT - 1);
  assert.equal(MATERIAL_BANK.height, BANK_COUNT - 2);
  assert.equal(MATERIAL_BANK.specular, BANK_COUNT - 3);
  assert.equal(MATERIAL_BANK.roughness, BANK_COUNT - 4);
  assert.equal(MATERIAL_LEVELS, 16);
});

test("every channel round-trips a value at a pixel", () => {
  const engine = new StubCartEngine();
  for (const channel of CHANNELS) {
    engine.setMaterial(channel, 0, 5, 3, 4, 9);
    assert.equal(engine.getMaterial(channel, 0, 5, 3, 4), 9, `${channel} should read back 9`);
  }
});

test("the four channels are independent (separate banks)", () => {
  // The stub seeds a demo cart, so channels aren't zero — assert the OTHER
  // channels are unchanged after writing one, whatever they started at.
  const engine = new StubCartEngine();
  const at = [0, 1, 2, 2];
  const before = Object.fromEntries(CHANNELS.map((c) => [c, engine.getMaterial(c, ...at)]));
  const newHeight = (before.height + 5) % MATERIAL_LEVELS;
  engine.setMaterial("height", ...at, newHeight);
  assert.equal(engine.getMaterial("height", ...at), newHeight);
  for (const other of ["normal", "specular", "roughness"]) {
    assert.equal(engine.getMaterial(other, ...at), before[other], `${other} must be untouched`);
  }
});

test("values out of range are ignored", () => {
  const engine = new StubCartEngine();
  engine.setMaterial("height", 0, 0, 0, 0, 8);
  engine.setMaterial("height", 0, 0, 0, 0, MATERIAL_LEVELS); // too high
  engine.setMaterial("height", 0, 0, 0, 0, -1); // too low
  assert.equal(engine.getMaterial("height", 0, 0, 0, 0), 8, "out-of-range writes are dropped");
});

test("getNormal/setNormal delegate to the normal channel", () => {
  const engine = new StubCartEngine();
  engine.setNormal(1, 10, 6, 7, 5);
  assert.equal(engine.getNormal(1, 10, 6, 7), 5);
  assert.equal(engine.getMaterial("normal", 1, 10, 6, 7), 5, "setNormal writes the normal channel");
});

test("MaterialMap reads and writes through the engine", () => {
  const engine = new StubCartEngine();
  const height = new MaterialMap(engine, "height");
  height.setValue(0, 3, 1, 1, 12);
  assert.equal(height.getValue(0, 3, 1, 1), 12);
  assert.equal(engine.getMaterial("height", 0, 3, 1, 1), 12);
  assert.equal(height.levels, MATERIAL_LEVELS);
});

test("MaterialMap.colorHex is a greyscale ramp from black to white", () => {
  const map = new MaterialMap(new StubCartEngine(), "specular");
  assert.equal(map.colorHex(0), "#000000");
  assert.equal(map.colorHex(MATERIAL_LEVELS - 1), "#ffffff");
  // Each channel of a mid level is equal (grey) and rises with the level.
  const mid = map.colorHex(8);
  assert.match(mid, /^#([0-9a-f]{2})\1\1$/, "should be a grey (equal channels)");
  const lo = parseInt(map.colorHex(4).slice(1, 3), 16);
  const hi = parseInt(map.colorHex(12).slice(1, 3), 16);
  assert.ok(hi > lo, "brightness should rise with the level");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nmaterialMap: ${passed}/${cases.length} passed`);
