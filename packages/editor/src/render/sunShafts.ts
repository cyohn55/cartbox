/**
 * Sun shafts (HALO2_STYLE_ROADMAP.md, H7): light streaking from the sun through
 * gaps in the scene — the beams between Lockout's towers at low sun.
 *
 * A screen-space pass over the finished frame, so it is the same on every
 * backend. What shines is the sky: a scene drawn over a sky backdrop leaves the
 * sky's pixels untouched, so comparing the frame with the backdrop tells which
 * pixels are open sky and which geometry blocks. Bright open sky near the sun is
 * the light source; each pixel gathers it along the line toward the sun (a
 * radial blur, fading with distance), so gaps between occluders become beams.
 * It runs at a reduced resolution and is added back smoothly.
 */

import type { Mat4 } from "./meshRasterizer";

type Rgb = readonly [number, number, number];

/** Authored sun shafts. */
export interface SunShafts {
  /** Brightness of the beams, 0 (none) .. 2. */
  readonly strength: number;
  /** How far the beams reach, as a fraction of the way toward the sun (0.05..1). */
  readonly length: number;
}

/** Samples marched toward the sun per pixel. */
export const SHAFT_SAMPLES = 24;
/** The pass runs at most this many pixels wide. */
export const SHAFT_MAX_WIDTH = 160;
/** Sky brighter than this (0..1 luminance) lights the shafts. */
const SHAFT_THRESHOLD = 0.55;
/** Sources within this fraction of the screen diagonal of the sun shine. */
const SHAFT_SOURCE_REACH = 0.35;
/** Scales the gathered light so strength 1 reads as full beams. */
const SHAFT_EXPOSURE = 1.6;
/** Open sky takes this share of the light, so the beams read over the scene rather than washing out the sky. */
const SHAFT_SKY_SHARE = 0.35;

/**
 * Where the sun sits on screen (pixels, y down), from the direction toward it,
 * or null when it is behind the camera. It may lie off screen — shafts still
 * streak in from the edge.
 */
export function sunScreenPosition(
  toSun: readonly [number, number, number],
  view: Mat4,
  projection: Mat4,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const len = Math.hypot(toSun[0], toSun[1], toSun[2]) || 1;
  const d = [toSun[0] / len, toSun[1] / len, toSun[2] / len];
  // A direction is a point at infinity (w = 0): only the view's rotation applies.
  const ex = view[0]! * d[0]! + view[4]! * d[1]! + view[8]! * d[2]!;
  const ey = view[1]! * d[0]! + view[5]! * d[1]! + view[9]! * d[2]!;
  const ez = view[2]! * d[0]! + view[6]! * d[1]! + view[10]! * d[2]!;
  const cx = projection[0]! * ex + projection[4]! * ey + projection[8]! * ez;
  const cy = projection[1]! * ex + projection[5]! * ey + projection[9]! * ez;
  const cw = projection[3]! * ex + projection[7]! * ey + projection[11]! * ez;
  if (cw <= 1e-4) return null;
  return { x: (cx / cw * 0.5 + 0.5) * width, y: (1 - (cy / cw * 0.5 + 0.5)) * height };
}

/** Reusable buffers for {@link applySunShafts}, so a running game allocates nothing per frame. */
export interface ShaftScratch {
  mask: Float32Array;
  light: Float32Array;
}

/**
 * The light-source mask at reduced resolution: bright open sky near the sun,
 * zero where geometry covers it. `step` is how many frame pixels one cell spans.
 */
export function shaftSourceMask(
  frame: ArrayLike<number>,
  sky: ArrayLike<number>,
  width: number,
  height: number,
  sun: { x: number; y: number },
  step: number,
  out: Float32Array,
): { width: number; height: number } {
  const lw = Math.ceil(width / step);
  const lh = Math.ceil(height / step);
  const diag = Math.hypot(width, height);
  for (let j = 0; j < lh; j += 1) {
    const y = Math.min(height - 1, Math.floor(j * step + step / 2));
    for (let i = 0; i < lw; i += 1) {
      const x = Math.min(width - 1, Math.floor(i * step + step / 2));
      const p = (y * width + x) * 4;
      let m = 0;
      if (frame[p] === sky[p] && frame[p + 1] === sky[p + 1] && frame[p + 2] === sky[p + 2]) {
        const lum = (0.2126 * sky[p]! + 0.7152 * sky[p + 1]! + 0.0722 * sky[p + 2]!) / 255;
        const bright = Math.max(0, lum - SHAFT_THRESHOLD) / (1 - SHAFT_THRESHOLD);
        const near = Math.max(0, 1 - Math.hypot(x - sun.x, y - sun.y) / (diag * SHAFT_SOURCE_REACH));
        m = bright * near * near;
      }
      out[j * lw + i] = m;
    }
  }
  return { width: lw, height: lh };
}

