/**
 * End-to-end verification of the mesh-camera mailbox seam through the REAL
 * rebuilt WASM core: a Lua cart calls cartbox.meshcam(...), we tick the engine,
 * read the reserved pmem back, and decode it with the host decoder. This is the
 * one test that proves the three sides — the C shim's mailbox size, the injected
 * SDK Lua's pmem writes, and mailbox.ts's decoder — all agree after the mailbox
 * grew from 64 to 72 words. The pure-TS tests can't catch a shim/SDK drift; only
 * running the actual engine can.
 *
 * Skips (does not fail) when the engine hasn't been built, so a clone/CI without
 * `npm run engine:build:wasm` stays green.
 *
 * Run: node --experimental-transform-types "Unit Tests/meshcamEngine.test.mjs"
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const enginePath = path.resolve(here, "../packages/engine/dist/tic80.js");
if (!existsSync(enginePath)) {
  console.log("meshcamEngine: SKIP (engine not built — run `npm run engine:build:wasm`)");
  process.exit(0);
}

const { injectSdk } = await load("../packages/player/src/sdk.ts");
const { decodeMeshCamera, MAILBOX_WORDS } = await load("../packages/player/src/mailbox.ts");
const { buildLuaCart } = await load("../packages/engine/examples/sample-cart.mjs");

const factory = await import(pathToFileURL(enginePath).href);
const mod = await factory.default();

// A cart that drives the mesh camera to a fixed, distinctive pose every frame.
const YAW = 1.5;
const PITCH = 0.5;
const DIST = 7;
const cart = injectSdk(buildLuaCart(`function TIC() cartbox.meshcam(${YAW}, ${PITCH}, ${DIST}) end`));

const handle = mod._cbx_create(44100);
assert.notEqual(handle, 0, "cbx_create returned null");

const ptr = mod._malloc(cart.byteLength);
mod.HEAPU8.set(cart, ptr);
assert.equal(mod._cbx_load(handle, ptr, cart.byteLength), 1, "engine rejected the cartridge");
mod._free(ptr);

for (let i = 0; i < 4; i++) mod._cbx_tick(handle, 0);

// The rebuilt shim must expose the widened mailbox; the host constant must match.
const words = mod._cbx_mailbox_words(handle);
assert.equal(words, 72, `rebuilt shim must report 72 mailbox words, got ${words}`);
assert.equal(MAILBOX_WORDS, 72, "host MAILBOX_WORDS must match the shim");

// Read the reserved pmem after ticking (ALLOW_MEMORY_GROWTH can move the heap, so
// fetch the pointer + a fresh view now) and decode the cart's published pose.
const mbPtr = mod._cbx_mailbox_ptr(handle);
const mailbox = new Uint32Array(mod.HEAPU8.buffer, mbPtr, words);
const cam = decodeMeshCamera(mailbox);

assert.ok(cam, "cart-driven mesh camera must decode as active");
assert.ok(Math.abs(cam.yaw - YAW) < 0.01, `yaw ${cam.yaw} != ${YAW}`);
assert.ok(Math.abs(cam.pitch - PITCH) < 0.01, `pitch ${cam.pitch} != ${PITCH}`);
assert.ok(cam.distance !== null && Math.abs(cam.distance - DIST) < 0.05, `distance ${cam.distance} != ${DIST}`);
assert.equal(cam.fov, null, "unset fov must decode as null (player default)");
assert.deepEqual(cam.target, [0, 0, 0], "target offset must be zero");

mod._cbx_delete(handle);
console.log("meshcamEngine: PASS — real WASM round-trips cartbox.meshcam through the widened mailbox.");
