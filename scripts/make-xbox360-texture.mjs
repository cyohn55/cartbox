/**
 * Generate the Xbox 360 foundry starter's surface texture as a PNG, printed as
 * base64.
 *
 *   node scripts/make-xbox360-texture.mjs
 *
 * The 360 tier has no fixed-function ceiling to reproduce, so this texture is not
 * about an artefact — it is about the era's *art direction*. The 360 generation's
 * signature was the desaturated, high-detail "brown-and-grey" realism of Gears of
 * War and its imitators: scuffed concrete and oxidised metal, rendered sharp
 * because the tier had the fill rate and the texture budget for it. So this is
 * 128x128 (four times the PS1/N64 page), high-contrast, and deliberately gritty:
 * the runtime does not downsample it, so the detail survives to the screen.
 *
 * Indexed, 8-bit, one IDAT — same compact envelope as the PS1/N64 generators.
 */

import { deflateSync } from "node:zlib";

const SIZE = 128;

function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Fractal noise: several octaves, for grime that has detail at every scale. */
function fbm(x, y) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < 4; o += 1) {
    sum += smoothNoise(x * freq, y * freq) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

/**
 * Four surfaces — concrete, dark grout, rusted steel, rust bloom — each with
 * eight grain steps: a 32-entry CLUT. The palette is desaturated on purpose;
 * the only chroma is the oxidised-orange rust, exactly where the era let colour
 * in.
 */
const BASE = [
  [128, 126, 120], // concrete
  [58, 57, 54], // grout / recess
  [96, 92, 86], // steel
  [120, 78, 48], // rust
];
const GRAIN_STEPS = 8;

const palette = [];
for (const [r, g, b] of BASE) {
  for (let step = 0; step < GRAIN_STEPS; step += 1) {
    // Wide spread (+/-28): high contrast is the point — sharp scuffs and edges.
    const shift = (step - (GRAIN_STEPS - 1) / 2) * 8;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v + shift)));
    palette.push([clamp(r), clamp(g), clamp(b)]);
  }
}

/** Which of the four surfaces a texel belongs to. */
function surface(x, y) {
  // A 64px panel grid with a 3px recessed grout line — hard machined edges.
  const gx = x % 64;
  const gy = y % 64;
  if (gx < 3 || gy < 3) return 1;
  // Bolt heads in each panel's corners.
  const rx = Math.min(gx, 64 - gx);
  const ry = Math.min(gy, 64 - gy);
  if (rx > 5 && rx < 11 && ry > 5 && ry < 11) return 2;
  // Rust blooming out of the grout and around the bolts, driven by grime.
  const grime = fbm(x / 18, y / 18);
  if ((gx < 8 || gy < 8 || (rx < 15 && ry < 15)) && grime > 0.55) return 3;
  // Streaks of exposed steel where the concrete has spalled away.
  if (grime > 0.72) return 2;
  return 0;
}

// --- PNG assembly (indexed, 8-bit, one IDAT) ---------------------------------
const raw = Buffer.alloc(SIZE * (SIZE + 1));
let p = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    const grain = Math.floor(fbm(x / 2.2, y / 2.2) * GRAIN_STEPS * 1.4);
    raw[p++] = surface(x, y) * GRAIN_STEPS + Math.max(0, Math.min(GRAIN_STEPS - 1, grain));
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 3; // colour type: indexed
const plte = Buffer.from(palette.flat());

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("PLTE", plte),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const base64 = png.toString("base64");
console.error(
  `${SIZE}x${SIZE} indexed PNG, ${palette.length}-entry CLUT: ${png.length} bytes, ${base64.length} base64 chars`,
);
process.stdout.write(base64);
