/**
 * Tests that the runtime SDK injection makes cartbox.* (including cartbox.light)
 * available in a Lua cart, and that the SDK's Lua encoder agrees with the host's
 * mailbox/lights decoder on the shared pmem layout. This is what lets a cart
 * call cartbox.light() without bundling the SDK itself.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/sdkInjection.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);
const { injectSdk, CARTBOX_SDK_LUA } = await load("../packages/player/src/sdk.ts");
const { readCartCode, seedCartridge } = await load("../packages/player/src/cartseed.ts");
const { LIGHTS_BASE, EVENT_CAPACITY, LIGHTS_CAPACITY } = await load("../packages/player/src/mailbox.ts");

const CHUNK_CODE = 5;
function buildCart(code) {
  const codeBytes = new TextEncoder().encode(code);
  const header = new Uint8Array([CHUNK_CODE, codeBytes.length & 0xff, (codeBytes.length >> 8) & 0xff, 0]);
  const out = new Uint8Array(header.length + codeBytes.length);
  out.set(header, 0);
  out.set(codeBytes, header.length);
  return out;
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test("injecting the SDK makes cartbox.light available in a Lua cart", () => {
  const cart = buildCart("function TIC() end");
  const code = readCartCode(injectSdk(cart));
  assert.ok(code.includes("cartbox"), "cartbox table should be present");
  assert.ok(code.includes("light ="), "cartbox.light should be defined");
  assert.ok(code.includes("clearlights"), "cartbox.clearlights should be defined");
  assert.ok(code.includes("function TIC() end"), "the original cart code should remain");
});

test("SDK injection and RNG seeding compose", () => {
  const cart = buildCart("function TIC() end");
  const code = readCartCode(injectSdk(seedCartridge(cart, 12345)));
  assert.ok(code.includes("math.randomseed(12345)"), "the RNG seed should be present");
  assert.ok(code.includes("cartbox"), "the SDK should be present");
});

test("non-Lua carts are left untouched", () => {
  const cart = buildCart("-- script: js\nfunction TIC() {}");
  const code = readCartCode(injectSdk(cart));
  assert.ok(!code.includes("cartbox"), "a JS cart must not get the Lua SDK");
  assert.equal(code, "-- script: js\nfunction TIC() {}");
});

test("the SDK's Lua layout matches the host decoder constants", () => {
  // These guard the two sides of the protocol against silent drift.
  assert.ok(CARTBOX_SDK_LUA.includes(`_CAP = ${EVENT_CAPACITY}`), "event ring capacity must agree");
  assert.ok(CARTBOX_SDK_LUA.includes(`_LB = _MB + ${LIGHTS_BASE}`), "lights base offset must agree");
  assert.ok(CARTBOX_SDK_LUA.includes(`_LCAP = ${LIGHTS_CAPACITY}`), "lights capacity must agree");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nsdkInjection: ${passed}/${cases.length} passed`);
