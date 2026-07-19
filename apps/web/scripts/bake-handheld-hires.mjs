/**
 * Asset-prep: bake crisp @2x chrome for the console chassis.
 *
 * The handheld chassis art is a fixed-resolution render (base.png is 867x1579 —
 * the cropped device body from template.aseprite). On a phone the console shows
 * it at ~1080-1290 physical pixels, so the browser bilinear-upscales it ~1.35x
 * and the chrome reads soft ("blurry, pixels not crisp"). Shipping a sharper 2x
 * asset that the browser DOWNSCALES to fit fixes this: downscaling never blurs,
 * and the edge detail is baked in with a Lanczos-3 resample plus a light unsharp
 * pass — genuinely crisper than the browser's own bilinear upscale.
 *
 * Only the console (one chassis, rendered once) loads the @2x template; the
 * onboarding picker keeps the 1x template because it recolours nine devices live
 * per turn. Because renderHandheld flat-fills each region, all the detail that
 * benefits from higher resolution lives in the scheme-independent chrome
 * (mask == 0) and the region boundaries, so a single offline bake serves every
 * custom colour without re-baking.
 *
 * Reads apps/web/public/handheld/{base,mask}.png and writes {base,mask}@2x.png
 * alongside them. Reproducible from the committed 1x assets (themselves produced
 * by extract-handheld.mjs). Run from the repo root:
 *   node apps/web/scripts/bake-handheld-hires.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const HANDHELD_DIR = path.resolve(here, "../public/handheld");

/** Upscale factor for the console chassis (covers phones up to ~DPR 4). */
const SCALE = 2;
/** Unsharp strength — restores edge acuity the resample softens, without haloing. */
const UNSHARP_AMOUNT = 0.55;
const UNSHARP_RADIUS = 1.1;

