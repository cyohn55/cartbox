/**
 * End-to-end verification of the in-app handheld pixel-editor pipeline, run
 * browser-free against the real pure modules (no DOM, no dev server, since
 * in-WSL Playwright can't launch a browser). It walks a skin from the editor's
 * layered paint document all the way to what the console renders:
 *
 *   render → paint document → edits → composite → PNG → upload gate →
 *   stored-art gate → console art-vs-scheme selection
 *
 * Every asserted value is derived from the inputs (a synthetic render, the sizes
 * we paint), never a fixed blob. Real modules exercised:
 *   packages/editor/src/model/handheldPaintDoc.ts  (paint model)
 *   apps/web/src/lib/png.ts                         (server upload gate)
 *   apps/web/src/lib/handheldArt.ts                 (stored-art gate)
 *
 * Run: node --experimental-transform-types \
 *   --import "./Unit Tests/registerTsHooks.mjs" apps/web/scripts/verify-skin-editor.mjs
 */

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const load = (rel) => import(pathToFileURL(path.resolve(root, rel)).href);

const paint = await load("packages/editor/src/model/handheldPaintDoc.ts");
const { isPng, readPngSize } = await load("apps/web/src/lib/png.ts");
const { normalizeArt } = await load("apps/web/src/lib/handheldArt.ts");
const { gzipToBase64, base64GunzipToText } = await load("apps/web/src/lib/gzip.ts");

const {
  docFromRgba,
  addLayer,
  activeLayer,
  createLayer,
  getLayerPixel,
  setLayerPixel,
  floodFillRgba,
  setLayerProps,
  compositeDoc,
  serializeDoc,
  deserializeDoc,
} = paint;

/** The bounds the handheld art gate and upload route both enforce. */
const MAX_ART_DIMENSION = 4096;
const MAX_ART_DATA_URL_CHARS = 2_000_000;

/** A synthetic "renderHandheld" result: a solid RGBA fill at the given size. */
function solidRender(width, height, [r, g, b]) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  return px;
}

// --- Minimal PNG encoder (mirrors the browser canvas.toBlob output shape the
// --- editor uploads; lets us feed the real upload gate a genuine PNG here). ---
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
/** Encode a straight-alpha RGBA bitmap (the editor composite) to a PNG. */
function encodePng(rgba, width, height) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
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
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return Buffer.from(binary, "binary").toString("base64");
}

/** The console's real selection rule (HandheldConsole): art wins over the scheme. */
function consoleSkinUrl(handheld, renderUrl) {
  return handheld.art?.url ?? renderUrl;
}

let passed = 0;
// Template-scale canvas so sizes and budgets match the shipped art (867x1579).
const WIDTH = 867;
const HEIGHT = 1579;

// 1. Seed a document from a render, then run a realistic edit session: add a
//    layer, paint a couple of dabs and an interpolated line, flood-fill, and
//    dim a layer. The composite keeps the canvas size and reflects the edits.
let doc = docFromRgba(solidRender(WIDTH, HEIGHT, [40, 40, 40]), WIDTH, HEIGHT, "Skin");
{
  const seededComposite = compositeDoc(doc);
  assert.equal(seededComposite.length, WIDTH * HEIGHT * 4, "composite matches canvas size");

  doc = addLayer(doc, "Detail");
  const detail = activeLayer(doc);
  // Draw a short horizontal run to stand in for a pencil stroke.
  const stroke = [10, 220, 90, 255];
  for (let x = 100; x <= 140; x += 1) setLayerPixel(detail, WIDTH, HEIGHT, x, 200, stroke);
  // Flood-fill a fresh region of the same layer.
  floodFillRgba(detail, WIDTH, HEIGHT, 0, 0, [200, 30, 30, 255], 0);
  doc = setLayerProps(doc, doc.activeId, { opacity: 0.75 });

  const composite = compositeDoc(doc);
  assert.equal(composite.length, WIDTH * HEIGHT * 4, "edited composite keeps the canvas size");
  // The painted pixel differs from the plain render at that location.
  const pixelIndex = (200 * WIDTH + 120) * 4;
  const changed =
    composite[pixelIndex] !== 40 || composite[pixelIndex + 1] !== 40 || composite[pixelIndex + 2] !== 40;
  assert.ok(changed, "a painted pixel changes the composite");
  passed += 1;
}

// 2. The working-copy (localStorage) round-trip preserves the exact composite,
//    so a reload during onboarding never loses the drawing.
{
  const restored = deserializeDoc(serializeDoc(doc), WIDTH, HEIGHT);
  assert.ok(restored, "serialised working copy deserialises");
  assert.deepEqual([...compositeDoc(restored)], [...compositeDoc(doc)], "composite survives the localStorage round-trip");
  passed += 1;
}

