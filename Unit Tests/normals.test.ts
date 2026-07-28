/**
 * Normal-map + lighting tests. The lighting formula and normal encoding are
 * pure, so they're tested directly here — the CPU preview and the (coming)
 * WebGPU shader both run this exact `shade` math. NormalMap is tested over the
 * real StubCartEngine, including that normals land in the normal bank.
 */

import { describe, expect, it } from "vitest";
import {
  NORMAL_BANK,
  NormalMap,
  StubCartEngine,
  nearestDirection,
  normalVector,
  renderLitRgba,
  shade,
} from "@cartbox/editor";

describe("lighting.shade", () => {
  it("fully lights a surface facing the light", () => {
    expect(shade([200, 100, 50], [0, 0, 1], [0, 0, 1], 0)).toEqual([200, 100, 50]);
  });

  it("drops to the ambient floor when the light grazes edge-on", () => {
    expect(shade([200, 100, 50], [0, 0, 1], [1, 0, 0], 0.5)).toEqual([100, 50, 25]);
  });

  it("goes black in shadow with no ambient", () => {
    expect(shade([255, 255, 255], [0, 0, 1], [0, 0, -1], 0)).toEqual([0, 0, 0]);
  });
});

describe("renderLitRgba (CPU renderer / WebGPU fallback)", () => {
  const albedo = new Uint8ClampedArray([200, 100, 50, 255]);
  const flatNormal = new Uint8ClampedArray([128, 128, 255, 255]); // faces the camera

  it("fully lights a flat pixel under a light directly above it", () => {
    const lit = renderLitRgba(albedo, flatNormal, 1, 1, { col: 0.5, row: 0.5, height: 1, ambient: 0 });
    expect([lit[0], lit[1], lit[2], lit[3]]).toEqual([200, 100, 50, 255]);
  });

  it("darkens a flat pixel when the light is off to the side", () => {
    const lit = renderLitRgba(albedo, flatNormal, 1, 1, { col: 6, row: 0.5, height: 0.1, ambient: 0 });
    expect(lit[0]).toBeLessThan(albedo[0]!);
  });
});

describe("normal directions", () => {
  it("makes direction 0 face the camera", () => {
    expect(normalVector(0)).toEqual([0, 0, 1]);
  });

  it("snaps a vector to the nearest direction index", () => {
    expect(nearestDirection([0, 0, 1])).toBe(0);
    expect(nearestDirection([0, -1, 0.4])).toBe(1); // up (north)
    expect(nearestDirection([1, 0, 0.4])).toBe(3); // right (east)
  });
});

describe("NormalMap", () => {
  it("round-trips a pixel's direction", () => {
    const map = new NormalMap(new StubCartEngine());
    map.setDirection(0, 5, 2, 3, 7);
    expect(map.getDirection(0, 5, 2, 3)).toBe(7);
  });

  it("stores normals in the normal bank, not the game banks", () => {
    const engine = new StubCartEngine();
    new NormalMap(engine).setDirection(0, 5, 2, 3, 7);
    engine.setBank(0);
    expect(engine.getPixel(0, 5, 2, 3)).toBe(0); // bank 0 sprite untouched
    engine.setBank(NORMAL_BANK);
    expect(engine.getPixel(0, 5, 2, 3)).toBe(7); // lives in the normal bank
  });

  it("opens with non-flat seeded normals on the mascot", () => {
    const map = new NormalMap(new StubCartEngine());
    const directions = new Set<number>();
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) directions.add(map.getDirection(0, 1, x, y));
    }
    expect(directions.size).toBeGreaterThan(1);
  });
});
