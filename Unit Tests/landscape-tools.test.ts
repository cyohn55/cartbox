/**
 * Landscape tools (EDITOR_PRO_ROADMAP.md P2a): erosion that moves ground
 * without making or losing it and is the same every time, stamps, ramps,
 * and 16-bit heightmaps out and back in.
 */

import { describe, expect, it } from "vitest";

import {
  decodePngSamples,
  encodeRgbaPng,
  exportHeightmap,
  hydraulicErosion,
  importHeightmap,
  newTerrain,
  rampTerrain,
  stampTerrain,
  terraceHeight,
  thermalErosion,
  type Terrain,
} from "@cartbox/editor";

/** A 64 m terrain, 65 heights a side, with a cone of a hill and some ripples. */
function hill(): Terrain {
  const t = newTerrain("t", { size: 64, samples: 65 });
  const heights = new Float32Array(65 * 65);
  for (let j = 0; j < 65; j += 1) {
    for (let i = 0; i < 65; i += 1) {
      const d = Math.hypot(i - 32, j - 32);
      heights[j * 65 + i] = Math.max(0, 20 - d * 0.9) + Math.sin(i * 0.7) * Math.cos(j * 0.5) * 0.6;
    }
  }
  return { ...t, heights };
}

const total = (t: Terrain) => t.heights.reduce((s, h) => s + h, 0);
const steepest = (t: Terrain) => {
  let worst = 0;
  for (let j = 0; j < t.samples; j += 1) for (let i = 1; i < t.samples; i += 1) worst = Math.max(worst, Math.abs(t.heights[j * t.samples + i]! - t.heights[j * t.samples + i - 1]!));
  return worst;
};

