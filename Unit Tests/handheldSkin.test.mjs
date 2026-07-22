/**
 * Unit tests for the handheld skin model (packages/editor/src/model/handheldSkin.ts).
 *
 * Uses a synthetic 2x2 template and a synthetic Aseprite layer tree (a base
 * layer + a named scheme group of flat region layers) — the same shape as the
 * real template, in miniature — so every assertion is derived from the inputs,
 * not hard-coded pixel values.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handheldSkin.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/handheldSkin.ts")).href);
const {
  HANDHELD_REGIONS,
  HANDHELD_PRESETS,
  renderHandheld,
  renderHandheldWithBackground,
  extractScheme,
  extractSchemeFromLayers,
  extractHandheldTemplate,
  normalizeScheme,
  makeScheme,
} = mod;

let passed = 0;

const hex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

// 1. renderHandheld paints masked pixels with the scheme colour and leaves the
//    rest of the base untouched.
{
  // 2x2 canvas: pixel 0 is region 1 (first region), pixel 3 is region 2 (second
  // region); pixels 1 and 2 are base chrome that must survive. Region ids are
  // taken from the model so this tracks HANDHELD_REGIONS rather than fixed names.
  const firstRegion = HANDHELD_REGIONS[0].id;
  const secondRegion = HANDHELD_REGIONS[1].id;
  const base = new Uint8ClampedArray([
    10, 10, 10, 255, // p0 (will be overwritten by region 1)
    20, 20, 20, 255, // p1 base
    30, 30, 30, 255, // p2 base
    40, 40, 40, 255, // p3 (will be overwritten by region 2)
  ]);
  const regionMask = new Uint8Array([1, 0, 0, 2]);
  const template = { width: 2, height: 2, base, regionMask };

  const scheme = makeScheme((region) =>
    region.id === firstRegion ? "#ff0000" : region.id === secondRegion ? "#00ff00" : "#000000",
  );
  const out = renderHandheld(template, scheme);

  assert.deepEqual([...out.slice(0, 4)], [255, 0, 0, 255], "region 1 pixel recoloured");
  assert.deepEqual([...out.slice(4, 8)], [20, 20, 20, 255], "base pixel 1 untouched");
  assert.deepEqual([...out.slice(8, 12)], [30, 30, 30, 255], "base pixel 2 untouched");
  assert.deepEqual([...out.slice(12, 16)], [0, 255, 0, 255], "region 2 pixel recoloured");
  // The template's base is not mutated (render returns a copy).
  assert.equal(base[0], 10, "original base preserved");
  passed += 1;
}

/** Build a full-canvas RGBA layer that is `color` where `mask[i]` is truthy. */
function layerFrom(mask, color, w, h) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    if (mask[i]) {
      px[i * 4] = color[0];
      px[i * 4 + 1] = color[1];
      px[i * 4 + 2] = color[2];
      px[i * 4 + 3] = 255;
    }
  }
  return px;
}

