/**
 * Cinematic gap #2 — smooth (interpolated) normals — validated on the pure model
 * the lighting shaders (WebGL + WebGPU) are ports of. The banding they fix only
 * shows on a GPU, so the guarantees are pinned here instead: blending the decoded
 * vectors (never the unordered indices) yields an in-between direction, a uniform
 * region is left exactly as it was, and every result is a unit vector.
 *
 * Expectations are derived from the inputs — the midpoint of two directions, the
 * exact normal of a repeated index — never hand-copied constants, so retuning the
 * normal palette can't leave a stale literal passing.
 */

import { describe, expect, it } from "vitest";
import {
  NORMAL_VECTORS,
  interpolateNormal,
  normalVector,
  sampleNormalBilinear,
  type Vec3,
} from "@cartbox/player";

function length(vector: Vec3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("interpolateNormal", () => {
  const up = normalVector(1); // compass north (tilted away from camera)
  const right = normalVector(3); // compass east
  const facing = normalVector(0); // straight at the camera

  it("returns a unit vector for any blend", () => {
    for (const [fx, fy] of [
      [0, 0],
      [0.5, 0.5],
      [0.3, 0.9],
      [1, 1],
    ]) {
      const blended = interpolateNormal(up, right, facing, up, fx, fy);
      expect(length(blended)).toBeCloseTo(1, 12);
    }
  });

  it("reproduces a corner when the weights land on it", () => {
    // Top-left corner at (0,0) must be that corner's normal (bit-for-bit modulo
    // the renormalise of an already-unit input).
    const corner = interpolateNormal(up, right, facing, right, 0, 0);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(corner[axis]).toBeCloseTo(up[axis]!, 12);
    }
  });

  it("lands between two distinct directions, not on either", () => {
    // Blend north and east halfway across the top edge: the result must point
    // between them — closer to each than they are to one another.
    const mid = interpolateNormal(up, right, up, right, 0.5, 0);
    const spread = dot(up, right); // how far apart the two inputs are
    expect(dot(mid, up)).toBeGreaterThan(spread);
    expect(dot(mid, right)).toBeGreaterThan(spread);
    expect(mid).not.toEqual(up);
    expect(mid).not.toEqual(right);
  });

  it("collapses to the shared normal when all four corners agree", () => {
    const blended = interpolateNormal(up, up, up, up, 0.37, 0.82);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(blended[axis]).toBeCloseTo(up[axis]!, 12);
    }
  });
});

describe("sampleNormalBilinear", () => {
  it("leaves a uniform normal field untouched (flat/unmapped materials)", () => {
    // Every pixel index 0: the smoothed normal must equal that normal everywhere,
    // fractional sample point or not — the property that keeps ordinary carts
    // pixel-identical when smoothing is on.
    const uniform = () => 0;
    const flat = normalVector(0);
    for (const [x, y] of [
      [0.5, 0.5],
      [3.25, 7.75],
      [10.1, 2.9],
    ]) {
      const sampled = sampleNormalBilinear(uniform, x, y);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(sampled[axis]).toBeCloseTo(flat[axis]!, 12);
      }
    }
  });

  it("smooths a step edge between two normals into an intermediate direction", () => {
    // A vertical seam: columns < 5 face north, columns >= 5 face east. Sampling
    // astride the seam must yield a direction between the two, which is exactly the
    // de-banding the shader does per fragment.
    const north = normalVector(1);
    const east = normalVector(3);
    const stepField = (x: number) => (x < 5 ? 1 : 3);
    const sampled = sampleNormalBilinear((x) => stepField(x), 4.5, 0);

    expect(dot(sampled, north)).toBeGreaterThan(0);
    expect(dot(sampled, east)).toBeGreaterThan(0);
    // Strictly between the two source directions.
    expect(sampled).not.toEqual(north);
    expect(sampled).not.toEqual(east);
    expect(length(sampled)).toBeCloseTo(1, 12);
  });

  it("clamps an out-of-range index to the flat fallback like the shaders do", () => {
    // Indices 9..15 are spare and decode to flat; a sampler reading them must not
    // throw or denormalise.
    const spare = () => 12;
    const sampled = sampleNormalBilinear(spare, 2.5, 2.5);
    expect(sampled).toEqual(NORMAL_VECTORS[0]);
  });
});
