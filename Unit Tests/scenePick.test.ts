/**
 * Phase 6 — scene-editor ray picking (pure). A click becomes a world ray from the
 * orbit camera's basis; the ray is tested against instance AABBs to select the
 * nearest one. These pin the ray direction, the slab test, and nearest-hit choice.
 */

import { describe, expect, it } from "vitest";

import { cameraRay, pickBoxes, rayAabbT, type PickBox, type Ray, type Vec3 } from "@/lib/scenePick";

const EYE: Vec3 = [0, 0, 10];
const TARGET: Vec3 = [0, 0, 0];
const FOV = (50 * Math.PI) / 180;

describe("cameraRay", () => {
  it("shoots straight at the target through the screen centre", () => {
    const ray = cameraRay(EYE, TARGET, FOV, 1, 0, 0);
    expect(ray.origin).toEqual(EYE);
    expect(ray.dir[0]).toBeCloseTo(0, 6);
    expect(ray.dir[1]).toBeCloseTo(0, 6);
    expect(ray.dir[2]).toBeCloseTo(-1, 6); // looking down -Z
  });

  it("tilts right and up for a top-right click", () => {
    const ray = cameraRay(EYE, TARGET, FOV, 1, 1, 1);
    expect(ray.dir[0]).toBeGreaterThan(0); // +X (right)
    expect(ray.dir[1]).toBeGreaterThan(0); // +Y (up)
    expect(ray.dir[2]).toBeLessThan(0);
  });
});

describe("rayAabbT", () => {
  const ray: Ray = { origin: [0, 0, 10], dir: [0, 0, -1] };

  it("returns the near distance for a box in front", () => {
    const t = rayAabbT(ray, [-1, -1, -1], [1, 1, 1]);
    expect(t).toBeCloseTo(9, 6); // enters the box at z=1, nine units away
  });

  it("returns null for a box the ray misses", () => {
    expect(rayAabbT(ray, [5, 5, -1], [6, 6, 1])).toBeNull();
  });

  it("returns null for a box entirely behind the ray", () => {
    expect(rayAabbT(ray, [-1, -1, 20], [1, 1, 22])).toBeNull();
  });

  it("returns 0 when the origin is inside the box", () => {
    expect(rayAabbT(ray, [-1, -1, -1], [1, 1, 11])).toBe(0);
  });
});

describe("pickBoxes", () => {
  const ray = cameraRay(EYE, TARGET, FOV, 1, 0, 0);

  it("picks the nearest box the ray hits", () => {
    const near: PickBox<string> = { key: "near", min: [-1, -1, 0], max: [1, 1, 2] };
    const far: PickBox<string> = { key: "far", min: [-1, -1, -6], max: [1, 1, -4] };
    expect(pickBoxes([far, near], ray)).toBe("near");
  });

  it("returns null when the ray hits nothing", () => {
    expect(pickBoxes([{ key: "a", min: [10, 10, 0], max: [11, 11, 1] }], ray)).toBeNull();
  });
});
