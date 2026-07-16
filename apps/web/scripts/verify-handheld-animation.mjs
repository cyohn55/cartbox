/**
 * Browser-free end-to-end check for the premade *animated* handheld skins.
 *
 * WSL can't launch a browser, so this drives the pipeline at the module level:
 *   model frames  ->  sprite sheet (real PNG)  ->  inline data URL  ->  art gate
 * and asserts the resulting art is what the console will animate. Proves the four
 * scenes render, animate, assemble into a sheet, and survive the untrusted-input
 * gate within the localStorage data-URL budget.
 *
 * Run from the repo root:
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" \
 *        apps/web/scripts/verify-handheld-animation.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const editorSrc = path.resolve(here, "../../../packages/editor/src");
const load = (rel) => import(pathToFileURL(path.resolve(editorSrc, rel)).href);
const { HANDHELD_ANIMATED_PRESETS, renderAnimatedFrames } = await load("model/handheldAnimation.ts");
const { normalizeScheme } = await load("model/handheldSkin.ts");
// The art gate has no editor dependency, so it imports directly under the hook.
const { normalizeArt } = await import(pathToFileURL(path.resolve(here, "../src/lib/handheldArt.ts")).href);

/** Largest inline data URL the guest/static path keeps in localStorage. */
const MAX_ART_DATA_URL_CHARS = 4_000_000;

let checks = 0;
const check = (name, ok, detail) => {
  if (!ok) {
    console.error(`FAIL — ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    process.exit(1);
  }
  checks += 1;
};

/**
 * A synthetic handheld: opaque body with an enclosed transparent panel in the
 * lower chassis — the shape `findBottomPanel` targets, so the scene renders
 * there just as it does on the shipped art.
 */
function templateWithBottomPanel(width, height) {
  const base = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    base[i * 4] = 40;
    base[i * 4 + 1] = 40;
    base[i * 4 + 2] = 48;
    base[i * 4 + 3] = 255;
  }
  // Punch an enclosed hole in the lower third (kept off the borders so it is a
  // hole, not part of the outside).
  const hx = Math.round(width * 0.15);
  const hy = Math.round(height * 0.82);
  const hw = Math.round(width * 0.7);
  const hh = Math.round(height * 0.12);
  for (let y = hy; y < hy + hh; y += 1) {
    for (let x = hx; x < hx + hw; x += 1) base[(y * width + x) * 4 + 3] = 0;
  }
  return { width, height, base, regionMask: new Uint8Array(width * height), panel: { hx, hy, hw, hh } };
}

/** Downscale an RGBA frame (nearest sample). */
function downscale(rgba, sw, sh, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
      const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
      out.set(rgba.subarray((sy * sw + sx) * 4, (sy * sw + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}

/** Assemble frames into a horizontal sprite-sheet PNG data URL. */
function sheetDataUrl(frames, w, h) {
  const png = new PNG({ width: w * frames.length, height: h });
  frames.forEach((frame, index) => {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const s = (y * w + x) * 4;
        const d = (y * png.width + index * w + x) * 4;
        png.data[d] = frame[s];
        png.data[d + 1] = frame[s + 1];
        png.data[d + 2] = frame[s + 2];
        png.data[d + 3] = frame[s + 3];
      }
    }
  });
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

const template = templateWithBottomPanel(360, 640);
const frameW = 200;
const frameH = Math.round((template.height / template.width) * frameW);

check("four animated presets ship", HANDHELD_ANIMATED_PRESETS.length === 4, HANDHELD_ANIMATED_PRESETS.length);

for (const preset of HANDHELD_ANIMATED_PRESETS) {
  const fullFrames = renderAnimatedFrames(template, preset);
  check(`${preset.id} renders every frame`, fullFrames.length === preset.frames, fullFrames.length);

  // The scene animates: some frame differs from the first.
  const animates = fullFrames.some((frame, index) => index > 0 && frame.some((v, i) => v !== fullFrames[0][i]));
  check(`${preset.id} animates`, animates);

  // The scene stays inside the panel: no pixel above the panel is disturbed.
  const still = renderAnimatedFrames({ ...template }, { ...preset, frames: 1 })[0];
  const abovePanel = template.panel.hy * template.width * 4;
  const spilled = fullFrames.some((frame) => {
    for (let p = 0; p < abovePanel; p += 1) if (frame[p] !== still[p]) return true;
    return false;
  });
  check(`${preset.id} stays inside the marquee panel`, !spilled);

  // Bake -> data URL -> art gate: the console gets valid, playable art.
  const frames = fullFrames.map((frame) => downscale(frame, template.width, template.height, frameW, frameH));
  const url = sheetDataUrl(frames, frameW, frameH);
  check(`${preset.id} sheet fits the data-URL budget`, url.length <= MAX_ART_DATA_URL_CHARS, url.length);

  const art = normalizeArt({ url, w: frameW, h: frameH, frames: preset.frames, durationMs: preset.durationMs });
  check(`${preset.id} art passes the gate`, Boolean(art));
  check(`${preset.id} frame count preserved`, art?.frames === preset.frames, art?.frames);
  check(`${preset.id} duration preserved`, art?.durationMs === preset.durationMs, art?.durationMs);

  // The base scheme is a complete, valid scheme (kept alongside the art).
  const scheme = normalizeScheme(preset.scheme);
  check(`${preset.id} base scheme is valid`, Object.values(scheme).every((c) => /^#[0-9a-f]{6}$/.test(c)));
}

console.log(`PASS — verify-handheld-animation: ${checks} checks green.`);