/**
 * Add sun shafts to `frame` (RGBA8, in place). `sky` is the backdrop the scene
 * was drawn over (same size); `sun` is from {@link sunScreenPosition}.
 */
export function applySunShafts(
  frame: Uint8ClampedArray,
  sky: ArrayLike<number>,
  width: number,
  height: number,
  sun: { x: number; y: number },
  color: Rgb,
  shafts: SunShafts,
  scratch?: ShaftScratch,
): void {
  if (shafts.strength <= 0 || width <= 0 || height <= 0) return;
  const step = Math.max(1, Math.ceil(width / SHAFT_MAX_WIDTH));
  const cells = Math.ceil(width / step) * Math.ceil(height / step);
  const mask = scratch && scratch.mask.length >= cells ? scratch.mask : new Float32Array(cells);
  const light = scratch && scratch.light.length >= cells ? scratch.light : new Float32Array(cells);
  if (scratch) {
    scratch.mask = mask;
    scratch.light = light;
  }
  const { width: lw, height: lh } = shaftSourceMask(frame, sky, width, height, sun, step, mask);
  // Gather the source along the whole line to the sun (in cell units): where
  // an occluder crosses that line the pixel is in its shadow, where the line
  // runs through a gap it is lit — the beams. They fade with distance from the
  // sun, reaching `length` of the screen diagonal.
  const sx = sun.x / step - 0.5;
  const sy = sun.y / step - 0.5;
  const reach = Math.max(0.05, Math.min(1, shafts.length)) * Math.hypot(lw, lh);
  let peak = 0;
  for (let j = 0; j < lh; j += 1) {
    for (let i = 0; i < lw; i += 1) {
      const fall = Math.max(0, 1 - Math.hypot(sx - i, sy - j) / reach);
      if (fall <= 0) {
        light[j * lw + i] = 0;
        continue;
      }
      let acc = 0;
      for (let s = 0; s < SHAFT_SAMPLES; s += 1) {
        const t = (s + 0.5) / SHAFT_SAMPLES;
        const xi = Math.round(i + (sx - i) * t);
        const yi = Math.round(j + (sy - j) * t);
        if (xi >= 0 && yi >= 0 && xi < lw && yi < lh) acc += mask[yi * lw + xi]!;
      }
      const v = (acc / SHAFT_SAMPLES) * fall * fall * SHAFT_EXPOSURE * shafts.strength;
      light[j * lw + i] = v;
      if (v > peak) peak = v;
    }
  }
  if (peak <= 1e-4) return;
  // Add back at full resolution, bilinear between cells.
  const cr = color[0] * 255;
  const cg = color[1] * 255;
  const cb = color[2] * 255;
  for (let y = 0; y < height; y += 1) {
    const fy = Math.max(0, Math.min(lh - 1, (y + 0.5) / step - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(lh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.max(0, Math.min(lw - 1, (x + 0.5) / step - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(lw - 1, x0 + 1);
      const tx = fx - x0;
      const top = light[y0 * lw + x0]! * (1 - tx) + light[y0 * lw + x1]! * tx;
      const bottom = light[y1 * lw + x0]! * (1 - tx) + light[y1 * lw + x1]! * tx;
      let v = top * (1 - ty) + bottom * ty;
      if (v <= 1e-4) continue;
      const p = (y * width + x) * 4;
      if (frame[p] === sky[p] && frame[p + 1] === sky[p + 1] && frame[p + 2] === sky[p + 2]) v *= SHAFT_SKY_SHARE;
      frame[p] = frame[p]! + cr * v;
      frame[p + 1] = frame[p + 1]! + cg * v;
      frame[p + 2] = frame[p + 2]! + cb * v;
    }
  }
}

/**
 * How much of the sun is unblocked (0..1), for the glare and lens flare
 * (HALO2_STYLE_ROADMAP.md, H8): the share of taps over a small disc round the
 * sun that still show the sky backdrop. Taps off the frame count as hidden, so
 * the flare fades as the sun leaves the screen.
 */
export function sunVisibility(
  frame: ArrayLike<number>,
  sky: ArrayLike<number>,
  width: number,
  height: number,
  sun: { x: number; y: number },
): number {
  const radius = Math.max(1.5, height * 0.012);
  let open = 0;
  let taps = 0;
  const tap = (x: number, y: number) => {
    taps += 1;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const p = (yi * width + xi) * 4;
    if (frame[p] === sky[p] && frame[p + 1] === sky[p + 1] && frame[p + 2] === sky[p + 2]) open += 1;
  };
  tap(sun.x, sun.y);
  for (const ring of [0.5, 1]) {
    for (let k = 0; k < 8; k += 1) {
      const a = (k / 8) * Math.PI * 2 + ring;
      tap(sun.x + Math.cos(a) * radius * ring, sun.y + Math.sin(a) * radius * ring);
    }
  }
  return open / taps;
}
