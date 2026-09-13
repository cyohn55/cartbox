/**
 * Generate the PS1 starter's crate texture as a PNG, printed as base64.
 *
 * The starter needs a real compressed image: a mesh material stores its
 * base-colour texture as `EncodedImage` bytes that the browser decodes, so a
 * procedurally-filled RGBA array is not a substitute. Rather than commit a
 * binary asset, the bytes live as a base64 constant in ps1Seed.ts and this
 * script is how that constant is regenerated:
 *
 *   node scripts/make-ps1-texture.mjs
 *
 * The texture is deliberately 64x64, palettised, and busy. All three matter for
 * the era. The PS1 model is an 8-bit CLUT machine with a 64KB texture page, so
 * an indexed texture is what it would actually have held — and it happens to
 * compress to a quarter of the truecolour version, which keeps the committed
 * constant readable. Busy matters because a flat gradient would hide the two
 * artefacts the model exists to reproduce: affine warping needs straight lines
 * to bend, and unfiltered sampling needs hard texel edges to show its
 * blockiness.
 */

import { deflateSync } from "node:zlib";

const SIZE = 64;

/** Deterministic value noise, so the committed constant is reproducible. */
function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** The four surfaces, each given eight grain steps: a 32-entry CLUT. */
const BASE = [
  [96, 100, 116], // plate
  [42, 44, 54], // seam
  [148, 152, 160], // rivet
  [188, 150, 44], // hazard stripe
];
const GRAIN_STEPS = 8;

const palette = [];
for (const [r, g, b] of BASE) {
  for (let step = 0; step < GRAIN_STEPS; step += 1) {
    const shift = (step - (GRAIN_STEPS - 1) / 2) * 7;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v + shift)));
    palette.push([clamp(r), clamp(g), clamp(b)]);
  }
}

/** Which of the four surfaces a texel belongs to. */
function surface(x, y) {
  const gx = x % 32;
  const gy = y % 32;
  // A diagonal hazard stripe across one plate in four, for a strong straight
  // edge — this is the feature that visibly bends under affine interpolation.
  if ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 && (x + y) % 16 < 5) return 3;
  // Rivets near each plate's corners.
  const rx = Math.min(gx, 32 - gx);
  const ry = Math.min(gy, 32 - gy);
  if (rx > 3 && rx < 7 && ry > 3 && ry < 7) return 2;
  // Panel grid: 32px plates with a recessed 2px seam.
  if (gx < 2 || gy < 2) return 1;
  return 0;
}

// --- PNG assembly (indexed, 8-bit, one IDAT) ---------------------------------
const raw = Buffer.alloc(SIZE * (SIZE + 1));
let p = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x += 1) {
    raw[p++] = surface(x, y) * GRAIN_STEPS + Math.floor(hash(x, y) * GRAIN_STEPS);
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
