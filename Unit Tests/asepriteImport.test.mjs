/**
 * Unit tests for the Aseprite import/export codec.
 *
 * - parseAseprite is exercised against a hand-assembled, uncompressed (raw-cel)
 *   `.aseprite` byte buffer, so the parser is validated against a real binary
 *   layout it did not produce itself. Expected RGBA values are derived from the
 *   palette placed in that buffer — no colours are hard-coded past the input.
 * - encodeAseprite -> parseAseprite is a full round trip through the zlib cel
 *   path: a known indexed image is encoded, re-parsed, and every pixel compared
 *   back to the palette it should resolve to.
 * - Error paths (non-Aseprite bytes, mismatched index count) are asserted.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/asepriteImport.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const importPath = path.resolve(here, "../packages/editor/src/model/asepriteImport.ts");
const exportPath = path.resolve(here, "../packages/editor/src/model/asepriteExport.ts");
const { parseAseprite } = await import(pathToFileURL(importPath).href);
const { encodeAseprite } = await import(pathToFileURL(exportPath).href);

let passed = 0;

/** Minimal growable little-endian writer for assembling test input bytes. */
class TestWriter {
  bytes = [];
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
  }
  u32(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }
  zeros(n) {
    for (let i = 0; i < n; i += 1) this.bytes.push(0);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  patchU32(offset, v) {
    this.bytes[offset] = v & 0xff;
    this.bytes[offset + 1] = (v >> 8) & 0xff;
    this.bytes[offset + 2] = (v >> 16) & 0xff;
    this.bytes[offset + 3] = (v >> 24) & 0xff;
  }
  toBytes() {
    return Uint8Array.from(this.bytes);
  }
}

/** Wrap a chunk body with its 6-byte size+type header. */
function chunk(type, body) {
  const w = new TestWriter();
  w.u32(body.length + 6);
  w.u16(type);
  w.raw(body);
  return w.toBytes();
}

/**
 * Build an indexed, single-frame `.aseprite` with an uncompressed (raw) cel that
 * fills the whole canvas — the branch encodeAseprite never emits, so parsing it
 * proves the reader handles real files, not just its own writer's output.
 */
function buildRawIndexedFile({ width, height, palette, indices, transparentIndex }) {
  // New palette chunk (0x2019).
  const pal = new TestWriter();
  pal.u32(palette.length); // new size
  pal.u32(0); // first index
  pal.u32(palette.length - 1); // last index
  pal.zeros(8);
  for (const [r, g, b] of palette) {
    pal.u16(0); // flags
    pal.u8(r);
    pal.u8(g);
    pal.u8(b);
    pal.u8(255); // alpha
  }

  // Layer chunk (0x2004).
  const layer = new TestWriter();
  layer.u16(0x01); // visible
  layer.u16(0); // normal image layer
  layer.u16(0); // child level
  layer.u16(0); // default w
  layer.u16(0); // default h
  layer.u16(0); // blend normal
  layer.u8(255); // opacity
  layer.zeros(3);
  const name = new TextEncoder().encode("L");
  layer.u16(name.length);
  layer.raw(name);

  // Raw cel chunk (0x2005, cel type 0).
  const cel = new TestWriter();
  cel.u16(0); // layer index
  cel.u16(0); // x (0)
  cel.u16(0); // y (0)
  cel.u8(255); // opacity
  cel.u16(0); // cel type: raw
  cel.u16(0); // z-index
  cel.zeros(5);
  cel.u16(width);
  cel.u16(height);
  cel.raw(indices); // one index byte per pixel

  const chunks = [
    chunk(0x2019, pal.toBytes()),
    chunk(0x2004, layer.toBytes()),
    chunk(0x2005, cel.toBytes()),
  ];

  const file = new TestWriter();
  // Header (128 bytes).
  const fileSizeOffset = file.bytes.length;
  file.u32(0); // patched
  file.u16(0xa5e0); // magic
  file.u16(1); // frames
  file.u16(width);
  file.u16(height);
  file.u16(8); // colour depth: indexed
  file.u32(0); // flags
  file.u16(0); // speed
  file.u32(0);
  file.u32(0);
  file.u8(transparentIndex);
  file.zeros(3);
  file.u16(palette.length);
  file.u8(1);
  file.u8(1);
  file.u16(0); // grid x
  file.u16(0); // grid y
  file.u16(16);
  file.u16(16);
  file.zeros(84);

  // Frame header (16 bytes).
  const frameSizeOffset = file.bytes.length;
  file.u32(0); // patched
  file.u16(0xf1fa); // frame magic
  file.u16(chunks.length); // old chunk count
  file.u16(0); // duration
  file.zeros(2);
  file.u32(chunks.length); // new chunk count
  for (const c of chunks) file.raw(c);

  file.patchU32(frameSizeOffset, file.bytes.length - frameSizeOffset);
  file.patchU32(fileSizeOffset, file.bytes.length);
  return file.toBytes();
}

