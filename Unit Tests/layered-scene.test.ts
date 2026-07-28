/**
 * Layered-scene compositor tests. They drive the real projectPlane and
 * renderLayeredScene and assert on relationships between the same functions'
 * outputs — near-vs-far parallax, front-vs-back rotation swing, painter
 * occlusion — rather than baked pixel constants, so the tests prove the
 * projection geometry instead of restating it.
 */

import { describe, expect, it } from "vitest";
import {
  renderLayeredScene,
  projectPlane,
  type ScenePlane,
  type Camera,
} from "@cartbox/editor";

/** A solid, fully-opaque RGBA square used as a plane texture. */
function solidImage(size: number, red: number, green: number, blue: number): Uint8ClampedArray {
  const image = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    image[i * 4] = red;
    image[i * 4 + 1] = green;
    image[i * 4 + 2] = blue;
    image[i * 4 + 3] = 255;
  }
  return image;
}

function plane(overrides: Partial<ScenePlane>): ScenePlane {
  return {
    image: solidImage(8, 255, 0, 0),
    imageWidth: 8,
    imageHeight: 8,
    x: 0,
    y: 0,
    depth: 10,
    unitsPerPixel: 0.1,
    ...overrides,
  };
}

const BASE_CAMERA: Camera = {
  panX: 0,
  panY: 0,
  yaw: 0,
  pivotX: 0,
  pivotDepth: 10,
  focalLength: 100,
  viewportWidth: 64,
  viewportHeight: 64,
};

function centerPixel(frame: { data: Uint8ClampedArray; width: number; height: number }): number[] {
  const cx = Math.floor(frame.width / 2);
  const cy = Math.floor(frame.height / 2);
  const i = (cy * frame.width + cx) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2], frame.data[i + 3]];
}

describe("projectPlane parallax", () => {
  it("shifts a near plane more than a far plane under the same pan", () => {
    const near = plane({ depth: 5, x: 2 });
    const far = plane({ depth: 20, x: 2 });
    const panned: Camera = { ...BASE_CAMERA, panX: 1 };

    const nearShift = projectPlane(near, panned).screenX - projectPlane(near, BASE_CAMERA).screenX;
    const farShift = projectPlane(far, panned).screenX - projectPlane(far, BASE_CAMERA).screenX;

    expect(Math.abs(nearShift)).toBeGreaterThan(Math.abs(farShift));
  });

  it("scales a near plane larger than a far plane (perspective)", () => {
    const near = projectPlane(plane({ depth: 5 }), BASE_CAMERA);
    const far = projectPlane(plane({ depth: 20 }), BASE_CAMERA);
    expect(near.pixelScale).toBeGreaterThan(far.pixelScale);
  });
});

describe("projectPlane rotation swing", () => {
  it("swings front and back planes to opposite sides under yaw", () => {
    const yawed: Camera = { ...BASE_CAMERA, yaw: 0.2 };
    const center = BASE_CAMERA.viewportWidth / 2;

    const front = projectPlane(plane({ depth: 6 }), yawed).screenX; // ahead of pivot
    const back = projectPlane(plane({ depth: 16 }), yawed).screenX; // behind pivot

    expect(front).toBeLessThan(center);
    expect(back).toBeGreaterThan(center);
  });

  it("leaves a plane at the pivot centred under pure yaw", () => {
    const yawed: Camera = { ...BASE_CAMERA, yaw: 0.35 };
    const atPivot = projectPlane(plane({ depth: BASE_CAMERA.pivotDepth, x: 0 }), yawed);
    expect(atPivot.screenX).toBeCloseTo(BASE_CAMERA.viewportWidth / 2, 6);
  });

  it("gives a nearer part a larger swing magnitude than a farther one", () => {
    const yawed: Camera = { ...BASE_CAMERA, yaw: 0.2 };
    const center = BASE_CAMERA.viewportWidth / 2;
    const nearFront = Math.abs(projectPlane(plane({ depth: 6 }), yawed).screenX - center);
    const farFront = Math.abs(projectPlane(plane({ depth: 8 }), yawed).screenX - center);
    expect(nearFront).toBeGreaterThan(farFront);
  });
});

describe("renderLayeredScene compositing", () => {
  it("draws a nearer plane over a farther one at overlapping pixels", () => {
    const far = plane({ depth: 20, image: solidImage(8, 255, 0, 0) });
    const near = plane({ depth: 5, image: solidImage(8, 0, 0, 255) });
    const frame = renderLayeredScene([far, near], BASE_CAMERA);
    const [r, g, b, a] = centerPixel(frame);
    expect([r, g, b]).toEqual([0, 0, 255]);
    expect(a).toBe(255);
  });

  it("respects painter order regardless of input order (input not mutated)", () => {
    const far = plane({ depth: 20, image: solidImage(8, 255, 0, 0) });
    const near = plane({ depth: 5, image: solidImage(8, 0, 0, 255) });
    const input = [near, far];
    const frame = renderLayeredScene(input, BASE_CAMERA);
    expect(centerPixel(frame).slice(0, 3)).toEqual([0, 0, 255]);
    expect(input).toEqual([near, far]); // order preserved
  });

  it("lets a farther plane show through a transparent hole in a nearer plane", () => {
    const far = plane({ depth: 20, image: solidImage(8, 255, 0, 0) });
    // Nearer plane fully transparent: it must not overwrite the far plane.
    const nearHollow = plane({ depth: 5, image: new Uint8ClampedArray(8 * 8 * 4) });
    const frame = renderLayeredScene([far, nearHollow], BASE_CAMERA);
    expect(centerPixel(frame).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it("returns a frame matching the camera viewport", () => {
    const frame = renderLayeredScene([plane({})], BASE_CAMERA);
    expect(frame.width).toBe(BASE_CAMERA.viewportWidth);
    expect(frame.height).toBe(BASE_CAMERA.viewportHeight);
    expect(frame.data.length).toBe(BASE_CAMERA.viewportWidth * BASE_CAMERA.viewportHeight * 4);
  });

  it("skips planes that fall behind the camera after rotation", () => {
    // A plane offset far to the side, yawed 90°, rotates behind the camera
    // (view depth goes negative). It must not throw or paint: pivotDepth (10)
    // minus the offset (20) is negative, so the plane is culled.
    const offset = plane({ depth: 10, x: 20, image: solidImage(8, 0, 255, 0) });
    const quarterTurn: Camera = { ...BASE_CAMERA, yaw: Math.PI / 2 };
    expect(projectPlane(offset, quarterTurn).viewDepth).toBeLessThan(0);
    const frame = renderLayeredScene([offset], quarterTurn);
    expect(centerPixel(frame)).toEqual([0, 0, 0, 0]);
  });
});
