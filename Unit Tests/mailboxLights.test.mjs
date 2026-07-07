/**
 * Tests the cart→host lights protocol (packages/player/src/mailbox.ts). Encodes
 * lights exactly as the cartbox SDK Lua does, then decodes them, proving the two
 * halves agree — and that lights and platform events share the 64-word mailbox
 * window without stepping on each other.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" \
 *        "Unit Tests/mailboxLights.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mailboxPath = path.resolve(here, "../packages/player/src/mailbox.ts");
const {
  decodeLights, decodeMailbox,
  MAILBOX_WORDS, EVENT_CAPACITY, LIGHTS_BASE, LIGHTS_CAPACITY, LIGHT_STRIDE,
  MAILBOX_TYPE_SCORE,
} = await import(pathToFileURL(mailboxPath).href);

// --- mirror of the SDK's Lua encoders (sdk/cartbox.lua) ---
const EVENT_BASE = 0;
function writeLight(words, index, light) {
  const base = LIGHTS_BASE + 1 + index * LIGHT_STRIDE;
  words[base] = Math.trunc(light.x);
  words[base + 1] = Math.trunc(light.y);
  words[base + 2] = Math.trunc(light.z ?? 12);
  words[base + 3] = Math.trunc(light.radius);
  words[base + 4] = (((light.r ?? 255) & 0xff) << 16) | (((light.g ?? 255) & 0xff) << 8) | ((light.b ?? 255) & 0xff);
  words[base + 5] = Math.trunc((light.intensity ?? 1) * 256);
  words[LIGHTS_BASE] = index + 1; // publish the count
}
function emitEvent(words, kind, id, value) {
  const seq = words[EVENT_BASE];
  const base = 1 + (seq % EVENT_CAPACITY) * 3;
  words[base] = kind;
  words[base + 1] = id;
  words[base + 2] = value;
  words[EVENT_BASE] = seq + 1;
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
const near = (a, b) => Math.abs(a - b) < 1e-6;

test("the lights block fits inside the reserved window", () => {
  const lastWord = LIGHTS_BASE + 1 + (LIGHTS_CAPACITY - 1) * LIGHT_STRIDE + (LIGHT_STRIDE - 1);
  assert.ok(lastWord < MAILBOX_WORDS, `last light word ${lastWord} must be < ${MAILBOX_WORDS}`);
  assert.equal(LIGHTS_BASE, 1 + EVENT_CAPACITY * 3); // just past the event ring
});

test("no lights decodes to an empty list", () => {
  assert.deepEqual(decodeLights(new Uint32Array(MAILBOX_WORDS)), []);
});

test("a light round-trips through encode -> decode", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeLight(words, 0, { x: 120, y: 68, z: 14, radius: 90, r: 255, g: 180, b: 90, intensity: 1.5 });
  const [light] = decodeLights(words);
  assert.equal(light.x, 120);
  assert.equal(light.y, 68);
  assert.equal(light.z, 14);
  assert.equal(light.radius, 90);
  assert.ok(near(light.color[0], (255 / 255) * 1.5));
  assert.ok(near(light.color[1], (180 / 255) * 1.5));
  assert.ok(near(light.color[2], (90 / 255) * 1.5));
});

test("intensity defaults and white colour survive", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeLight(words, 0, { x: 1, y: 2, radius: 10 }); // defaults: white, intensity 1, z 12
  const [light] = decodeLights(words);
  assert.equal(light.z, 12);
  assert.deepEqual(light.color, [1, 1, 1]);
});

test("multiple lights decode in order", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeLight(words, 0, { x: 10, y: 10, radius: 40 });
  writeLight(words, 1, { x: 200, y: 40, radius: 60, r: 120, g: 200, b: 255 });
  const lights = decodeLights(words);
  assert.equal(lights.length, 2);
  assert.equal(lights[0].x, 10);
  assert.equal(lights[1].x, 200);
});

test("the light count is clamped to capacity", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  words[LIGHTS_BASE] = LIGHTS_CAPACITY + 5; // a buggy/oversized count
  const lights = decodeLights(words);
  assert.equal(lights.length, LIGHTS_CAPACITY);
});

test("events and lights coexist in the same window without interfering", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  emitEvent(words, MAILBOX_TYPE_SCORE, 0, 4200);
  emitEvent(words, MAILBOX_TYPE_SCORE, 0, 4300);
  writeLight(words, 0, { x: 33, y: 44, radius: 55 });

  const { events, seq } = decodeMailbox(words, 0);
  assert.equal(seq, 2);
  assert.equal(events.length, 2);
  assert.equal(events[0].value, 4200);
  assert.equal(events[1].value, 4300);

  const lights = decodeLights(words);
  assert.equal(lights.length, 1);
  assert.equal(lights[0].x, 33);
  assert.equal(lights[0].radius, 55);
});

test("clearing lights (count 0) hides stale records", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeLight(words, 0, { x: 9, y: 9, radius: 9 });
  words[LIGHTS_BASE] = 0; // cartbox.clearlights()
  assert.deepEqual(decodeLights(words), []);
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nmailboxLights: ${passed}/${cases.length} passed`);
