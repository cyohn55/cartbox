/**
 * Unit tests for the tile pixel codec — the bit-depth-aware packing WasmCartEngine
 * uses to read/write tile pixels in cart memory. Classic packs two 4-bit pixels
 * per byte; Pro stores one 8-bit pixel per byte. Tests drive the real codec
 * against a plain byte buffer and assert both the round-trip and the exact
 * on-disk packing (the format contract the WASM core also reads).
 *
 * Run:  node --experimental-transform-types "Unit Tests/tilePixelCodec.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../packages/editor/src/engine/tilePixelCodec.ts");
const { createTilePixelCodec } = await import(pathToFileURL(modulePath).href);

const PIXELS_PER_TILE = 64; // 8×8
let passed = 0;

// --- 8bpp (Pro): one byte per pixel, full 0..255 range ---
{
  const codec = createTilePixelCodec(8, PIXELS_PER_TILE);
  assert.equal(codec.bytesPerTile, PIXELS_PER_TILE, "8bpp tile is one byte per pixel");

  const heap = new Uint8Array(256);
  const tileBase = codec.bytesPerTile; // second tile, to prove base offset is honoured

  codec.write(heap, tileBase, 5, 63);
  assert.equal(heap[tileBase + 5], 63, "8bpp writes the raw byte at base+index");
  assert.equal(codec.read(heap, tileBase, 5), 63, "8bpp round-trips a 64-colour index");

  codec.write(heap, tileBase, 6, 200);
  assert.equal(codec.read(heap, tileBase, 5), 63, "neighbouring pixel untouched");
  assert.equal(codec.read(heap, tileBase, 6), 200, "8bpp holds values above 15");

  for (let pixel = 0; pixel < PIXELS_PER_TILE; pixel += 1) codec.write(heap, tileBase, pixel, (pixel * 3) % 256);
  for (let pixel = 0; pixel < PIXELS_PER_TILE; pixel += 1) {
    assert.equal(codec.read(heap, tileBase, pixel), (pixel * 3) % 256, `8bpp pixel ${pixel} round-trip`);
  }
  passed += 1;
}

// --- 4bpp (Classic): two pixels per byte, even=low nibble, odd=high nibble ---
{
  const codec = createTilePixelCodec(4, PIXELS_PER_TILE);
  assert.equal(codec.bytesPerTile, PIXELS_PER_TILE / 2, "4bpp packs two pixels per byte");

  const heap = new Uint8Array(128);
  const tileBase = codec.bytesPerTile;

  codec.write(heap, tileBase, 0, 0xa); // even → low nibble
  codec.write(heap, tileBase, 1, 0x5); // odd → high nibble (same byte)
  assert.equal(heap[tileBase], 0x5a, "4bpp packs even in low nibble, odd in high");
  assert.equal(codec.read(heap, tileBase, 0), 0xa, "read even pixel");
  assert.equal(codec.read(heap, tileBase, 1), 0x5, "read odd pixel");

  codec.write(heap, tileBase, 2, 0x1f); // out-of-range value is masked to 4 bits
  assert.equal(codec.read(heap, tileBase, 2), 0xf, "4bpp masks to nibble");

  for (let pixel = 0; pixel < PIXELS_PER_TILE; pixel += 1) codec.write(heap, tileBase, pixel, pixel % 16);
  for (let pixel = 0; pixel < PIXELS_PER_TILE; pixel += 1) {
    assert.equal(codec.read(heap, tileBase, pixel), pixel % 16, `4bpp pixel ${pixel} round-trip`);
  }
  passed += 1;
}

// --- unsupported depths are rejected ---
{
  assert.throws(() => createTilePixelCodec(2, PIXELS_PER_TILE), /Unsupported tile pixel depth/);
  assert.throws(() => createTilePixelCodec(6, PIXELS_PER_TILE), /Unsupported tile pixel depth/);
  passed += 1;
}

console.log(`PASS — tilePixelCodec: ${passed} checks green.`);