/** Expected straight-alpha RGBA for an indexed pixel resolved through a palette. */
function expectedRgba(index, palette, transparentIndex) {
  if (index === transparentIndex) return [0, 0, 0, 0];
  const [r, g, b] = palette[index];
  return [r, g, b, 255];
}

// 1. Parse a hand-built raw-cel indexed file and check pixels + palette.
{
  const palette = [
    [10, 20, 30], // 0: transparent slot
    [255, 0, 0], // 1: red
    [0, 255, 0], // 2: green
    [0, 0, 255], // 3: blue
  ];
  const indices = Uint8Array.from([1, 2, 3, 0]); // 2x2: red, green, blue, transparent
  const bytes = buildRawIndexedFile({ width: 2, height: 2, palette, indices, transparentIndex: 0 });

  const doc = await parseAseprite(bytes);
  assert.equal(doc.width, 2);
  assert.equal(doc.height, 2);
  assert.equal(doc.colorDepth, 8);
  assert.equal(doc.frames.length, 1);
  assert.equal(doc.layerCount, 1);
  assert.deepEqual(doc.palette, palette);

  const pixels = doc.frames[0].pixels;
  for (let i = 0; i < indices.length; i += 1) {
    const [r, g, b, a] = expectedRgba(indices[i], palette, 0);
    assert.equal(pixels[i * 4], r, `pixel ${i} red`);
    assert.equal(pixels[i * 4 + 1], g, `pixel ${i} green`);
    assert.equal(pixels[i * 4 + 2], b, `pixel ${i} blue`);
    assert.equal(pixels[i * 4 + 3], a, `pixel ${i} alpha`);
  }
  passed += 1;
}

// 2. Round trip: encode an indexed image (zlib cel) then parse it back exactly.
{
  const palette = [
    [0, 0, 0], // 0: transparent
    [240, 32, 48],
    [32, 200, 96],
    [48, 96, 240],
    [255, 220, 120],
  ];
  const width = 4;
  const height = 3;
  // A deterministic pattern touching every palette index, no hard-coded RGBA.
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i += 1) indices[i] = i % palette.length;

  const encoded = await encodeAseprite({ width, height, palette, indices, transparentIndex: 0 });
  assert.ok(encoded.length > 128, "encoded file should exceed the header size");
  // Header magic bytes 0xA5E0 (little-endian) at offset 4.
  assert.equal(encoded[4], 0xe0);
  assert.equal(encoded[5], 0xa5);

  const doc = await parseAseprite(encoded);
  assert.equal(doc.width, width);
  assert.equal(doc.height, height);
  assert.equal(doc.colorDepth, 8);
  assert.deepEqual(doc.palette, palette);

  const pixels = doc.frames[0].pixels;
  for (let i = 0; i < indices.length; i += 1) {
    const [r, g, b, a] = expectedRgba(indices[i], palette, 0);
    assert.deepEqual(
      [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2], pixels[i * 4 + 3]],
      [r, g, b, a],
      `round-trip pixel ${i}`,
    );
  }
  passed += 1;
}

// 3. A hidden layer contributes nothing to the composite.
{
  const palette = [
    [0, 0, 0],
    [200, 0, 0],
  ];
  const bytes = buildRawIndexedFile({
    width: 1,
    height: 1,
    palette,
    indices: Uint8Array.from([1]),
    transparentIndex: 0,
  });
  // Flip the visible bit (0x01) of the single layer chunk to hidden.
  // Locate the layer chunk by its type marker 0x2004 and clear the flags word.
  let cleared = false;
  for (let i = 128; i < bytes.length - 8; i += 1) {
    if (bytes[i + 4] === 0x04 && bytes[i + 5] === 0x20) {
      bytes[i + 6] = 0x00; // low byte of the flags word after the 6-byte chunk header
      bytes[i + 7] = 0x00;
      cleared = true;
      break;
    }
  }
  assert.ok(cleared, "found and cleared the layer visibility flag");
  const doc = await parseAseprite(bytes);
  assert.deepEqual([...doc.frames[0].pixels], [0, 0, 0, 0], "hidden layer draws nothing");
  passed += 1;
}

// 4. Non-Aseprite bytes are rejected.
{
  await assert.rejects(() => parseAseprite(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])), /not an aseprite/i);
  passed += 1;
}

// 5. encodeAseprite rejects an index count that disagrees with the canvas.
{
  await assert.rejects(
    () => encodeAseprite({ width: 2, height: 2, palette: [[0, 0, 0]], indices: new Uint8Array(3) }),
    /does not match/i,
  );
  passed += 1;
}

console.log(`PASS — aseprite codec: ${passed} checks green.`);
