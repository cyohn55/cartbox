// Build a real multi-frame .aseprite animation for verifying multi-frame import.
// Four 8x8 indexed frames, each a solid distinct colour, using uncompressed
// (raw) cels — which also exercises the parser's raw-cel + multi-frame paths.
//
// Run: node scripts/make-anim-aseprite.mjs [outPath]

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

class Writer {
  bytes = [];
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); }
  u32(v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff); }
  zeros(n) { for (let i = 0; i < n; i += 1) this.bytes.push(0); }
  raw(a) { for (const b of a) this.bytes.push(b & 0xff); }
  patchU32(o, v) { this.bytes[o] = v & 0xff; this.bytes[o + 1] = (v >> 8) & 0xff; this.bytes[o + 2] = (v >> 16) & 0xff; this.bytes[o + 3] = (v >> 24) & 0xff; }
  bytesOut() { return Uint8Array.from(this.bytes); }
}

function chunk(type, body) {
  const w = new Writer();
  w.u32(body.length + 6);
  w.u16(type);
  w.raw(body);
  return w.bytesOut();
}

const palette = [
  [26, 28, 44], // 0 transparent
  [177, 62, 83], // 1
  [56, 183, 100], // 2
  [64, 121, 255], // 3
  [255, 205, 117], // 4
];
const SIZE = 8;
const FRAMES = 4;

function paletteChunk() {
  const b = new Writer();
  b.u32(palette.length);
  b.u32(0);
  b.u32(palette.length - 1);
  b.zeros(8);
  for (const [r, g, bl] of palette) { b.u16(0); b.u8(r); b.u8(g); b.u8(bl); b.u8(255); }
  return chunk(0x2019, b.bytesOut());
}

function layerChunk() {
  const b = new Writer();
  b.u16(0x01); b.u16(0); b.u16(0); b.u16(0); b.u16(0); b.u16(0); b.u8(255); b.zeros(3);
  const name = new TextEncoder().encode("Anim");
  b.u16(name.length); b.raw(name);
  return chunk(0x2004, b.bytesOut());
}

function rawCelChunk(colorIndex) {
  const b = new Writer();
  b.u16(0); b.u16(0); b.u16(0); b.u8(255); b.u16(0); b.u16(0); b.zeros(5);
  b.u16(SIZE); b.u16(SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) b.u8(colorIndex);
  return chunk(0x2005, b.bytesOut());
}

const file = new Writer();
const fileSizeOffset = file.bytes.length;
file.u32(0); // patched
file.u16(0xa5e0); file.u16(FRAMES); file.u16(SIZE); file.u16(SIZE); file.u16(8);
file.u32(0); file.u16(0); file.u32(0); file.u32(0); file.u8(0); file.zeros(3);
file.u16(palette.length); file.u8(1); file.u8(1); file.u16(0); file.u16(0); file.u16(16); file.u16(16);
file.zeros(84);

for (let frame = 0; frame < FRAMES; frame += 1) {
  const chunks = frame === 0
    ? [paletteChunk(), layerChunk(), rawCelChunk(frame + 1)]
    : [rawCelChunk(frame + 1)];
  const frameSizeOffset = file.bytes.length;
  file.u32(0); // patched
  file.u16(0xf1fa);
  file.u16(chunks.length);
  file.u16(120); // 120ms per frame
  file.zeros(2);
  file.u32(chunks.length);
  for (const c of chunks) file.raw(c);
  file.patchU32(frameSizeOffset, file.bytes.length - frameSizeOffset);
}
file.patchU32(fileSizeOffset, file.bytes.length);

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? path.resolve(here, "anim.aseprite");
writeFileSync(out, file.bytesOut());
console.log(`Wrote ${file.bytes.length} bytes, ${FRAMES} frames -> ${out}`);