// 2. extractScheme reads the seven region colours from a named group, and
//    extractHandheldTemplate builds base + mask from the same tree.
{
  const w = 4;
  const h = 3;
  // Base chrome: grey pixels (not part of any region). The canvas holds one pixel
  // per region plus spares, so it must stay at least HANDHELD_REGIONS.length wide.
  const baseMask = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const baseLayer = { name: "Handheld", type: 0, childLevel: 0, visible: true, opacity: 255, pixels: layerFrom(baseMask, [90, 90, 90], w, h) };

  // Give each region a distinct colour and a distinct single-pixel mask.
  const regionColor = (i) => [40 + i * 20, 10 + i * 5, 200 - i * 20];
  const groupChildren = HANDHELD_REGIONS.map((region, i) => {
    const m = new Array(w * h).fill(0);
    m[i] = 1; // region i owns pixel i (canvas has 12 pixels, one per region + spare)
    return {
      name: region.layer,
      type: 0,
      childLevel: 1,
      visible: true,
      opacity: 255,
      pixels: layerFrom(m, regionColor(i), w, h),
    };
  });
  const group = { name: "Test_Scheme", type: 1, childLevel: 0, visible: true, opacity: 255, pixels: null };
  const layers = { width: w, height: h, layers: [baseLayer, group, ...groupChildren] };

  const scheme = extractScheme(layers, "Test_Scheme");
  HANDHELD_REGIONS.forEach((region, i) => {
    const c = regionColor(i);
    assert.equal(scheme[region.id], hex(c[0], c[1], c[2]), `extracted ${region.id}`);
  });

  const template = extractHandheldTemplate(layers, "Handheld", "Test_Scheme");
  assert.equal(template.width, w);
  // Region i lands on pixel i (mask id = index + 1); the remaining pixels are none.
  const expectedMask = HANDHELD_REGIONS.map((_, i) => i + 1);
  while (expectedMask.length < w * h) expectedMask.push(0);
  assert.deepEqual([...template.regionMask], expectedMask);
  // The base survived into the template unmodified at a base pixel.
  assert.deepEqual([...template.base.slice(16, 20)], [90, 90, 90, 255], "base pixel 4 preserved");

  // Rendering the extracted scheme onto the extracted template reproduces each
  // region's own colour at its pixel (round-trip through the model).
  const rendered = renderHandheld(template, scheme);
  HANDHELD_REGIONS.forEach((region, i) => {
    const c = regionColor(i);
    assert.deepEqual([...rendered.slice(i * 4, i * 4 + 4)], [c[0], c[1], c[2], 255], `rendered ${region.id}`);
  });
  passed += 1;
}

