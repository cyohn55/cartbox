/**
 * Tests for the filled-shape point generators added to the sprite editor's tools
 * (upgrade #3). They validate real geometry: exact interior coverage for a
 * rectangle and a monotone, gap-free, symmetric fill for an ellipse — asserted
 * against the actual returned points, not hard-coded snapshots.
 */

import { describe, expect, it } from "vitest";

import { rectFillPoints, ellipseFillPoints, rectOutlinePoints } from "../apps/web/src/app/edit/[cartId]/shapeTools";

const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

describe("rectFillPoints", () => {
  it("covers every interior pixel exactly once, corner order independent", () => {
    const a = rectFillPoints(2, 1, 4, 3);
    const b = rectFillPoints(4, 3, 2, 1); // reversed corners
    // 3×3 box → 9 pixels, no duplicates.
    expect(a).toHaveLength(9);
    expect(new Set(a.map(key)).size).toBe(9);
    expect(new Set(a.map(key))).toEqual(new Set(b.map(key)));
    // The outline is a strict subset of the fill.
    for (const p of rectOutlinePoints(2, 1, 4, 3)) {
      expect(a.some((q) => q.x === p.x && q.y === p.y)).toBe(true);
    }
  });

  it("fills a single-pixel box", () => {
    expect(rectFillPoints(5, 5, 5, 5)).toEqual([{ x: 5, y: 5 }]);
  });
});

describe("ellipseFillPoints", () => {
  it("is contained in its bounding box and covers the centre", () => {
    const pts = ellipseFillPoints(0, 0, 10, 6);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(6);
    }
    expect(pts.some((p) => p.x === 5 && p.y === 3)).toBe(true); // centre filled
    // Corners of the box are OUTSIDE the ellipse, so they must not be filled.
    expect(pts.some((p) => p.x === 0 && p.y === 0)).toBe(false);
  });

  it("produces a horizontally symmetric fill and no interior gaps per row", () => {
    const w = 12;
    const pts = ellipseFillPoints(0, 0, w, 8);
    const rows = new Map<number, number[]>();
    for (const p of pts) {
      const xs = rows.get(p.y) ?? [];
      xs.push(p.x);
      rows.set(p.y, xs);
    }
    for (const xs of rows.values()) {
      xs.sort((m, n) => m - n);
      // Contiguous span (no gaps).
      for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBe(1);
      // Symmetric about the ellipse centre x = w/2.
      expect(xs[0]! + xs[xs.length - 1]!).toBe(w);
    }
  });
});
