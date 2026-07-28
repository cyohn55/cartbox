/**
 * The cameras the map's 3D views share.
 *
 * Three renderers read this: the software rasteriser that orbits, the ray marcher
 * that walks, and the GPU that does both. If they disagree, the symptoms are
 * nasty and quiet — a view that mirrors when you switch cameras, or a crosshair
 * that names a cell other than the one drawn beneath it.
 *
 * So the checks here are cross-checks. The orbit basis is asserted against where
 * the *actual rasteriser* puts a voxel, and the screen ray against the projection
 * that is supposed to be its inverse.
 */

import { describe, expect, it } from "vitest";

import {
  VoxelGrid,
  firstPersonBasis,
  orbitBasis,
  orthographicProjection,
  perspectiveProjection,
  projectToScreen,
  renderVoxelModel,
  screenRay,
  voxelGridToModel,
  type CameraBasis,
} from "@cartbox/editor";

const ORIGIN: readonly [number, number, number] = [0, 0, 0];

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

/** Assert a basis is orthonormal and describes an unmirrored view. */
function expectProperFrame(basis: CameraBasis): void {
  for (const axis of [basis.right, basis.up, basis.forward]) {
    expect(Math.hypot(axis[0], axis[1], axis[2])).toBeCloseTo(1, 8);
  }
  expect(dot(basis.right, basis.up)).toBeCloseTo(0, 8);
  expect(dot(basis.right, basis.forward)).toBeCloseTo(0, 8);
  expect(dot(basis.up, basis.forward)).toBeCloseTo(0, 8);
  // right x up points back out of the screen; the other sign is a mirror.
  expect(dot(cross(basis.right, basis.up), basis.forward)).toBeCloseTo(-1, 8);
}

describe("the orbit camera's basis", () => {
  it("is a proper, unmirrored frame at every angle", () => {
    for (const yaw of [0, 0.6, 1.9, -2.4, Math.PI]) {
      for (const pitch of [0, 0.42, 1.1, -0.2]) {
        expectProperFrame(orbitBasis(yaw, pitch));
      }
    }
  });

  it("puts a voxel exactly where the rasteriser draws it", () => {
    // The claim is that the GPU camera *is* the software camera. So: draw a lone
    // voxel offset from the origin, find its footprint in the real render, and
    // check the projection predicts that footprint's centre.
    const size = 121;
    const cell = 9;
    const grid = new VoxelGrid(9, 9, 9);
    grid.set(6, 5, 3, 250, 80, 80);
    const model = voxelGridToModel(grid);

    for (const yaw of [0, 0.7, 2.3]) {
      for (const pitch of [0.2, 0.42]) {
        const render = renderVoxelModel(model, { yaw, pitch, cell, size });

        let sumX = 0;
        let sumY = 0;
        let drawn = 0;
        for (let py = 0; py < size; py += 1) {
          for (let px = 0; px < size; px += 1) {
            if (render.data[(py * size + px) * 4 + 3]! === 0) continue;
            sumX += px + 0.5;
            sumY += py + 0.5;
            drawn += 1;
          }
        }
        expect(drawn).toBeGreaterThan(0);

        // The model's own coordinates are centred, which is what the projection
        // is given; `voxelGridToModel` centres a 9-cube on (4, 4, 4).
        const point: [number, number, number] = [6 - 4, 5 - 4, 3 - 4];
        const projection = orthographicProjection({ cell, width: size, height: size, range: 64 });
        const at = projectToScreen(ORIGIN, orbitBasis(yaw, pitch), projection, point);

        // Within half a cell: the drawn footprint is a cube's silhouette, whose
        // centroid is its centre, but rasterisation rounds.
        expect(at.x * size).toBeCloseTo(sumX / drawn, -0.5);
        expect(at.y * size).toBeCloseTo(sumY / drawn, -0.5);
      }
    }
  });
});