describe("landscape tools", () => {
  it("hydraulic erosion moves ground without making or losing any, and is deterministic", () => {
    const t = hill();
    const a = hydraulicErosion(t, { droplets: 6000, seed: 7 });
    expect(Math.abs(total(a) - total(t))).toBeLessThan(total(t) * 1e-5);
    // It changed the ground, and the same seed gives the same ground.
    let moved = 0;
    for (let k = 0; k < t.heights.length; k += 1) moved += Math.abs(a.heights[k]! - t.heights[k]!);
    expect(moved).toBeGreaterThan(10);
    expect(hydraulicErosion(t, { droplets: 6000, seed: 7 }).heights).toEqual(a.heights);
    expect(hydraulicErosion(t, { droplets: 6000, seed: 8 }).heights).not.toEqual(a.heights);
    expect(t.heights[32 * 65 + 32]).toBeCloseTo(20 + Math.sin(32 * 0.7) * Math.cos(16) * 0.6, 4); // untouched input
  });

  it("thermal erosion conserves ground and slumps slopes steeper than the talus", () => {
    const t = hill();
    // A sheer step: 10 m over one cell.
    const step = Float32Array.from(t.heights);
    for (let j = 0; j < 65; j += 1) for (let i = 40; i < 65; i += 1) step[j * 65 + i] = step[j * 65 + i]! + 10;
    const cliff = { ...t, heights: step };
    const out = thermalErosion(cliff, { iterations: 60, talus: 35 });
    expect(Math.abs(total(out) - total(cliff))).toBeLessThan(total(cliff) * 1e-5);
    expect(steepest(out)).toBeLessThan(steepest(cliff) * 0.5);
    expect(thermalErosion(cliff, { iterations: 60, talus: 35 }).heights).toEqual(out.heights);
    // A gentle slope under the talus stays put.
    const gentle = { ...t, heights: Float32Array.from({ length: 65 * 65 }, (_, k) => (k % 65) * 0.1) };
    expect(thermalErosion(gentle, { iterations: 20, talus: 30 }).heights).toEqual(gentle.heights);
  });

  it("erodes only inside a region's brush when given one", () => {
    const t = hill();
    const out = hydraulicErosion(t, { droplets: 3000, seed: 1 }, { x: 16, z: 32, radius: 8, strength: 1 });
    // Far from the brush, nothing moves.
    expect(out.heights[32 * 65 + 60]).toBe(t.heights[32 * 65 + 60]);
    let inside = 0;
    for (let j = 26; j <= 38; j += 1) for (let i = 10; i <= 22; i += 1) inside += Math.abs(out.heights[j * 65 + i]! - t.heights[j * 65 + i]!);
    expect(inside).toBeGreaterThan(0.1);
  });

  it("stamps hills and ridges up, and terraces ground into treads and risers", () => {
    const flat = newTerrain("t", { size: 64, samples: 65 });
    const hills = stampTerrain(flat, { kind: "hills", seed: 3 }, { x: 32, z: 32, radius: 10, strength: 1 });
    expect(Math.max(...hills.heights)).toBeGreaterThan(0.3);
    expect(hills.heights[0]).toBe(0);
    expect(stampTerrain(flat, { kind: "ridges", seed: 3 }, { x: 32, z: 32, radius: 10, strength: 1 }).heights).not.toEqual(hills.heights);
    // Terraces: treads are flat at multiples of the step.
    expect(terraceHeight(3.1, 2)).toBeCloseTo(2, 6);
    expect(terraceHeight(3.5, 2)).toBeCloseTo(2, 6);
    expect(terraceHeight(3.999, 2)).toBeCloseTo(4, 1);
    const ramp = { ...flat, heights: Float32Array.from({ length: 65 * 65 }, (_, k) => (k % 65) * 0.25) };
    const stepped = stampTerrain(ramp, { kind: "terraces", step: 2 }, { x: 32, z: 32, radius: 200, strength: 1 });
    const row = Array.from({ length: 65 }, (_, i) => stepped.heights[32 * 65 + i]!);
    // Most of the row sits on a tread.
    expect(row.filter((h) => Math.abs(h / 2 - Math.round(h / 2)) < 0.02).length).toBeGreaterThan(40);
  });

  it("lays a ramp from one end's height to the other's", () => {
    const t = { ...newTerrain("t", { size: 64, samples: 65 }), heights: Float32Array.from({ length: 65 * 65 }, (_, k) => (Math.floor(k / 65) > 40 ? 8 : 0)) };
    const out = rampTerrain(t, [32, 20], [32, 50], 6, { edge: 2 });
    const along = (z: number) => out.heights[z * 65 + 32]!;
    expect(along(20)).toBeCloseTo(0, 4);
    expect(along(50)).toBeCloseTo(8, 4);
    expect(along(35)).toBeCloseTo(4, 1);
    // Rising steadily along the centre line.
    for (let z = 21; z <= 50; z += 1) expect(along(z)).toBeGreaterThanOrEqual(along(z - 1) - 1e-5);
    // Beyond the shoulders the ground is left be.
    expect(out.heights[35 * 65 + 10]).toBe(0);
  });

  it("round-trips heights through a 16-bit heightmap carrying its own range", async () => {
    const t = hill();
    const { png, min, max } = exportHeightmap(t);
    const decoded = await decodePngSamples(png);
    expect([decoded.width, decoded.height]).toEqual([65, 65]);
    const back = await importHeightmap({ ...t, heights: new Float32Array(65 * 65) }, png, [0, 1]);
    const tolerance = (max - min) / 65535 + 1e-4;
    for (let k = 0; k < t.heights.length; k += 1) expect(Math.abs(back.heights[k]! - t.heights[k]!)).toBeLessThanOrEqual(tolerance);
  });

  it("imports an 8-bit colour heightmap over the given range, resampled to the grid", async () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) rgba.set([x * 85, 0, 0, 255], (y * 4 + x) * 4);
    const t = newTerrain("t", { size: 16, samples: 7 });
    const out = await importHeightmap(t, encodeRgbaPng(rgba, 4, 4, { compress: true }), [0, 30]);
    expect(out.heights[0]).toBeCloseTo(0, 4);
    expect(out.heights[6]).toBeCloseTo(30, 4);
    expect(out.heights[3]).toBeCloseTo(15, 4);
    await expect(importHeightmap(t, new Uint8Array([1, 2, 3]), [0, 1])).rejects.toThrow(/PNG/);
  });
});