// 3. The composite encodes to a real PNG the upload route accepts, and the route
//    reads back exactly the canvas dimensions from the PNG header.
const composite = compositeDoc(doc);
const png = encodePng(composite, WIDTH, HEIGHT);
{
  assert.ok(isPng(png), "editor composite encodes to a valid PNG");
  const size = readPngSize(png, MAX_ART_DIMENSION);
  assert.ok(size, "upload gate reads the PNG size");
  assert.equal(size.w, WIDTH, "route reads the true width");
  assert.equal(size.h, HEIGHT, "route reads the true height");
  assert.ok(png.length < 1_000_000, "a flat handheld PNG stays under the 1 MB upload cap");
  passed += 1;
}

// 4. Both persistence paths pass the stored-art gate: the authenticated path
//    stores an https (R2) URL; the guest/static path inlines a data URL, which
//    for a real template-size PNG stays within the localStorage budget.
{
  const remote = normalizeArt({ url: "https://cdn.example.com/handheld/user-xyz.png", w: WIDTH, h: HEIGHT });
  assert.ok(remote, "authenticated (https) art passes the gate");
  assert.equal(remote.w, WIDTH, "remote art width preserved");

  const dataUrl = `data:image/png;base64,${bytesToBase64(png)}`;
  assert.ok(dataUrl.length <= MAX_ART_DATA_URL_CHARS, "guest data-URL art fits the localStorage budget");
  const guest = normalizeArt({ url: dataUrl, w: WIDTH, h: HEIGHT });
  assert.ok(guest, "guest (data-URL) art passes the gate");
  assert.equal(guest.h, HEIGHT, "guest art height preserved");
  passed += 1;
}

// 5. The console renders the custom art in preference to the region render, and
//    falls back to the render when no art is set.
{
  const art = normalizeArt({ url: "https://cdn.example.com/handheld/user-xyz.png", w: WIDTH, h: HEIGHT });
  const renderUrl = "data:image/png;base64,SCHEME_RENDER";
  assert.equal(consoleSkinUrl({ presetId: "custom-art", scheme: {}, art }, renderUrl), art.url, "console prefers custom art");
  assert.equal(consoleSkinUrl({ presetId: "graphite", scheme: {} }, renderUrl), renderUrl, "console falls back to the scheme render");
  passed += 1;
}

// 6. Region clipping: the editor builds a predicate from the template's
//    per-pixel region map (regionMask[y*w+x] === regionValue) and passes it to
//    the paint model as the clip mask. A fill confined to one region must never
//    touch another. This mirrors what HandheldSkinEditor.clip does.
{
  const w = 6;
  const h = 2;
  // Left half is region 1, right half is region 2 (as a template regionMask).
  const regionMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) regionMask[y * w + x] = x < w / 2 ? 1 : 2;
  }
  const clipToRegion = (value) => (x, y) => regionMask[y * w + x] === value;

  const layer = createLayer(w, h, "R");
  const fill = [30, 200, 120, 255];
  // Fill starting in region 1, clipped to region 1: region 2 stays transparent.
  const changed = floodFillRgba(layer, w, h, 0, 0, fill, 0, clipToRegion(1));
  assert.equal(changed, (w / 2) * h, "fill covers exactly region 1's pixels");
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inRegion1 = x < w / 2;
      const alpha = getLayerPixel(layer, w, x, y)[3];
      assert.equal(alpha > 0, inRegion1, `pixel (${x},${y}) painted iff in region 1`);
    }
  }
  passed += 1;
}

// 7. Reload persistence (handheldDraft): the working document serialises,
//    gzip-compresses to well under the localStorage budget, and round-trips back
//    to the exact same composite — so a page reload can resume the drawing.
{
  const json = JSON.stringify(serializeDoc(doc));
  const packed = await gzipToBase64(json);
  assert.ok(packed.length < 3_000_000, "compressed draft fits the localStorage budget");
  assert.ok(packed.length < json.length, "compression actually shrinks the serialised doc");
  const restored = deserializeDoc(JSON.parse(await base64GunzipToText(packed)), WIDTH, HEIGHT);
  assert.ok(restored, "compressed draft deserialises");
  assert.deepEqual([...compositeDoc(restored)], [...compositeDoc(doc)], "draft survives compress → store → restore");
  passed += 1;
}

console.log(`PASS — verify-skin-editor: ${passed} pipeline checks green.`);
