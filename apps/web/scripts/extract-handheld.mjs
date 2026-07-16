/**
 * Asset-prep: turn the handheld template `.aseprite` into the files the app
 * ships and renders from. Reads apps/web/public/handheld/template.aseprite and
 * writes, alongside it:
 *   - base.png       the shared chrome (recolour-independent)
 *   - mask.png       per-pixel region id in the red channel (0 = none, 1..7)
 *   - presets.json   the premade schemes (from the model)
 *   - preview/<id>.png   a downscaled render of each preset (for the picker)
 *
 * Run from the repo root (packages/editor is TS, so use the Node type stripper):
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" \
 *        apps/web/scripts/extract-handheld.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const editorSrc = path.resolve(here, "../../../packages/editor/src");
const load = (rel) => import(pathToFileURL(path.resolve(editorSrc, rel)).href);
const { parseAsepriteLayers } = await load("model/asepriteImport.ts");
const { extractHandheldTemplate, renderHandheld, HANDHELD_PRESETS, HANDHELD_REGIONS } = await load("model/handheldSkin.ts");

const OUT = path.resolve(here, "../public/handheld");
const PREVIEW = path.join(OUT, "preview");
fs.mkdirSync(PREVIEW, { recursive: true });

// The layer names in the source file.
const BASE_LAYER = "Handheld"; // the shared chrome (top-level layer)
const MASK_GROUP = "Vertical_Handheld"; // the group holding one flat layer per region

const bytes = new Uint8Array(fs.readFileSync(path.join(OUT, "template.aseprite")));
const layers = await parseAsepriteLayers(bytes);
const full = extractHandheldTemplate(layers, BASE_LAYER, MASK_GROUP);
console.log(`template ${full.width}x${full.height}, ${layers.layers.length} layers`);

/**
 * The source art parks colour-reference swatches to the right of the handheld
 * and an arc below it, separated from the body by fully-empty pixel bands. Crop
 * to the handheld itself: from the first content column/row, stop at the first
 * wide empty gap (so a cleaned-up source with no scaffolding crops to its full
 * bounds automatically).
 */
function computeCrop(base, w, h, gap = 16) {
  const colFilled = new Array(w).fill(false);
  const rowFilled = new Array(h).fill(false);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (base[(y * w + x) * 4 + 3] > 0) {
        colFilled[x] = true;
        rowFilled[y] = true;
      }
    }
  }
  const bounds = (filled, size) => {
    let start = filled.findIndex(Boolean);
    if (start < 0) return [0, size];
    let end = start;
    let run = 0;
    for (let i = start; i < size; i += 1) {
      if (filled[i]) {
        end = i;
        run = 0;
      } else if (++run >= gap) {
        break; // a wide empty band ends the handheld body
      }
    }
    return [start, end + 1];
  };
  const [x0, x1] = bounds(colFilled, w);
  const [y0, y1] = bounds(rowFilled, h);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Crop a template (base + mask) to a rectangle. */
function cropTemplate(t, rect) {
  const base = new Uint8ClampedArray(rect.width * rect.height * 4);
  const regionMask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const src = ((rect.y + y) * t.width + (rect.x + x));
      const dst = y * rect.width + x;
      base.set(t.base.subarray(src * 4, src * 4 + 4), dst * 4);
      regionMask[dst] = t.regionMask[src];
    }
  }
  return { width: rect.width, height: rect.height, base, regionMask };
}

const crop = computeCrop(full.base, full.width, full.height);
console.log(`crop to handheld body: ${crop.width}x${crop.height} @ ${crop.x},${crop.y}`);
const template = cropTemplate(full, crop);
const { width, height } = template;

/**
 * The source art keeps the D-pad cross and the four face-button circles on one
 * layer (DPad_Color), while the Button_Color group is empty — so out of the box
 * they recolour together. Split them into separate regions so each is
 * independent: flood the D-pad region into connected blobs and reassign any blob
 * that sits inside the button panel (the recess behind A/B/X/Y) to the buttons
 * region. If the artist ever paints the Button_Color layer directly, that mask
 * wins and this no-ops.
 */