// 3. normalizeScheme accepts good colours, repairs bad ones, and always returns
//    a complete scheme.
{
  const good = HANDHELD_PRESETS[0].scheme;
  assert.deepEqual(normalizeScheme(good), good, "valid scheme passes through");

  const repaired = normalizeScheme({ face: "12ab34", buttonLetter: "not-a-color", dpadArrow: "#GGG" });
  assert.equal(repaired.face, "#12ab34", "accepts hex without # and lowercases");
  // Missing/invalid regions fall back to the default preset's colour, never undefined.
  for (const region of HANDHELD_REGIONS) {
    assert.match(repaired[region.id], /^#[0-9a-f]{6}$/, `${region.id} is a valid colour`);
  }
  assert.deepEqual(normalizeScheme(null), normalizeScheme({}), "null input yields the default scheme");
  passed += 1;
}

// 4. extractSchemeFromLayers reads each region's colour from how the file
//    renders (composite of the visible layers), region shapes not overlapping.
{
  const w = 2;
  const h = 2;
  // Region shapes on distinct pixels: face@0, letters@1 (so they don't overwrite).
  // Layer names come from the model so the test tracks HANDHELD_REGIONS.
  const layerName = (id) => HANDHELD_REGIONS.find((region) => region.id === id).layer;
  const missingRegion = HANDHELD_REGIONS.find((region) => region.id === "dpad");
  const mask = { face: [1, 0, 0, 0], letters: [0, 1, 0, 0] };
  const layer = (name, shape, color, visible, childLevel = 0, type = 0) => ({
    name,
    type,
    childLevel,
    visible,
    opacity: 255,
    pixels: color ? layerFrom(shape, color, w, h) : null,
  });
  const fallback = HANDHELD_PRESETS[0].scheme;

  const layers = {
    width: w,
    height: h,
    layers: [
      layer(layerName("face"), mask.face, [10, 20, 30], false), // hidden — not drawn
      layer(layerName("face"), mask.face, [200, 100, 50], true), // visible — shows
      layer(layerName("buttonLetter"), mask.letters, [1, 2, 3], true),
    ],
  };
  const scheme = extractSchemeFromLayers(layers, fallback);
  assert.equal(scheme.face, hex(200, 100, 50), "face reads the visible layer's colour");
  assert.equal(scheme.buttonLetter, hex(1, 2, 3), "letters read from their own region");
  assert.equal(scheme[missingRegion.id], fallback[missingRegion.id], "region with no layer falls back");
  passed += 1;
}

// 5. Group visibility propagates: a visible region layer inside a HIDDEN group
//    does not render, so its region falls back (the real-file failure mode).
{
  const w = 2;
  const h = 2;
  const fallback = HANDHELD_PRESETS[1].scheme;
  const layers = {
    width: w,
    height: h,
    layers: [
      { name: "Hidden Group", type: 1, childLevel: 0, visible: false, opacity: 255, pixels: null },
      // Own flag visible, but the parent group is hidden -> effectively hidden.
      { name: "Face_Color", type: 0, childLevel: 1, visible: true, opacity: 255, pixels: layerFrom([1, 0, 0, 0], [9, 9, 9], w, h) },
    ],
  };
  const scheme = extractSchemeFromLayers(layers, fallback);
  assert.equal(scheme.face, fallback.face, "layer under a hidden group is ignored");
  passed += 1;
}

// 6. Every premade keeps the D-pad arrows distinct from the D-pad and the
//    button letters distinct from the buttons, so the markings are always
//    visible against the control they sit on.
{
  for (const preset of HANDHELD_PRESETS) {
    assert.notEqual(preset.scheme.dpadArrow, preset.scheme.dpad, `${preset.id}: arrows differ from the D-pad`);
    assert.notEqual(preset.scheme.buttonLetter, preset.scheme.buttonColor, `${preset.id}: letters differ from the buttons`);
  }
  passed += 1;
}

// 7. renderHandheldWithBackground shows the image through the chassis (`face`)
//    region only: face pixels sample the image, every other region keeps its
//    scheme colour, and non-region base pixels are untouched.
{
  const firstRegion = HANDHELD_REGIONS[0].id; // "face" — the chassis background
  const secondRegion = HANDHELD_REGIONS[1].id;
  // 2x2 device: p0 face, p1 second region, p2/p3 base chrome.
  const base = new Uint8ClampedArray([
    10, 10, 10, 255,
    20, 20, 20, 255,
    30, 30, 30, 255,
    40, 40, 40, 255,
  ]);
  const regionMask = new Uint8Array([1, 2, 0, 0]);
  const template = { width: 2, height: 2, base, regionMask };
  const scheme = makeScheme((region) =>
    region.id === firstRegion ? "#ff0000" : region.id === secondRegion ? "#00ff00" : "#000000",
  );

  // A 2x2 background: at 1:1 cover-fit, device pixel (x,y) samples image (x,y).
  const background = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      1, 2, 3, 255,
      4, 5, 6, 255,
      7, 8, 9, 255,
      10, 11, 12, 255,
    ]),
  };
  const out = renderHandheldWithBackground(template, scheme, background);

  assert.deepEqual([...out.slice(0, 4)], [1, 2, 3, 255], "face pixel shows the image (sampled at its position)");
  assert.deepEqual([...out.slice(4, 8)], [0, 255, 0, 255], "non-face region keeps its scheme colour");
  assert.deepEqual([...out.slice(8, 12)], [30, 30, 30, 255], "base pixel 2 untouched");
  assert.deepEqual([...out.slice(12, 16)], [40, 40, 40, 255], "base pixel 3 untouched");
  // A zero-size image is a no-op (returns the plain recolour), never a crash.
  const noop = renderHandheldWithBackground(template, scheme, { width: 0, height: 0, data: new Uint8ClampedArray() });
  assert.deepEqual([...noop], [...renderHandheld(template, scheme)], "empty background falls back to the recolour");
  passed += 1;
}

console.log(`PASS — handheldSkin: ${passed} checks green.`);
