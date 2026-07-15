// Verify the in-settings handheld recolour path against the shipped assets:
// building the template from base.png + mask.png (exactly what the image console
// loads), then applying the same transform SettingsScreen triggers through
// HandheldSkinContext (recolour a region / apply a preset) and confirming the
// rendered skin actually changes for that region while leaving others intact.
//
// Browser-free: it exercises the pure model + real PNG masks, which is the part
// that determines what the player sees. Run:
//   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" scripts/verify-handheld-recolor.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const editorSrc = path.resolve("packages/editor/src");
const load = (rel) => import(pathToFileURL(path.resolve(editorSrc, rel)).href);
const { HANDHELD_REGIONS, HANDHELD_PRESETS, DEFAULT_HANDHELD_PRESET_ID, handheldPreset, renderHandheld, normalizeScheme } =
  await load("model/handheldSkin.ts");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

// Build the HandheldTemplate the same way lib/handheldTemplate.ts does in the
// browser: base RGBA + region id from the mask's red channel.
const DIR = path.resolve("apps/web/public/handheld");
const basePng = PNG.sync.read(fs.readFileSync(path.join(DIR, "base.png")));
const maskPng = PNG.sync.read(fs.readFileSync(path.join(DIR, "mask.png")));
const width = basePng.width;
const height = basePng.height;
const regionMask = new Uint8Array(width * height);
for (let pixel = 0; pixel < regionMask.length; pixel += 1) regionMask[pixel] = maskPng.data[pixel * 4];
const template = { width, height, base: new Uint8ClampedArray(basePng.data), regionMask };

// The context's commit transforms, replicated exactly.
const recolorRegion = (skin, region, color) => ({ presetId: "custom", scheme: { ...skin.scheme, [region]: color } });
const applyPreset = (presetId) => ({ presetId, scheme: handheldPreset(presetId).scheme });

const firstPixelOfRegion = (id) => regionMask.indexOf(id);
const pixelHex = (rgba, pixel) =>
  "#" + [rgba[pixel * 4], rgba[pixel * 4 + 1], rgba[pixel * 4 + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");

// Baseline: the default skin the console starts on.
const defaultSkin = { presetId: DEFAULT_HANDHELD_PRESET_ID, scheme: handheldPreset(DEFAULT_HANDHELD_PRESET_ID).scheme };
const baseRender = renderHandheld(template, defaultSkin.scheme);

// 1. Recolouring the chassis (Face_Color) repaints its masked pixels and marks
//    the skin custom, without disturbing another region's pixels.
{
  const facePixel = firstPixelOfRegion(1); // id 1 = first region (chassis)
  const dpadArrowId = HANDHELD_REGIONS.findIndex((r) => r.id === "dpadArrow") + 1;
  const arrowPixel = firstPixelOfRegion(dpadArrowId);
  const recoloured = recolorRegion(defaultSkin, "face", "#ff0000");
  const render = renderHandheld(template, recoloured.scheme);
  check("recolour marks the skin custom", recoloured.presetId === "custom");
  check("chassis pixel takes the new colour", pixelHex(render, facePixel) === "#ff0000", pixelHex(render, facePixel));
  check(
    "an unrelated region is untouched by the chassis recolour",
    arrowPixel < 0 || pixelHex(render, arrowPixel) === pixelHex(baseRender, arrowPixel),
  );
  check("the overall skin bytes changed", !render.every((v, i) => v === baseRender[i]));
}

// 2. Applying a preset swaps to that preset's exact scheme.
{
  const graphite = HANDHELD_PRESETS.find((p) => p.id === "graphite");
  const skin = applyPreset("graphite");
  check("apply preset yields the preset id", skin.presetId === "graphite");
  check("apply preset yields the preset scheme", JSON.stringify(skin.scheme) === JSON.stringify(graphite.scheme));
}

// 3. Every region is individually recolourable and shows through in the render.
{
  let allShow = true;
  for (const region of HANDHELD_REGIONS) {
    const id = HANDHELD_REGIONS.indexOf(region) + 1;
    const pixel = firstPixelOfRegion(id);
    if (pixel < 0) {
      allShow = false;
      break;
    }
    const render = renderHandheld(template, recolorRegion(defaultSkin, region.id, "#123456").scheme);
    if (pixelHex(render, pixel) !== "#123456") {
      allShow = false;
      break;
    }
  }
  check(`all ${HANDHELD_REGIONS.length} regions are recolourable and visible in the render`, allShow);
}

// 4. The normalize gate (what persists through the context) repairs junk input.
{
  const repaired = normalizeScheme({ face: "not-a-color" }, defaultSkin.scheme);
  const complete = HANDHELD_REGIONS.every((r) => /^#[0-9a-f]{6}$/.test(repaired[r.id]));
  check("normalize repairs a bad colour and returns a complete scheme", complete && repaired.face === defaultSkin.scheme.face);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks green.`);
process.exit(passed === results.length ? 0 : 1);