function splitButtonsFromDpad(t) {
  const regionId = (id) => HANDHELD_REGIONS.findIndex((region) => region.id === id) + 1;
  const dpadId = regionId("dpad");
  const buttonsId = regionId("buttonColor");
  const panelId = regionId("buttonPanel");
  if (!dpadId || !buttonsId || !panelId) return;
  if (t.regionMask.includes(buttonsId)) return; // the layer was authored explicitly

  // Bounds of the button recess panel — the region the circles live within.
  let px0 = t.width, py0 = t.height, px1 = -1, py1 = -1;
  for (let y = 0; y < t.height; y += 1) {
    for (let x = 0; x < t.width; x += 1) {
      if (t.regionMask[y * t.width + x] === panelId) {
        if (x < px0) px0 = x;
        if (y < py0) py0 = y;
        if (x > px1) px1 = x;
        if (y > py1) py1 = y;
      }
    }
  }
  if (px1 < 0) return; // no button panel to split against

  const seen = new Uint8Array(t.width * t.height);
  for (let start = 0; start < t.regionMask.length; start += 1) {
    if (seen[start] || t.regionMask[start] !== dpadId) continue;
    const blob = [start];
    seen[start] = 1;
    let sumX = 0;
    let sumY = 0;
    for (let head = 0; head < blob.length; head += 1) {
      const p = blob[head];
      const x = p % t.width;
      const y = (p / t.width) | 0;
      sumX += x;
      sumY += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= t.width || ny >= t.height) continue;
        const np = ny * t.width + nx;
        if (!seen[np] && t.regionMask[np] === dpadId) {
          seen[np] = 1;
          blob.push(np);
        }
      }
    }
    // A blob is a face button when its centre lies within the button panel.
    const cx = sumX / blob.length;
    const cy = sumY / blob.length;
    if (cx >= px0 && cx <= px1 && cy >= py0 && cy <= py1) {
      for (const p of blob) t.regionMask[p] = buttonsId;
    }
  }
}

splitButtonsFromDpad(template);

/** Write straight-alpha RGBA to a PNG at full resolution. */
function writeRgba(rgba, file) {
  const png = new PNG({ width, height });
  png.data.set(rgba.subarray(0, width * height * 4));
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Write a downscaled RGBA preview (nearest sample) for the picker. */
function writePreview(rgba, file, targetW) {
  const scale = Math.max(1, Math.round(width / targetW));
  const w = Math.round(width / scale);
  const h = Math.round(height / scale);
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, x * scale);
      const sy = Math.min(height - 1, y * scale);
      const s = (sy * width + sx) * 4;
      const d = (y * w + x) * 4;
      png.data[d] = rgba[s];
      png.data[d + 1] = rgba[s + 1];
      png.data[d + 2] = rgba[s + 2];
      png.data[d + 3] = rgba[s + 3];
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
  return { w, h };
}

// base.png — the shared chrome.
writeRgba(template.base, path.join(OUT, "base.png"));

// mask.png — region id (0..7) packed into the red channel, opaque.
const maskRgba = new Uint8ClampedArray(width * height * 4);
for (let pixel = 0; pixel < template.regionMask.length; pixel += 1) {
  maskRgba[pixel * 4] = template.regionMask[pixel]; // region id in R
  maskRgba[pixel * 4 + 3] = 255;
}
writeRgba(maskRgba, path.join(OUT, "mask.png"));

// presets.json — the premade schemes + region metadata for the UI.
const presets = {
  regions: HANDHELD_REGIONS.map((region) => ({ id: region.id, label: region.label })),
  presets: HANDHELD_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, scheme: preset.scheme })),
};
fs.writeFileSync(path.join(OUT, "presets.json"), JSON.stringify(presets, null, 2));

// preview/<id>.png — a FULL-RESOLUTION render of each preset. The picker shrinks
// it to card size with the browser's smooth downsampler, which keeps thin details
// (D-pad arrows, button letters, on-shell text) from being dropped the way a
// pre-downscaled, nearest-sampled thumbnail lost them.
for (const preset of HANDHELD_PRESETS) {
  const rendered = renderHandheld(template, preset.scheme);
  writeRgba(rendered, path.join(PREVIEW, `${preset.id}.png`));
  console.log(`preview ${preset.id}: ${width}x${height}`);
}

console.log(`wrote base.png, mask.png, presets.json, ${HANDHELD_PRESETS.length} previews -> ${OUT}`);
