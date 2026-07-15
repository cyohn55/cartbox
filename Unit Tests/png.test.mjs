/**
 * Unit tests for the PNG metadata gate (apps/web/src/lib/png.ts) — the header
 * reader that the handheld-art upload route uses to accept only real PNGs and to
 * learn their true dimensions without decoding attacker-supplied pixel data.
 *
 * Inputs are built by encoding real PNGs of chosen sizes (a minimal but valid
 * encoder below), so the asserted dimensions are derived from the input rather
 * than copied from a fixed blob.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/png.test.mjs"
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../apps/web/src/lib/png.ts")).href);
const { isPng, readPngSize } = mod;

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (as PNG specifies) over a byte range, table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Assemble one PNG chunk: length, type, data, CRC(type+data). */
function chunk(type, data) {
  const typeBytes = Uint8Array.from([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body), false);
  return out;
}

/** Encode a solid opaque RGBA image of the given size to a minimal valid PNG. */
function encodePng(width, height) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 already zero: compression, filter, interlace.

  // Raw scanlines: each row prefixed with filter byte 0, then width*4 RGBA bytes.
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 4;
      raw[p] = 20;
      raw[p + 1] = 120;
      raw[p + 2] = 200;
      raw[p + 3] = 255;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));

  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

let passed = 0;

// 1. A real encoded PNG is recognised and reports the exact dimensions it was
//    encoded with (dimensions derived from the chosen size, not hard-coded).
{
  for (const [w, h] of [[1, 1], [17, 4], [867, 1579]]) {
    const png = encodePng(w, h);
    assert.ok(isPng(png), `${w}x${h}: recognised as PNG`);
    const size = readPngSize(png, 4096);
    assert.ok(size, `${w}x${h}: size read`);
    assert.equal(size.w, w, `${w}x${h}: width read from IHDR`);
    assert.equal(size.h, h, `${w}x${h}: height read from IHDR`);
  }
  passed += 1;
}

// 2. Non-PNG and truncated buffers are rejected by both functions.
{
  const notPng = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]); // JPEG SOI
  assert.equal(isPng(notPng), false, "JPEG signature is not a PNG");
  assert.equal(readPngSize(notPng, 4096), null, "non-PNG has no readable size");

  const png = encodePng(8, 8);
  assert.equal(isPng(png.subarray(0, 4)), false, "a 4-byte prefix is too short to be a PNG");
  assert.equal(readPngSize(png.subarray(0, 20), 4096), null, "a header cut before the IHDR fields yields no size");
  assert.equal(readPngSize(new Uint8Array(0), 4096), null, "empty buffer yields no size");
  passed += 1;
}

// 3. Dimensions beyond the caller's cap are rejected even for a valid PNG.
{
  const png = encodePng(200, 200);
  assert.ok(readPngSize(png, 200), "size at the cap is accepted");
  assert.equal(readPngSize(png, 199), null, "size above the cap is rejected");
  passed += 1;
}

console.log(`PASS — png (upload gate): ${passed} checks green.`);
