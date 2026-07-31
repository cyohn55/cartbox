/**
 * Tests the gap-#7 lit-sprite code generator (Working/cinematic-artstyle/
 * litSpriteCode.ts). It turns an Assets-tab sprite (page/tile/tilesPerSide) into
 * a runnable, lit cart scaffold. The tests assert the generated code against the
 * sprite's actual inputs — the sprite id math, the block draw parameters, and the
 * light kinds emitted — rather than a memorised blob, so a real change to the
 * scaffold is caught while formatting churn is not.
 *
 * Run: node --experimental-transform-types "Unit Tests/litSpriteCode.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(here, "../apps/web/src/app/edit/[cartId]/litSpriteCode.ts");
const { litSpriteCode, spriteId, TILES_PER_PAGE, TRANSPARENT_COLOR_INDEX } =
  await import(pathToFileURL(modPath).href);

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("spriteId maps page + tile to a 0..511 TIC-80 id", () => {
  assert.equal(spriteId(0, 0), 0);
  assert.equal(spriteId(0, 3), 3);
  assert.equal(spriteId(1, 0), TILES_PER_PAGE);
  assert.equal(spriteId(1, 5), TILES_PER_PAGE + 5);
});

test("the draw uses the resolved sprite id and the block's tiles-per-side", () => {
  const code = litSpriteCode({ page: 1, tile: 4, tilesPerSide: 2 });
  assert.ok(code.includes(`local SPR = ${TILES_PER_PAGE + 4}`), "id = page*256 + tile");
  assert.ok(code.includes("local N = 2"), "N carries tilesPerSide");
  // spr(SPR, X, Y, colorkey, scale, flip, rotate, N, N) — transparent index as key.
  assert.ok(
    code.includes(`spr(SPR, X, Y, ${TRANSPARENT_COLOR_INDEX}, 1, 0, 0, N, N)`),
    "block drawn N×N tiles with the transparent colorkey",
  );
});

test("every cart resets its light set each frame", () => {
  const code = litSpriteCode({ page: 0, tile: 0, tilesPerSide: 1 });
  assert.ok(code.includes("function TIC()"), "defines TIC");
  assert.ok(code.includes("cartbox.clearlights()"), "clears lights before re-adding");
});

test("the default key is a directional sun and a point fill is added", () => {
  const code = litSpriteCode({ page: 0, tile: 8, tilesPerSide: 1 });
  assert.ok(code.includes("cartbox.sun("), "sun key by default");
  assert.ok(code.includes("cartbox.light("), "point fill by default");
});

test("key: spot swaps the sun for a cone and fill can be turned off", () => {
  const code = litSpriteCode({ page: 0, tile: 8, tilesPerSide: 1, key: "spot", fill: false });
  assert.ok(code.includes("cartbox.spot("), "spot key");
  assert.ok(!code.includes("cartbox.sun("), "no sun when key is spot");
  assert.ok(!code.includes("cartbox.light("), "no point fill when fill is off");
});

test("key: none emits no key light", () => {
  const code = litSpriteCode({ page: 0, tile: 8, tilesPerSide: 1, key: "none", fill: false });
  assert.ok(!code.includes("cartbox.sun("));
  assert.ok(!code.includes("cartbox.spot("));
});

test("an emissive sprite is called out; a plain one is not", () => {
  const emissive = litSpriteCode({ page: 0, tile: 1, tilesPerSide: 1, emissive: true });
  const plain = litSpriteCode({ page: 0, tile: 1, tilesPerSide: 1, emissive: false });
  assert.ok(emissive.includes("emissive"), "emissive sprites get a note");
  assert.ok(!plain.includes("emissive"), "plain sprites don't");
});

test("the asset name becomes a leading comment", () => {
  const code = litSpriteCode({ page: 0, tile: 1, tilesPerSide: 1, name: "Lantern" });
  assert.ok(code.startsWith("-- Lantern"), "name heads the file");
});

test("custom draw position is honoured", () => {
  const code = litSpriteCode({ page: 0, tile: 1, tilesPerSide: 1, x: 200, y: 90 });
  assert.ok(code.includes("local X, Y = 200, 90"));
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nlitSpriteCode: ${passed}/${cases.length} passed`);