function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function writePng(file, width, height, data) {
  const png = new PNG({ width, height });
  png.data.set(data.subarray(0, width * height * 4));
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** Lanczos-3 kernel. */
function lanczos(x) {
  if (x === 0) return 1;
  const a = 3;
  if (x <= -a || x >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/**
 * Separable Lanczos-3 resize of an RGBA image. Alpha is resampled with the same
 * kernel; edges clamp. Returns a new RGBA buffer at the target size.
 */
function resizeLanczos(src, srcW, srcH, dstW, dstH) {
  const a = 3;
  // Precompute per-destination-pixel source taps for one axis.
  const buildTaps = (dstLen, srcLen) => {
    const ratio = srcLen / dstLen;
    const support = ratio > 1 ? a * ratio : a; // widen support when downscaling
    const scale = ratio > 1 ? 1 / ratio : 1;
    const taps = [];
    for (let d = 0; d < dstLen; d += 1) {
      const center = (d + 0.5) * ratio - 0.5;
      const left = Math.ceil(center - support);
      const right = Math.floor(center + support);
      const idx = [];
      const wts = [];
      let sum = 0;
      for (let s = left; s <= right; s += 1) {
        const w = lanczos((s - center) * scale);
        if (w === 0) continue;
        const clamped = s < 0 ? 0 : s >= srcLen ? srcLen - 1 : s;
        idx.push(clamped);
        wts.push(w);
        sum += w;
      }
      for (let i = 0; i < wts.length; i += 1) wts[i] /= sum;
      taps.push({ idx, wts });
    }
    return taps;
  };

  // Horizontal pass: srcW -> dstW, height unchanged.
  const hTaps = buildTaps(dstW, srcW);
  const mid = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y += 1) {
    const srcRow = y * srcW * 4;
    const dstRow = y * dstW * 4;
    for (let x = 0; x < dstW; x += 1) {
      const { idx, wts } = hTaps[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let i = 0; i < idx.length; i += 1) {
        const s = srcRow + idx[i] * 4;
        const w = wts[i];
        r += src[s] * w;
        g += src[s + 1] * w;
        b += src[s + 2] * w;
        al += src[s + 3] * w;
      }
      const d = dstRow + x * 4;
      mid[d] = r;
      mid[d + 1] = g;
      mid[d + 2] = b;
      mid[d + 3] = al;
    }
  }

  // Vertical pass: srcH -> dstH, width = dstW.
  const vTaps = buildTaps(dstH, srcH);
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const { idx, wts } = vTaps[y];
    const dstRow = y * dstW * 4;
    for (let x = 0; x < dstW; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      for (let i = 0; i < idx.length; i += 1) {
        const s = idx[i] * dstW * 4 + x * 4;
        const w = wts[i];
        r += mid[s] * w;
        g += mid[s + 1] * w;
        b += mid[s + 2] * w;
        al += mid[s + 3] * w;
      }
      const d = dstRow + x * 4;
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
      out[d + 3] = al;
    }
  }
  return out;
}

/** Separable Gaussian blur of the RGB channels (alpha copied). */
function gaussianBlurRgb(src, width, height, radius) {
  const sigma = radius;
  const half = Math.max(1, Math.ceil(sigma * 3));
  const kernel = [];
  let sum = 0;
  for (let i = -half; i <= half; i += 1) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

  const tmp = new Float32Array(width * height * 4);
  const out = new Float32Array(width * height * 4);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  // Horizontal.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -half; k <= half; k += 1) {
        const sx = clamp(x + k, 0, width - 1);
        const s = (y * width + sx) * 4;
        const w = kernel[k + half];
        r += src[s] * w;
        g += src[s + 1] * w;
        b += src[s + 2] * w;
      }
      const d = (y * width + x) * 4;
      tmp[d] = r;
      tmp[d + 1] = g;
      tmp[d + 2] = b;
    }
  }
  // Vertical.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = -half; k <= half; k += 1) {
        const sy = clamp(y + k, 0, height - 1);
        const s = (sy * width + x) * 4;
        const w = kernel[k + half];
        r += tmp[s] * w;
        g += tmp[s + 1] * w;
        b += tmp[s + 2] * w;
      }
      const d = (y * width + x) * 4;
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
    }
  }
  return out;
}

/** Unsharp mask: out = clamp(src + amount * (src - blur(src))). RGB only. */
function unsharpMask(src, width, height, amount, radius) {
  const blur = gaussianBlurRgb(src, width, height, radius);
  const out = new Uint8ClampedArray(src);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = src[i + c] + amount * (src[i + c] - blur[i + c]);
    }
    out[i + 3] = src[i + 3];
  }
  return out;
}

/** Nearest-neighbour upscale — the only correct resample for the region mask
 *  (its red channel packs discrete region ids that must not be interpolated). */
function resizeNearest(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const s = (sy * srcW + sx) * 4;
      const d = (y * dstW + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
}

const base = readPng(path.join(HANDHELD_DIR, "base.png"));
const mask = readPng(path.join(HANDHELD_DIR, "mask.png"));
if (base.width !== mask.width || base.height !== mask.height) {
  throw new Error(`base/mask size mismatch: ${base.width}x${base.height} vs ${mask.width}x${mask.height}`);
}

const dstW = base.width * SCALE;
const dstH = base.height * SCALE;

const baseHi = unsharpMask(
  resizeLanczos(base.data, base.width, base.height, dstW, dstH),
  dstW,
  dstH,
  UNSHARP_AMOUNT,
  UNSHARP_RADIUS,
);
writePng(path.join(HANDHELD_DIR, "base@2x.png"), dstW, dstH, baseHi);

const maskHi = resizeNearest(mask.data, mask.width, mask.height, dstW, dstH);
writePng(path.join(HANDHELD_DIR, "mask@2x.png"), dstW, dstH, maskHi);

console.log(`baked base@2x.png + mask@2x.png at ${dstW}x${dstH} (from ${base.width}x${base.height})`);
