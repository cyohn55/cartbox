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
  LIGHT_KIND_POINT, LIGHT_KIND_DIRECTIONAL, LIGHT_KIND_SPOT,
  LIGHT_DIR_SCALE, LIGHT_CONE_SCALE, LIGHT_INTENSITY_SCALE,
} = await import(pathToFileURL(mailboxPath).href);

// --- mirror of the SDK's Lua encoders (sdk/cartbox.lua) ---
const EVENT_BASE = 0;
// Pack a direction component (-1..1) as the SDK's unsigned byte.
function dirByte(v) {
  let b = Math.floor(v * LIGHT_DIR_SCALE + 0.5);
  if (b < -127) b = -127; else if (b > 127) b = 127;
  return b < 0 ? b + 256 : b;
}
// The shared writer, mirroring _light() in the Lua SDK.
function writeAnyLight(words, index, kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone) {
  const base = LIGHTS_BASE + 1 + index * LIGHT_STRIDE;
  words[base] = Math.trunc(x);
  words[base + 1] = Math.trunc(y);
  words[base + 2] = Math.trunc(z);
  words[base + 3] = Math.trunc(radius);
  const rgb = (((r ?? 255) & 0xff) << 16) | (((g ?? 255) & 0xff) << 8) | ((b ?? 255) & 0xff);
  words[base + 4] = (rgb | (kind << 24) | (cone << 26)) >>> 0;
  const inten = Math.min(0xffff, Math.max(0, Math.floor((intensity ?? 1) * LIGHT_INTENSITY_SCALE)));
  words[base + 5] = (inten | (dx << 16) | (dy << 24)) >>> 0;
  words[LIGHTS_BASE] = index + 1; // publish the count
}
function writeLight(words, index, light) {
  writeAnyLight(words, index, LIGHT_KIND_POINT, light.x, light.y, light.z ?? 12, light.radius,
    light.r, light.g, light.b, light.intensity, 0, 0, 0);
}
function writeSun(words, index, light) {
  writeAnyLight(words, index, LIGHT_KIND_DIRECTIONAL, 0, 0, 0, 0, light.r, light.g, light.b,
    light.intensity, dirByte(light.dx), dirByte(light.dy), 0);
}
function writeSpot(words, index, light) {
  const cone = Math.round(Math.cos((light.halfAngleDeg * Math.PI) / 180) * LIGHT_CONE_SCALE);
  writeAnyLight(words, index, LIGHT_KIND_SPOT, light.x, light.y, light.z ?? 12, light.radius,
    light.r, light.g, light.b, light.intensity, dirByte(light.dx), dirByte(light.dy), cone);
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
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

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

test("a point light decodes with no kind or direction (back-compat)", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeLight(words, 0, { x: 5, y: 6, radius: 20 });
  const [light] = decodeLights(words);
  assert.equal(light.kind, undefined);
  assert.equal(light.direction, undefined);
  assert.equal(light.coneCos, undefined);
});

test("a directional light round-trips kind + direction", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeSun(words, 0, { dx: -0.4, dy: -0.6, r: 120, g: 140, b: 210, intensity: 0.9 });
  const [light] = decodeLights(words);
  assert.equal(light.kind, "directional");
  assert.ok(near(light.direction[0], -0.4, 1 / LIGHT_DIR_SCALE));
  assert.ok(near(light.direction[1], -0.6, 1 / LIGHT_DIR_SCALE));
  // z is derived as the positive root of a unit vector.
  const [dx, dy] = light.direction;
  assert.ok(near(light.direction[2], Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy))));
  // Intensity is stored as intensity×256 (0.9 → 230/256), so allow a quantisation margin.
  assert.ok(near(light.color[0], (120 / 255) * (230 / 256), 1e-3));
});

test("a spot light round-trips kind, axis and cone", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  writeSpot(words, 0, { x: 200, y: 20, z: 40, dx: 0.2, dy: 1, radius: 140, halfAngleDeg: 22, r: 255, g: 210, b: 150 });
  const [light] = decodeLights(words);
  assert.equal(light.kind, "spot");
  assert.equal(light.x, 200);
  assert.equal(light.radius, 140);
  assert.ok(near(light.coneCos, Math.cos((22 * Math.PI) / 180), 1 / LIGHT_CONE_SCALE));
});

test("kind and direction do not disturb colour or the coexisting event ring", () => {
  const words = new Uint32Array(MAILBOX_WORDS);
  emitEvent(words, MAILBOX_TYPE_SCORE, 0, 77);
  writeSun(words, 0, { dx: 0.5, dy: -0.5, r: 255, g: 255, b: 255, intensity: 1 });
  const { events } = decodeMailbox(words, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].value, 77);
  const [light] = decodeLights(words);
  assert.deepEqual(light.color, [1, 1, 1]);
  assert.equal(light.kind, "directional");
});

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`FAIL  ${name}\n      ${error.message}`); process.exitCode = 1; }
}
console.log(`\nmailboxLights: ${passed}/${cases.length} passed`);
