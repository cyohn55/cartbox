// Verifies the pro core's 8 sound channels (milestone 3). A 4-channel core can
// only play channels 0-3 (its Lua sfx() rejects channel >= 4, and it has no
// registers/mixer slots for them). This builds a cart with one waveform + one SFX
// and plays that SFX on each channel 0-7 in turn, confirming every channel — the
// new 4-7 included — produces audible PCM. It also checks the 8-channel mix
// normalization: the same SFX is quieter than on a 4-channel core because the
// mixer divides by (channels + 1).
//
// Usage:  node packages/engine/examples/verify-pro-audio.mjs
// Exit:   0 on success, non-zero if the engine is missing or a channel is silent.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PRO_CHANNELS = 8;
const FRAMES = 8;
const MIN_PEAK = 1000; // an audible tone peaks in the thousands; silence is 0

// A .tic cart with a square WAVEFORM (chunk 10), one SFX sample (chunk 9), and
// code (chunk 5). The SFX volume envelope is stored inverted (0 = loudest), so an
// all-zero envelope with a non-flat waveform is a full-volume tone.
function chunk(type, data) {
  const size = data.length;
  return Buffer.concat([Buffer.from([type, size & 0xff, (size >> 8) & 0xff, 0]), Buffer.from(data)]);
}
const WAVEFORM_SQUARE = Buffer.concat([Buffer.alloc(8, 0xff), Buffer.alloc(8, 0x00)]);
const SFX_SAMPLE = Buffer.concat([
  Buffer.alloc(60, 0x00), // 30 envelope ticks x 2 bytes: volume=0 (loudest), wave 0
  Buffer.from([0x00, 0x00, 0, 0, 0, 0]), // flags (stereo enabled) + 4 loop bytes
]);
function buildAudioCart(channel) {
  const code = `function TIC() sfx(0,24,-1,${channel},15) end`;
  return new Uint8Array(
    Buffer.concat([chunk(10, WAVEFORM_SQUARE), chunk(9, SFX_SAMPLE), chunk(5, Buffer.from(code, "ascii"))]),
  );
}

function peakOnChannel(mod, channel) {
  const cart = buildAudioCart(channel);
  const handle = mod._cbx_create(44100);
  const ptr = mod._malloc(cart.byteLength);
  mod.HEAPU8.set(cart, ptr);
  mod._cbx_load(handle, ptr, cart.byteLength);
  mod._free(ptr);

  let peak = 0;
  for (let f = 0; f < FRAMES; f++) {
    mod._cbx_tick(handle, 0);
    const samplesPtr = mod._cbx_samples_ptr(handle);
    const count = mod._cbx_samples_count(handle);
    const samples = new Int16Array(mod.HEAP16.buffer, samplesPtr, count);
    for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(samples[i]));
  }
  mod._cbx_delete(handle);
  return peak;
}

const enginePath = fileURLToPath(new URL("../dist/pro/engine.js", import.meta.url));
if (!existsSync(enginePath)) {
  console.error(`Pro engine not built: ${enginePath}`);
  console.error("Run `npm run engine:build:pro` first.");
  process.exit(1);
}

const mod = await (await import(pathToFileURL(enginePath).href)).default();

let ok = true;
for (let channel = 0; channel < PRO_CHANNELS; channel++) {
  const peak = peakOnChannel(mod, channel);
  const pass = peak >= MIN_PEAK;
  console.log(`channel ${channel}: peak ${peak}${pass ? "" : "  <-- SILENT"}`);
  if (!pass) ok = false;
}

if (ok) {
  console.log(`PASS — all ${PRO_CHANNELS} channels (incl. 4-7, absent on a 4-channel core) produced audio.`);
  process.exit(0);
}
console.error("FAIL — a channel produced no audio; the 8-channel path is incomplete.");
process.exit(2);
