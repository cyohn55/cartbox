/**
 * Unit tests for the handheld's glass geometry — the shipped chassis assets and
 * the layout measured from them.
 *
 * These guard the asset pipeline, which has an order dependency that is easy to
 * get wrong: `extract-handheld.mjs` regenerates base.png/mask.png from the
 * .aseprite, `reshape-handheld-glass.mjs` enlarges the glass, and
 * `measure-handheld-layout.mjs` derives handheld-layout.json from the result.
 * Re-running extract without reshape silently reverts the glass and leaves the
 * layout pointing at a hole that is no longer there, which the app renders as a
 * misplaced screen. Every assertion below measures the actual shipped pixels, so
 * that desync fails here rather than in the browser.
 *
 * Run with:
 *   npx vitest run
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

const HANDHELD_DIR = path.resolve(process.cwd(), "apps/web/public/handheld");

/**
 * Share of the chassis the glass must cover. The thin-bezel reshape takes it to
 * ~40%; the pre-reshape art sat at 32%. A floor between the two is what catches a
 * reverted asset without pinning the exact art.
 */
const MINIMUM_GLASS_COVERAGE = 0.36;

/** A rect in 0..1 fractions of the art, as handheld-layout.json stores them. */
interface FractionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  aspect: number;
  screen: FractionRect;
  dpad: FractionRect;
  wheel: FractionRect;
  buttons: Record<string, FractionRect>;
  shoulders: Record<string, FractionRect>;
  system: Record<string, FractionRect>;
}

function readLayout(): Layout {
  return JSON.parse(fs.readFileSync(path.join(HANDHELD_DIR, "handheld-layout.json"), "utf8"));
}

function readPng(name: string): { width: number; height: number; data: Buffer } {
  return PNG.sync.read(fs.readFileSync(path.join(HANDHELD_DIR, name)));
}

interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The glass, found the way the app's own measuring step finds it: the largest
 * fully-enclosed transparent region in the upper part of the art. The background
 * around the chassis is transparent too but touches the border, and the cart slot
 * is enclosed but sits low.
 */
function findGlass(base: { width: number; height: number; data: Buffer }): PixelBox {
  const { width, height, data } = base;
  const seen = new Uint8Array(width * height);
  let best: (PixelBox & { area: number }) | null = null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (seen[start] || data[start * 4 + 3] >= 40) continue;

      const box = { x0: width, y0: height, x1: -1, y1: -1 };
      let area = 0;
      let touchesEdge = false;
      const stack = [start];
      seen[start] = 1;

      while (stack.length) {
        const p = stack.pop() as number;
        const px = p % width;
        const py = (p / width) | 0;
        if (px === 0 || py === 0 || px === width - 1 || py === height - 1) touchesEdge = true;
        box.x0 = Math.min(box.x0, px);
        box.y0 = Math.min(box.y0, py);
        box.x1 = Math.max(box.x1, px);
        box.y1 = Math.max(box.y1, py);
        area += 1;

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const np = ny * width + nx;
          if (!seen[np] && data[np * 4 + 3] < 40) {
            seen[np] = 1;
            stack.push(np);
          }
        }
      }

      if (touchesEdge) continue;
      if ((box.y0 + box.y1) / 2 > height * 0.6) continue;
      if (!best || area > best.area) best = { ...box, area };
    }
  }

  if (!best) throw new Error("No enclosed transparent glass found in base.png.");
  const { area: _area, ...box } = best;
  return box;
}

const overlaps = (a: FractionRect, b: FractionRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("handheld glass geometry", () => {
  const layout = readLayout();
  const base = readPng("base.png");
  const mask = readPng("mask.png");
  const glass = findGlass(base);

  it("layout's screen rect matches the transparent hole actually in the art", () => {
    // A whole-pixel tolerance: the layout stores fractions, so round-tripping
    // through them cannot be exact.
    const measured = {
      x: glass.x0 / base.width,
      y: glass.y0 / base.height,
      w: (glass.x1 - glass.x0 + 1) / base.width,
      h: (glass.y1 - glass.y0 + 1) / base.height,
    };
    const tolerance = 1 / base.width;

    expect(layout.screen.x).toBeCloseTo(measured.x, 5);
    expect(layout.screen.y).toBeCloseTo(measured.y, 5);
    expect(Math.abs(layout.screen.w - measured.w)).toBeLessThan(tolerance);
    expect(Math.abs(layout.screen.h - measured.h)).toBeLessThan(tolerance);
  });

  it("base and mask describe the same canvas", () => {
    expect(mask.width).toBe(base.width);
    expect(mask.height).toBe(base.height);
    expect(layout.aspect).toBeCloseTo(base.width / base.height, 6);
  });

  it("glass covers the reshaped share of the chassis", () => {
    const coverage = layout.screen.w * layout.screen.h;
    expect(coverage).toBeGreaterThan(MINIMUM_GLASS_COVERAGE);
  });

  it("glass overlaps no control hit-area", () => {
    const controls: Array<[string, FractionRect]> = [
      ["dpad", layout.dpad],
      ["wheel", layout.wheel],
      ...Object.entries(layout.buttons),
      ...Object.entries(layout.shoulders),
      ...Object.entries(layout.system),
    ];

    for (const [name, rect] of controls) {
      expect(overlaps(layout.screen, rect), `screen overlaps ${name}`).toBe(false);
    }
  });

  it("glass stays centred on the scroll wheel, which is drawn into its lower bezel", () => {
    const screenCentre = layout.screen.x + layout.screen.w / 2;
    const wheelCentre = layout.wheel.x + layout.wheel.w / 2;
    // The wheel housing is baked into the bottom band, so a drifting glass centre
    // would shear it off its own recess. The art's own centres sit 1px apart (they
    // did before the reshape too, which preserves the offset exactly), so the
    // meaningful bound is a couple of pixels, not zero.
    const tolerancePixels = 2;
    expect(Math.abs(screenCentre - wheelCentre)).toBeLessThan(tolerancePixels / base.width);
  });

  it("no transparent pixel carries a recolour region id", () => {
    // Region ids drive the chassis recolour. A transparent pixel holding one means
    // the glass (or the background) would be painted over by a colour scheme.
    let leaked = 0;
    for (let pixel = 0; pixel < base.width * base.height; pixel += 1) {
      if (base.data[pixel * 4 + 3] < 40 && mask.data[pixel * 4] !== 0) leaked += 1;
    }
    expect(leaked).toBe(0);
  });

  it("glass interior is fully transparent", () => {
    // The reshape punches a chamfered rect; sample well inside the chamfer so the
    // corner stairs are not counted.
    const inset = Math.round((glass.x1 - glass.x0) * 0.1);
    let opaque = 0;
    for (let y = glass.y0 + inset; y <= glass.y1 - inset; y += 1) {
      for (let x = glass.x0 + inset; x <= glass.x1 - inset; x += 1) {
        if (base.data[(y * base.width + x) * 4 + 3] >= 40) opaque += 1;
      }
    }
    expect(opaque).toBe(0);
  });
});
