/**
 * Reading a surface out of tile art.
 *
 * A tile is albedo; a *material* also says which way each texel faces and how it
 * takes light. These drive the real derivation with real art and assert on the
 * channels it produces, because the failures here are quiet ones — a normal map
 * that is subtly inverted looks lit from the wrong side rather than broken, and a
 * height field that reads a sprite's transparent holes as pits carves a trench
 * around every silhouette.
 */

import { describe, expect, it } from "vitest";

import {
  MATTE_FINISH,
  heightFromArt,
  luminance,
  normalsFromHeight,
  withDerivedSurface,
  type FaceTexture,
} from "@cartbox/editor";

/** A tile built from a function of its coordinates, fully opaque. */
function tileFrom(size: number, shade: (x: number, y: number) => number): FaceTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const base = (y * size + x) * 4;
      const value = shade(x, y);
      data[base] = value;
      data[base + 1] = value;
      data[base + 2] = value;
      data[base + 3] = 255;
    }
  }
  return { size, data };
}

/** The decoded tangent-space normal at a texel. */
function normalAt(normals: Uint8Array, size: number, x: number, y: number): [number, number, number] {
  const base = (y * size + x) * 3;
  return [
    normals[base]! / 127.5 - 1,
    normals[base + 1]! / 127.5 - 1,
    normals[base + 2]! / 127.5 - 1,
  ];
}

describe("height read from the art", () => {
  it("follows the art's own light and shade", () => {
    // A ramp from dark to light across the tile must come back as a ramp.
    const tile = tileFrom(8, (x) => x * 32);
    const height = heightFromArt(tile, 1);

    for (let x = 1; x < 8; x += 1) {
      expect(height[x]!).toBeGreaterThan(height[x - 1]!);
    }
  });

  it("weights green over blue, as the eye does", () => {
    // Pure green must read as far higher than pure blue of the same magnitude,
    // or relief derived from colourful art disagrees with how the art looks.
    expect(luminance(0, 255, 0)).toBeGreaterThan(luminance(0, 0, 255) * 5);
  });

  it("flattens as the relief setting drops", () => {
    const tile = tileFrom(8, (x) => x * 32);
    const strong = heightFromArt(tile, 1);
    const weak = heightFromArt(tile, 0.25);
    const spread = (values: Uint8Array) => Math.max(...values) - Math.min(...values);

    expect(spread(weak)).toBeLessThan(spread(strong));
    expect(spread(heightFromArt(tile, 0))).toBe(0);
  });

  it("gives a transparent texel the tile's own mean, not a pit", () => {
    // The property a sprite silhouette depends on: a hole has no height, and
    // reading it as zero would ring every drawn shape with a cliff.
    const tile = tileFrom(8, () => 200);
    tile.data[3] = 0; // punch a hole at (0, 0)
    const height = heightFromArt(tile, 1);

    expect(height[0]).toBe(height[1]);
  });
});

describe("normals derived from height", () => {
  it("tilts away from the rising side", () => {
    // Height climbing with x means the surface faces back toward -x.
    const height = new Uint8Array(64);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) height[y * 8 + x] = x * 30;
    }
    const normals = normalsFromHeight(height, 8, 0.5);
    const [nx, ny, nz] = normalAt(normals, 8, 4, 4);

    expect(nx).toBeLessThan(0);
    expect(Math.abs(ny)).toBeLessThan(1e-2);
    expect(nz).toBeGreaterThan(0);
  });

  it("is flat where the height is", () => {
    const height = new Uint8Array(64).fill(120);
    const [nx, ny, nz] = normalAt(normalsFromHeight(height, 8, 1), 8, 3, 5);

    expect(nx).toBeCloseTo(0, 2);
    expect(ny).toBeCloseTo(0, 2);
    expect(nz).toBeCloseTo(1, 2);
  });

  it("always returns a unit vector", () => {
    const height = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) height[i] = (i * 37) % 256;
    const normals = normalsFromHeight(height, 8, 1.5);

    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const [nx, ny, nz] = normalAt(normals, 8, x, y);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 1);
      }
    }
  });

  it("wraps at the tile's edges rather than treating them as cliffs", () => {
    // A tile is laid edge to edge across a face and across its neighbours, so a
    // border read as a discontinuity draws a bright seam around every cell.
    const height = new Uint8Array(64).fill(100);
    const normals = normalsFromHeight(height, 8, 1);

    for (let y = 0; y < 8; y += 1) {
      const [nx] = normalAt(normals, 8, 0, y);
      const [nxLast] = normalAt(normals, 8, 7, y);
      expect(nx).toBeCloseTo(0, 2);
      expect(nxLast).toBeCloseTo(0, 2);
    }
  });
});

describe("completing a tile's material", () => {
  it("fills every channel from the finish", () => {
    const complete = withDerivedSurface(tileFrom(8, (x, y) => (x + y) * 12), {
      specular: 0.5,
      roughness: 0.25,
      relief: 0.8,
    });

    expect(complete.height).toHaveLength(64);
    expect(complete.normal).toHaveLength(64 * 3);
    expect(complete.specular![0]).toBe(Math.round(0.5 * 255));
    expect(complete.roughness![0]).toBe(Math.round(0.25 * 255));
  });

  it("never overwrites a channel the author painted", () => {
    // The whole point of the Material layer is that a painted normal is the last
    // word on that texel; deriving over it would silently discard the work.
    const authored = new Uint8Array(64 * 3).fill(7);
    const height = new Uint8Array(64).fill(3);
    const complete = withDerivedSurface(
      { ...tileFrom(8, () => 128), normal: authored, height },
      MATTE_FINISH,
    );

    expect(complete.normal).toBe(authored);
    expect(complete.height).toBe(height);
  });

  it("leaves a tile flat when its finish asks for no relief", () => {
    const complete = withDerivedSurface(tileFrom(8, (x) => x * 30), {
      specular: 0.9,
      roughness: 0.1,
      relief: 0,
    });

    expect(complete.normal).toBeUndefined();
  });

  it("lights the brightest art when the finish glows", () => {
    const complete = withDerivedSurface(tileFrom(8, (x) => (x < 4 ? 20 : 250)), {
      specular: 0.2,
      roughness: 0.5,
      relief: 0.2,
      emissive: 1,
    });

    expect(complete.emissive![0]).toBe(0); // the dark half stays dark
    expect(complete.emissive![7]).toBeGreaterThan(200); // the bright half glows
  });
});
