/**
 * Asset-prep: bake the animated handheld skins into the sprite sheets the app
 * ships and the console plays. For each preset in HANDHELD_ANIMATED_PRESETS it
 * renders every frame onto the handheld chassis, downscales them, lays them side
 * by side into one horizontal sheet, and writes:
 *   - animated/<id>.png          the sprite sheet (frameW * frames by frameH)
 *   - animated/preview/<id>.png  the first frame, for the picker card
 *   - animated/manifest.json     { id, label, frames, durationMs, frameW, frameH }
 *
 * Shares the exact crop + split the still-skin extractor uses, so the animated
 * frames line up with base.png/mask.png. Run from the repo root:
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" \
 *        apps/web/scripts/bake-handheld-animations.mjs
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
const { extractHandheldTemplate, HANDHELD_REGIONS } = await load("model/handheldSkin.ts");
const { HANDHELD_ANIMATED_PRESETS, renderAnimatedFrames } = await load("model/handheldAnimation.ts");

const OUT = path.resolve(here, "../public/handheld");
const ANIM = path.join(OUT, "animated");
const PREVIEW = path.join(ANIM, "preview");
fs.mkdirSync(PREVIEW, { recursive: true });

const BASE_LAYER = "Handheld";
const MASK_GROUP = "Vertical_Handheld";
/** Frames are downscaled so the sheet stays well under the inline data-URL cap. */
const TARGET_FRAME_WIDTH = 360;

// --- Crop + split, identical to extract-handheld.mjs so the frames align ------

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
    const start = filled.findIndex(Boolean);
    if (start < 0) return [0, size];
    let end = start;
    let run = 0;
    for (let i = start; i < size; i += 1) {
      if (filled[i]) {
        end = i;
        run = 0;
      } else if (++run >= gap) {
        break;
      }
    }
    return [start, end + 1];
  };
  const [x0, x1] = bounds(colFilled, w);
  const [y0, y1] = bounds(rowFilled, h);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function cropTemplate(t, rect) {
  const base = new Uint8ClampedArray(rect.width * rect.height * 4);
  const regionMask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    for (let x = 0; x < rect.width; x += 1) {
      const src = (rect.y + y) * t.width + (rect.x + x);
      const dst = y * rect.width + x;
      base.set(t.base.subarray(src * 4, src * 4 + 4), dst * 4);
      regionMask[dst] = t.regionMask[src];
    }
  }
  return { width: rect.width, height: rect.height, base, regionMask };
}

function splitButtonsFromDpad(t) {
  const regionId = (id) => HANDHELD_REGIONS.findIndex((region) => region.id === id) + 1;
  const dpadId = regionId("dpad");
  const buttonsId = regionId("buttonColor");
  const panelId = regionId("buttonPanel");
  if (!dpadId || !buttonsId || !panelId) return;
  if (t.regionMask.includes(buttonsId)) return;

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
  if (px1 < 0) return;

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
    const cx = sumX / blob.length;
    const cy = sumY / blob.length;
    if (cx >= px0 && cx <= px1 && cy >= py0 && cy <= py1) {
      for (const p of blob) t.regionMask[p] = buttonsId;
    }
  }
}

// --- Downscale + sheet assembly ----------------------------------------------

/** Nearest-sample downscale of a full-res RGBA frame to `w * h`. */
function downscaleFrame(rgba, srcW, srcH, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const scaleX = srcW / w;
  const scaleY = srcH / h;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor(x * scaleX));
      const sy = Math.min(srcH - 1, Math.floor(y * scaleY));
      const s = (sy * srcW + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

/** Write a horizontal sprite sheet PNG from equal-size RGBA frames. */
function writeSheet(frames, frameW, frameH, file) {
  const png = new PNG({ width: frameW * frames.length, height: frameH });
  frames.forEach((frame, index) => {
    for (let y = 0; y < frameH; y += 1) {
      for (let x = 0; x < frameW; x += 1) {
        const s = (y * frameW + x) * 4;
        const d = (y * png.width + index * frameW + x) * 4;
        png.data[d] = frame[s];
        png.data[d + 1] = frame[s + 1];
        png.data[d + 2] = frame[s + 2];
        png.data[d + 3] = frame[s + 3];
      }
    }
  });
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Write a single RGBA frame as a PNG. */
function writeFramePng(frame, w, h, file) {
  const png = new PNG({ width: w, height: h });
  png.data.set(frame.subarray(0, w * h * 4));
  fs.writeFileSync(file, PNG.sync.write(png));
}

// --- Bake --------------------------------------------------------------------

const bytes = new Uint8Array(fs.readFileSync(path.join(OUT, "template.aseprite")));
const layers = await parseAsepriteLayers(bytes);
const full = extractHandheldTemplate(layers, BASE_LAYER, MASK_GROUP);
const crop = computeCrop(full.base, full.width, full.height);
const template = cropTemplate(full, crop);
splitButtonsFromDpad(template);
console.log(`template body ${template.width}x${template.height}`);

const frameW = Math.min(template.width, TARGET_FRAME_WIDTH);
const scale = template.width / frameW;
const frameH = Math.round(template.height / scale);

const manifest = [];
for (const preset of HANDHELD_ANIMATED_PRESETS) {
  const fullFrames = renderAnimatedFrames(template, preset);
  const frames = fullFrames.map((frame) => downscaleFrame(frame, template.width, template.height, frameW, frameH));
  writeSheet(frames, frameW, frameH, path.join(ANIM, `${preset.id}.png`));
  writeFramePng(frames[0], frameW, frameH, path.join(PREVIEW, `${preset.id}.png`));
  manifest.push({ id: preset.id, label: preset.label, frames: preset.frames, durationMs: preset.durationMs, frameW, frameH });
  const sheetBytes = fs.statSync(path.join(ANIM, `${preset.id}.png`)).size;
  console.log(`baked ${preset.id}: ${preset.frames} frames @ ${frameW}x${frameH} (${(sheetBytes / 1024).toFixed(0)} KB sheet)`);
}

fs.writeFileSync(path.join(ANIM, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`wrote ${manifest.length} animated skins -> ${ANIM}`);
