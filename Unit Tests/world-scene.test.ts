/**
 * World-scene assembly tests — the /world demo's pure composition layer, driven
 * without a canvas. They assert structural facts about the assembled scene and
 * the snow system's motion rather than pixel output (that is covered by the scene
 * compositor's own tests): deterministic assembly per seed, the terrain sitting at
 * the origin with the monolith and floaters present, floaters hovering above the
 * terrain, snow starting inside its volume, and flakes falling and wrapping.
 */

import { describe, expect, it } from "vitest";
import type { Particle } from "@cartbox/editor";
import {
  buildWorldScene,
  sceneModelsAt,
  stepSnow,
  type SnowBounds,
} from "../apps/web/src/lib/worldScene";

// A small terrain keeps generation cheap while exercising the same code paths.
const SMALL = {
  terrain: { sizeX: 12, sizeZ: 12, sizeY: 12, baseHeight: 5, amplitude: 3, hillScale: 6, caveScale: 4, caveThreshold: 0.6, crust: 2, seed: 7 },
  snowCount: 40,
} as const;

describe("buildWorldScene", () => {
  it("centres the terrain at the origin and includes the monolith and floaters", () => {
    const scene = buildWorldScene(SMALL);
    expect(scene.terrain.position).toEqual([0, 0, 0]);
    expect(scene.props.length).toBeGreaterThan(0); // the sunk monolith
    expect(scene.floaters.length).toBe(3); // three handhelds
    expect(scene.snow.length).toBe(SMALL.snowCount);
    expect(scene.fitSpan).toBeGreaterThan(0);
  });

  it("floats every handheld above the terrain's top", () => {
    const scene = buildWorldScene(SMALL);
    const terrainTop = scene.terrain.model.sizeY / 2;
    for (const floater of scene.floaters) {
      expect(floater.base[1]).toBeGreaterThan(terrainTop);
    }
  });

  it("starts every snow flake inside the fall volume", () => {
    const scene = buildWorldScene(SMALL);
    const b = scene.snowBounds;
    for (const flake of scene.snow) {
      expect(Math.abs(flake.position[0])).toBeLessThanOrEqual(b.radiusX);
      expect(Math.abs(flake.position[2])).toBeLessThanOrEqual(b.radiusZ);
      expect(flake.position[1]).toBeGreaterThanOrEqual(b.minY);
      expect(flake.position[1]).toBeLessThanOrEqual(b.maxY);
    }
  });

  it("is deterministic for a given seed", () => {
    const a = buildWorldScene(SMALL);
    const b = buildWorldScene(SMALL);
    expect(a.snow.map((f) => f.position)).toEqual(b.snow.map((f) => f.position));
    expect(a.floaters.map((f) => f.base)).toEqual(b.floaters.map((f) => f.base));
  });
});

describe("sceneModelsAt", () => {
  it("returns terrain, props and floaters, and bobs the floaters over time", () => {
    const scene = buildWorldScene(SMALL);
    const expectedCount = 1 + scene.props.length + scene.floaters.length;

    const atZero = sceneModelsAt(scene, 0);
    const later = sceneModelsAt(scene, 1.0);
    expect(atZero.length).toBe(expectedCount);

    // The first floater's y differs between two times (it is bobbing).
    const floaterIndex = 1 + scene.props.length;
    expect(later[floaterIndex]!.position![1]).not.toBe(atZero[floaterIndex]!.position![1]);
    // The terrain never moves.
    expect(later[0]!.position).toEqual([0, 0, 0]);
  });
});

describe("stepSnow", () => {
  const bounds: SnowBounds = { radiusX: 10, radiusZ: 10, minY: -5, maxY: 15 };

  it("lowers a flake as it falls", () => {
    const flakes: Particle[] = [{ position: [0, 10, 0], r: 255, g: 255, b: 255 }];
    stepSnow(flakes, bounds, 0.1, () => 0.5);
    expect(flakes[0]!.position[1]).toBeLessThan(10);
  });

  it("wraps a flake back to the top once it passes the floor", () => {
    const flakes: Particle[] = [{ position: [3, -4.9, 3], r: 255, g: 255, b: 255 }];
    // A large step pushes it below minY; it must reappear at the top of the volume.
    stepSnow(flakes, bounds, 1, () => 0.5);
    expect(flakes[0]!.position[1]).toBe(bounds.maxY);
    expect(Math.abs(flakes[0]!.position[0])).toBeLessThanOrEqual(bounds.radiusX);
  });
});
