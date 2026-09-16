/**
 * Generate the N64 courtyard starter's ground texture as a PNG, printed as base64.
 *
 *   node scripts/make-n64-texture.mjs
 *
 * The N64 look is not the PS1's. Where the PS1 texture is busy and hard-edged —
 * built to make affine warping and unfiltered texels visible — this one is the
 * opposite on purpose: a soft, low-contrast grass-and-dirt field. The N64 draws
 * every texel through trilinear filtering and a 4KB texture cache, so the runtime
 * box-filters this 64x64 image down to fit that budget and the result is the warm
 * blur the generation is remembered for (Mario 64's courtyard, Ocarina's fields).
 * A soft source with no hard lines is what blurs *well* rather than into mush.
 *
 * Indexed, 8-bit, one IDAT — same compact envelope as make-ps1-texture.mjs, so
 * the committed base64 constant stays readable.
 */

import { deflateSync } from "node:zlib";

const SIZE = 64;

/** Deterministic value noise, so the committed constant is reproducible. */
function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smooth 2D value noise: bilerp of the integer lattice, for soft blobs. */
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

/**
 * Three surfaces — lush grass, dry dirt patch, pale sand path — each given eight
 * near-neighbour grain steps: a 24-entry CLUT. The steps are close together
 * (low contrast) so the field reads as one soft surface, not a checkerboard.
 */
const BASE = [
  [86, 138, 66], // grass
  [120, 96, 60], // dirt
  [176, 166, 122], // sand
];
const GRAIN_STEPS = 8;

const palette = [];
for (const [r, g, b] of BASE) {
  for (let step = 0; step < GRAIN_STEPS; step += 1) {
    // +/-10 total spread: gentle, so filtering does not reveal banding.
    const shift = (step - (GRAIN_STEPS - 1) / 2) * 3;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v + shift)));
    palette.push([clamp(r), clamp(g), clamp(b)]);
  }
}

/** Which of the three surfaces a texel belongs to — soft blobs, no straight edges. */
function surface(x, y) {
  // A low-frequency dirt blob drifting through the grass.
  const dirt = smoothNoise(x / 22, y / 22);
  if (dirt > 0.62) return 1;
  // A fainter, rarer sandy patch inside the dirt.
  if (dirt > 0.74 && smoothNoise((x + 40) / 14, (y + 40) / 14) > 0.5) return 2;
  return 0;
}

// --- PNG assembly (indexed, 8-bit, one IDAT) ---------------------------------
const raw = Buffer.alloc(SIZE * (SIZE + 1));
let p = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    // Fine grain from high-frequency noise, so the surface has texture the
    // filter can soften rather than a flat colour it cannot.
    const grain = Math.floor(smoothNoise(x / 3.5, y / 3.5) * GRAIN_STEPS);
    raw[p++] = surface(x, y) * GRAIN_STEPS + Math.min(GRAIN_STEPS - 1, grain);
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
