/**
 * Walk-controls tests — the pure camera-movement step the world is explored with.
 * They drive the real {@link stepWalk} and assert on the resulting state: that
 * forward moves along the facing, that turning changes the facing (and forward
 * then follows it), that strafing sidesteps, that diagonals are speed-limited, and
 * that the origin is clamped to the world bounds. No canvas or framework involved.
 */

import { describe, expect, it } from "vitest";
import { stepWalk, type WalkParams, type WalkState } from "../apps/web/src/lib/walkControls";

const params: WalkParams = {
  moveSpeed: 10,
  turnSpeed: 1,
  bounds: { radiusX: 100, radiusZ: 100 },
};

const rest: WalkState = { origin: [0, 5, 0], yaw: 0 };
const still = { forward: 0, strafe: 0, turn: 0 };

describe("stepWalk", () => {
  it("does nothing with no input", () => {
    const next = stepWalk(rest, still, 0.1, params);
    expect(next.origin).toEqual([0, 5, 0]);
    expect(next.yaw).toBe(0);
  });

  it("walks forward along the facing (−z at yaw 0) and holds height", () => {
    const next = stepWalk(rest, { ...still, forward: 1 }, 1, params);
    expect(next.origin[2]).toBeCloseTo(-10, 5); // moveSpeed × dt in −z
    expect(next.origin[0]).toBeCloseTo(0, 5);
    expect(next.origin[1]).toBe(5); // height preserved
  });

  it("turns the facing, and forward then follows the new facing", () => {
    // A quarter turn (yaw = π/2) makes forward point along +x.
    const turned = stepWalk(rest, { ...still, turn: 1 }, Math.PI / 2, params);
    expect(turned.yaw).toBeCloseTo(Math.PI / 2, 5);
    const walked = stepWalk(turned, { ...still, forward: 1 }, 1, params);
    expect(walked.origin[0]).toBeCloseTo(10, 5); // now moves in +x
    expect(walked.origin[2]).toBeCloseTo(0, 5);
  });

  it("strafes to the right (+x at yaw 0)", () => {
    const next = stepWalk(rest, { ...still, strafe: 1 }, 1, params);
    expect(next.origin[0]).toBeCloseTo(10, 5);
    expect(next.origin[2]).toBeCloseTo(0, 5);
  });

  it("does not let a diagonal outrun a straight line", () => {
    const straight = stepWalk(rest, { ...still, forward: 1 }, 1, params);
    const diagonal = stepWalk(rest, { ...still, forward: 1, strafe: 1 }, 1, params);
    const straightDist = Math.hypot(straight.origin[0], straight.origin[2]);
    const diagonalDist = Math.hypot(diagonal.origin[0], diagonal.origin[2]);
    expect(diagonalDist).toBeCloseTo(straightDist, 5); // normalised to the same speed
  });

  it("clamps the origin to the world bounds", () => {
    const tight: WalkParams = { ...params, bounds: { radiusX: 3, radiusZ: 3 } };
    // Walk forward far longer than the bound allows; z must stop at the edge.
    const next = stepWalk(rest, { ...still, forward: 1 }, 100, tight);
    expect(next.origin[2]).toBe(-3);
    expect(Math.abs(next.origin[2])).toBeLessThanOrEqual(3);
  });
});
