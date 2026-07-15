/**
 * Unit tests for the layered RGBA paint model
 * (packages/editor/src/model/handheldPaintDoc.ts) that backs the in-app handheld
 * pixel editor.
 *
 * Every assertion is derived from the inputs (synthetic small canvases and
 * colours built in-test), never hard-coded pixel constants, so the tests track
 * the model's behaviour rather than a snapshot.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handheldPaintDoc.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/handheldPaintDoc.ts")).href);
const {
  MAX_PAINT_LAYERS,
  createLayer,
  docFromRgba,
  activeLayer,
  compositeDoc,
  addLayer,
  removeLayer,
  reorderLayer,
  setLayerProps,
  setActiveLayer,
  setLayerPixel,
  getLayerPixel,
  reflectX,
  floodFillRgba,
  clampRect,
  snapshotRect,
  blitRect,
  serializeDoc,
  deserializeDoc,
} = mod;

let passed = 0;

/** A solid RGBA bitmap of one colour, for seeding docs from a "render". */
function solid(width, height, [r, g, b, a]) {
  const px = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = a;
  }
  return px;
}

// 1. docFromRgba copies its input (later edits don't mutate the caller's buffer)
//    and a fresh doc's composite equals the seed bitmap.
{
  const w = 2;
  const h = 2;
  const seed = solid(w, h, [200, 100, 50, 255]);
  const doc = docFromRgba(seed, w, h);
  assert.equal(doc.layers.length, 1, "seeded with one layer");
  assert.equal(activeLayer(doc).id, doc.layers[0].id, "active layer is the seed layer");

  // Mutating the doc's layer must not touch the caller's original buffer.
  setLayerPixel(doc.layers[0], w, h, 0, 0, [1, 2, 3, 4]);
  assert.equal(seed[0], 200, "docFromRgba copied the seed (original preserved)");

  const seed2 = solid(w, h, [10, 20, 30, 255]);
  assert.deepEqual([...compositeDoc(docFromRgba(seed2, w, h))], [...seed2], "composite of a single opaque layer equals the seed");
  passed += 1;
}

// 2. compositeDoc source-overs top layers onto lower ones and respects
//    visibility and opacity.
{
  const w = 1;
  const h = 1;
  const doc = docFromRgba(solid(w, h, [0, 0, 0, 255]), w, h); // black background
  // Add an opaque white layer on top: composite should be white.
  const withTop = addLayer(doc);
  setLayerPixel(activeLayer(withTop), w, h, 0, 0, [255, 255, 255, 255]);
  assert.deepEqual([...compositeDoc(withTop)], [255, 255, 255, 255], "opaque top layer wins");

  // Hide the top layer: composite falls back to the background.
  const hidden = setLayerProps(withTop, withTop.activeId, { visible: false });
  assert.deepEqual([...compositeDoc(hidden)], [0, 0, 0, 255], "hidden layer does not contribute");

  // Half-opacity white over black blends halfway (derived, not hard-coded).
  const half = setLayerProps(withTop, withTop.activeId, { opacity: 0.5 });
  const out = compositeDoc(half);
  const expected = Math.round(255 * 0.5 + 0 * 0.5); // white*0.5 over black
  assert.equal(out[0], expected, "opacity blends the top layer over the base");
  assert.equal(out[3], 255, "composite stays opaque over an opaque base");
  passed += 1;
}

// 3. Layer stack ops: add respects the cap and inserts above the active layer;
//    remove keeps at least one and reselects; reorder moves within bounds.
{
  const w = 1;
  const h = 1;
  let doc = docFromRgba(solid(w, h, [0, 0, 0, 255]), w, h);
  const baseId = doc.activeId;
  doc = addLayer(doc); // above base, becomes active
  const topId = doc.activeId;
  assert.deepEqual(doc.layers.map((l) => l.id), [baseId, topId], "new layer inserted above active");

  // Fill to the cap, then adding again is a no-op.
  while (doc.layers.length < MAX_PAINT_LAYERS) doc = addLayer(doc);
  const atCap = doc.layers.length;
  doc = addLayer(doc);
  assert.equal(doc.layers.length, atCap, "cannot exceed the layer cap");

  // Reorder the top layer to the bottom.
  const movedId = doc.activeId;
  doc = reorderLayer(doc, movedId, 0);
  assert.equal(doc.layers[0].id, movedId, "reorder moves the layer to the target index");
  assert.equal(doc.activeId, movedId, "reorder preserves the active layer");

  // Remove down to one; the last layer can't be removed.
  while (doc.layers.length > 1) doc = removeLayer(doc, doc.layers[0].id);
  const only = doc.layers[0].id;
  doc = removeLayer(doc, only);
  assert.equal(doc.layers.length, 1, "a document always keeps one layer");
  assert.equal(doc.activeId, only, "the surviving layer stays active");
  passed += 1;
}

