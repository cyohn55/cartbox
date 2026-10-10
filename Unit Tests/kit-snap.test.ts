/**
 * Kit snapping (HALO_INFINITE_STYLE_ROADMAP.md I14): a piece dragged near
 * another snaps to it edge to edge — faces touching, edges flush.
 */

import { describe, expect, it } from "vitest";
import { kitSnap, type Aabb } from "@/lib/kitSnap";

const box = (x: number, y: number, z: number, w = 2, h = 3, d = 0.5): Aabb => ({ min: [x, y, z], max: [x + w, y + h, z + d] });
const moved = (b: Aabb, d: readonly number[]): Aabb => ({ min: b.min.map((v, k) => v + d[k]!), max: b.max.map((v, k) => v + d[k]!) });

describe("kit snapping", () => {
  const wall = box(0, 0, 0);

  it("closes a small gap so the next wall section continues the run, floors and faces flush", () => {
    // Dragged a little past the end, slightly high and slightly forward.
    const next = box(2.2, 0.1, -0.15);
    const snap = kitSnap(next, [wall])!;
    expect(snap.axis).toBe(0);
    const placed = moved(next, snap.delta);
    expect(placed.min[0]).toBeCloseTo(2, 9);
    expect(placed.min[1]).toBeCloseTo(0, 9);
    expect(placed.min[2]).toBeCloseTo(0, 9);
  });

  it("stacks a piece on top, centred or flush, and pulls back one that overlaps", () => {
    const cap = box(0.15, 3.2, -0.1, 1.7, 0.4, 0.7);
    const placed = moved(cap, kitSnap(cap, [wall])!.delta);
    expect(placed.min[1]).toBeCloseTo(3, 9);
    expect((placed.min[0]! + placed.max[0]!) / 2).toBeCloseTo(1, 9);
    expect((placed.min[2]! + placed.max[2]!) / 2).toBeCloseTo(0.25, 9);
    // Overlapping the wall's end by a little: pushed back to touch it, not through it.
    const pushed = box(1.8, 0, 0);
    expect(moved(pushed, kitSnap(pushed, [wall])!.delta).min[0]).toBeCloseTo(2, 9);
  });

  it("snaps to the nearest of several, and not at all when nothing is near", () => {
    const far = box(10, 0, 0);
    const next = box(12.1, 0, 0);
    expect(kitSnap(next, [wall, far])!.target).toBe(1);
    expect(kitSnap(box(5, 0, 0), [wall, far])).toBeNull();
    // Beside it but off its end entirely (not facing it): no snap.
    expect(kitSnap(box(0, 0, 3), [wall])).toBeNull();
  });
});
