/**
 * Unit tests for the multi-layer RGBA .aseprite encoder
 * (packages/editor/src/model/asepriteExport.ts `encodeAsepriteRgba`), which lets
 * the handheld pixel editor export a layered drawing for external editing.
 *
 * The check is a true round-trip: encode a synthetic multi-layer RGBA document,
 * parse it back with the project's own parser, and assert every layer's name,
 * visibility, opacity, and pixels survive. Values come from the constructed
 * document, never a fixed byte blob.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/asepriteRgba.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { encodeAsepriteRgba, encodeAsepriteRgbaFrames } = await load("../packages/editor/src/model/asepriteExport.ts");
const { parseAsepriteLayers, parseAseprite } = await load("../packages/editor/src/model/asepriteImport.ts");
const { docFromLayers, compositeDoc } = await load("../packages/editor/src/model/handheldPaintDoc.ts");

/** A full-canvas RGBA buffer painted by a per-pixel function. */
function paint(width, height, colorAt) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = colorAt(x, y);
      const base = (y * width + x) * 4;
      pixels[base] = r;
      pixels[base + 1] = g;
      pixels[base + 2] = b;
      pixels[base + 3] = a;
    }
  }
  return pixels;
}

let passed = 0;

// 1. A two-layer RGBA document round-trips: encode → parse → identical layers.
{
  const width = 5;
  const height = 3;
  // Bottom: opaque diagonal gradient. Top: a few opaque dots over transparency.
  const bottom = paint(width, height, (x, y) => [x * 40, y * 60, 20, 255]);
  const top = paint(width, height, (x, y) => (x === y ? [200, 10, 90, 255] : [0, 0, 0, 0]));
  const input = [
    { name: "Base", visible: true, opacity: 255, pixels: bottom },
    { name: "Details", visible: false, opacity: 128, pixels: top },
  ];

  const bytes = await encodeAsepriteRgba(input, width, height);
  const parsed = await parseAsepriteLayers(bytes);

  assert.equal(parsed.width, width, "canvas width round-trips");
  assert.equal(parsed.height, height, "canvas height round-trips");
  // Only image layers (type 0) — no groups are emitted.
  const layers = parsed.layers.filter((layer) => layer.type === 0);
  assert.equal(layers.length, input.length, "layer count round-trips");

  layers.forEach((layer, index) => {
    const source = input[index];
    assert.equal(layer.name, source.name, `layer ${index} name round-trips`);
    assert.equal(layer.visible, source.visible, `layer ${index} visibility round-trips`);
    assert.equal(layer.opacity, source.opacity, `layer ${index} opacity round-trips`);
    assert.deepEqual([...layer.pixels], [...source.pixels], `layer ${index} pixels round-trip exactly`);
  });
  passed += 1;
}

// 2. A layer whose size disagrees with the canvas is rejected (fail loud, not a
//    corrupt file).
{
  const bad = [{ name: "Wrong", visible: true, opacity: 255, pixels: new Uint8ClampedArray(4 * 4) }];
  await assert.rejects(() => encodeAsepriteRgba(bad, 3, 3), /expected/, "mismatched layer size is rejected");
  await assert.rejects(() => encodeAsepriteRgba([], 2, 2), /at least one layer/, "an empty document is rejected");
  passed += 1;
}

// 3. The editor's import path round-trips: encode → parse → docFromLayers gives
//    a document whose composite matches the original drawing.
{
  const width = 4;
  const height = 4;
  const bottom = paint(width, height, (x, y) => [x * 50, y * 50, 100, 255]);
  const top = paint(width, height, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 0, 200] : [0, 0, 0, 0]));
  const input = [
    { name: "Base", visible: true, opacity: 255, pixels: bottom },
    { name: "Top", visible: true, opacity: 255, pixels: top },
  ];
  const bytes = await encodeAsepriteRgba(input, width, height);
  const parsed = await parseAsepriteLayers(bytes);
  const imageLayers = parsed.layers.filter((layer) => layer.type === 0 && layer.pixels);
  const doc = docFromLayers(
    imageLayers.map((layer) => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity / 255, pixels: layer.pixels })),
    width,
    height,
  );

  // Reference composite of the original input layers (all fully opaque layers).
  const reference = docFromLayers(input.map((l) => ({ name: l.name, visible: l.visible, opacity: l.opacity / 255, pixels: l.pixels })), width, height);
  assert.deepEqual([...compositeDoc(doc)], [...compositeDoc(reference)], "imported document composites identically to the source");
  assert.equal(doc.layers.length, input.length, "imported document keeps the layer count");
  passed += 1;
}

// 4. A multi-frame animation round-trips: encode N composited frames with
//    per-frame durations, parse them back, and confirm pixels and timing match.
{
  const width = 3;
  const height = 3;
  const frameInputs = [
    { pixels: paint(width, height, () => [255, 0, 0, 255]), durationMs: 80 },
    { pixels: paint(width, height, () => [0, 255, 0, 255]), durationMs: 120 },
    { pixels: paint(width, height, (x) => [0, 0, x === 0 ? 255 : 0, 255]), durationMs: 200 },
  ];
  const bytes = await encodeAsepriteRgbaFrames(frameInputs, width, height);
  const doc = await parseAseprite(bytes);

  assert.equal(doc.frames.length, frameInputs.length, "frame count round-trips");
  doc.frames.forEach((frame, index) => {
    assert.equal(frame.durationMs, frameInputs[index].durationMs, `frame ${index} duration round-trips`);
    assert.deepEqual([...frame.pixels], [...frameInputs[index].pixels], `frame ${index} pixels round-trip`);
  });

  await assert.rejects(() => encodeAsepriteRgbaFrames([], width, height), /at least one frame/, "empty animation rejected");
  passed += 1;
}

console.log(`PASS — asepriteRgba: ${passed} checks green.`);