// 4. floodFillRgba fills the contiguous same-colour region, honours a mask, and
//    reports the number of pixels changed.
{
  const w = 3;
  const h = 1;
  // Row: [A][A][B]. Fill from x=0 with C should recolour the two A's only.
  const layer = createLayer(w, h, "L");
  const A = [10, 10, 10, 255];
  const B = [90, 90, 90, 255];
  const C = [200, 50, 50, 255];
  setLayerPixel(layer, w, h, 0, 0, A);
  setLayerPixel(layer, w, h, 1, 0, A);
  setLayerPixel(layer, w, h, 2, 0, B);
  const changed = floodFillRgba(layer, w, h, 0, 0, C, 0);
  assert.equal(changed, 2, "fill recolours the contiguous same-colour run");
  assert.deepEqual([...getLayerPixel(layer, w, 0, 0)], C, "seed pixel filled");
  assert.deepEqual([...getLayerPixel(layer, w, 1, 0)], C, "adjacent same-colour pixel filled");
  assert.deepEqual([...getLayerPixel(layer, w, 2, 0)], B, "different-colour pixel untouched");

  // A mask that excludes x=1 stops the spread there.
  const masked = createLayer(w, h, "M");
  setLayerPixel(masked, w, h, 0, 0, A);
  setLayerPixel(masked, w, h, 1, 0, A);
  const maskedChanged = floodFillRgba(masked, w, h, 0, 0, C, 0, (x) => x === 0);
  assert.equal(maskedChanged, 1, "mask confines the fill to allowed pixels");
  passed += 1;
}

// 5. snapshotRect/blitRect round-trip a sub-rectangle (the undo unit): capture,
//    overwrite, restore, and the layer matches its pre-edit state.
{
  const w = 4;
  const h = 4;
  const layer = createLayer(w, h, "L");
  // Give every pixel a position-derived colour so a wrong blit is detectable.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) setLayerPixel(layer, w, h, x, y, [x * 10, y * 10, 0, 255]);
  }
  const rect = clampRect({ x: 1, y: 1, width: 2, height: 2 }, w, h);
  const before = snapshotRect(layer, w, rect);

  // Scribble over the rect, then restore it from the snapshot.
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) setLayerPixel(layer, w, h, x, y, [255, 255, 255, 255]);
  }
  blitRect(layer, w, rect, before);
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      assert.deepEqual([...getLayerPixel(layer, w, x, y)], [x * 10, y * 10, 0, 255], `restored (${x},${y})`);
    }
  }
  // A rectangle entirely off-canvas clamps to null.
  assert.equal(clampRect({ x: -5, y: -5, width: 3, height: 3 }, w, h), null, "off-canvas rect clamps to null");
  passed += 1;
}

// 6. serialize -> deserialize round-trips a multi-layer doc; a size/dimension
//    mismatch or malformed payload returns null (the corruption gate).
{
  const w = 2;
  const h = 2;
  let doc = docFromRgba(solid(w, h, [12, 34, 56, 255]), w, h);
  doc = addLayer(doc, "Top");
  setLayerPixel(activeLayer(doc), w, h, 1, 1, [7, 8, 9, 255]);
  doc = setLayerProps(doc, doc.activeId, { opacity: 0.5 });

  const restored = deserializeDoc(serializeDoc(doc), w, h);
  assert.equal(restored.layers.length, doc.layers.length, "layer count round-trips");
  assert.deepEqual([...compositeDoc(restored)], [...compositeDoc(doc)], "composite round-trips through serialise");
  assert.equal(restored.layers[1].name, "Top", "layer name round-trips");
  assert.equal(restored.layers[1].opacity, 0.5, "layer opacity round-trips");

  assert.equal(deserializeDoc(serializeDoc(doc), w + 1, h), null, "wrong width rejected");
  assert.equal(deserializeDoc(null, w, h), null, "null payload rejected");
  assert.equal(deserializeDoc({ width: w, height: h, layers: [{ data: "!!not base64 length!!" }] }, w, h), null, "bad layer length rejected");
  passed += 1;
}

// 7. setActiveLayer ignores unknown ids (defensive against stale UI state).
{
  const doc = docFromRgba(solid(1, 1, [0, 0, 0, 255]), 1, 1);
  assert.equal(setActiveLayer(doc, "does-not-exist").activeId, doc.activeId, "unknown active id is ignored");
  passed += 1;
}

// 8. reflectX mirrors an x across the vertical centre: reflection is an
//    involution (twice = identity), edges swap, and painting a pixel plus its
//    reflection makes a row left-right symmetric (the symmetry-mode invariant).
{
  const w = 5;
  for (let x = 0; x < w; x += 1) {
    assert.equal(reflectX(reflectX(x, w), w), x, `reflectX is its own inverse at x=${x}`);
  }
  assert.equal(reflectX(0, w), w - 1, "left edge maps to right edge");
  assert.equal(reflectX(Math.floor(w / 2), w), Math.floor(w / 2), "odd-width centre is fixed");

  const h = 1;
  const layer = createLayer(w, h, "S");
  const dab = [200, 50, 50, 255];
  const x = 1;
  setLayerPixel(layer, w, h, x, 0, dab);
  setLayerPixel(layer, w, h, reflectX(x, w), 0, dab);
  for (let column = 0; column < w; column += 1) {
    assert.deepEqual(
      [...getLayerPixel(layer, w, column, 0)],
      [...getLayerPixel(layer, w, reflectX(column, w), 0)],
      `row is symmetric at column ${column}`,
    );
  }
  passed += 1;
}

console.log(`PASS — handheldPaintDoc: ${passed} checks green.`);