describe("projections", () => {
  it("maps the orthographic slab onto the depth range a GPU expects", () => {
    const projection = orthographicProjection({ cell: 10, width: 100, height: 80, range: 50 });
    const depth = (cz: number) => cz * projection.depthScale + projection.depthBias;

    expect(depth(-50)).toBeCloseTo(0, 6);
    expect(depth(50)).toBeCloseTo(1, 6);
    expect(projection.perspective).toBe(0);
    // Nearer is smaller, which is what a `less` depth test needs.
    expect(depth(-1)).toBeLessThan(depth(1));
  });

  it("maps the perspective frustum onto the same range", () => {
    const projection = perspectiveProjection({ fov: 1.2, width: 160, height: 90, near: 0.1, far: 100 });
    const depth = (cz: number) => (cz * projection.depthScale + projection.depthBias) / cz;

    expect(depth(0.1)).toBeCloseTo(0, 5);
    expect(depth(100)).toBeCloseTo(1, 5);
    expect(depth(5)).toBeLessThan(depth(20));
    expect(projection.perspective).toBe(1);
  });

  it("widens the horizontal field with the aspect ratio, not the vertical", () => {
    const square = perspectiveProjection({ fov: 1.2, width: 100, height: 100, near: 0.1, far: 50 });
    const wide = perspectiveProjection({ fov: 1.2, width: 200, height: 100, near: 0.1, far: 50 });

    expect(wide.scaleY).toBeCloseTo(square.scaleY, 10);
    expect(wide.scaleX).toBeCloseTo(square.scaleX / 2, 10);
  });
});

describe("a ray through a point on the frame", () => {
  it("is the exact inverse of the projection, under perspective", () => {
    const basis = firstPersonBasis(0.8, -0.3);
    const eye: [number, number, number] = [12, 4, 30];
    const projection = perspectiveProjection({ fov: 1.1, width: 320, height: 200, near: 0.1, far: 200 });

    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.9],
      [0.75, 0.2],
    ] as const) {
      const ray = screenRay(eye, basis, projection, fx, fy);
      const along: [number, number, number] = [
        ray.origin[0] + ray.direction[0] * 7,
        ray.origin[1] + ray.direction[1] * 7,
        ray.origin[2] + ray.direction[2] * 7,
      ];
      const back = projectToScreen(eye, basis, projection, along);

      expect(back.x).toBeCloseTo(fx, 6);
      expect(back.y).toBeCloseTo(fy, 6);
    }
  });

  it("is the exact inverse of the projection, under orthography", () => {
    const basis = orbitBasis(1.4, 0.5);
    const projection = orthographicProjection({ cell: 16, width: 480, height: 300, range: 90 });

    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.2, 0.8],
      [0.95, 0.05],
    ] as const) {
      const ray = screenRay(ORIGIN, basis, projection, fx, fy);
      const along: [number, number, number] = [
        ray.origin[0] + ray.direction[0] * 40,
        ray.origin[1] + ray.direction[1] * 40,
        ray.origin[2] + ray.direction[2] * 40,
      ];
      const back = projectToScreen(ORIGIN, basis, projection, along);

      expect(back.x).toBeCloseTo(fx, 6);
      expect(back.y).toBeCloseTo(fy, 6);
    }
  });

  it("starts an orthographic ray behind everything the slab can hold", () => {
    // Otherwise a pick would begin inside the terrain it is meant to strike.
    const basis = orbitBasis(0.3, 0.6);
    const projection = orthographicProjection({ cell: 12, width: 200, height: 200, range: 70 });
    const ray = screenRay(ORIGIN, basis, projection, 0.5, 0.5);

    expect(dot(ray.origin, basis.forward)).toBeCloseTo(-70, 5);
  });

  it("aims a centred perspective ray straight ahead", () => {
    const basis = firstPersonBasis(-1.2, 0.35);
    const projection = perspectiveProjection({ fov: 1.2, width: 100, height: 100, near: 0.1, far: 50 });
    const ray = screenRay([3, 2, 1], basis, projection, 0.5, 0.5);

    expect(ray.origin).toEqual([3, 2, 1]);
    for (const axis of [0, 1, 2]) {
      expect(ray.direction[axis]).toBeCloseTo(basis.forward[axis]!, 10);
    }
  });
});
