/**
 * Scene-compositor tests — the world foundation that draws many primitives into
 * one shared camera and depth buffer, so voxel buildings, hexel terrain and pixel
 * atmosphere occlude one another by true depth rather than by draw order.
 *
 * These build real cube models with the editor core and drive the real
 * {@link renderScene}, asserting on the actual composited pixels and pick buffers:
 * that the nearer of two overlapping models wins regardless of the order it was
 * submitted, that a particle behind solid geometry is hidden while one in front
 * shows, that picking names the winning instance, and that the camera origin
 * frames the world. No internal state is inspected.
 */

import { describe, expect, it } from "vitest";
import {
  VoxelGrid,
  voxelGridToModel,
  renderScene,
  type PlacedModel,
  type VoxelModel,
} from "@cartbox/editor";

/** A solid n×n×n cube of one colour, centred on its own origin. */
function solidCube(size: number, r: number, g: number, b: number): VoxelModel {
  const grid = new VoxelGrid(size, size, size);
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        grid.set(x, y, z, r, g, b, 0);
      }
    }
  }
  return voxelGridToModel(grid, { center: "content" });
}

const SIZE = 48;
const CELL = 4;

/** Flat-on camera so a model at (x, y) projects straight to the screen centre. */
const flatCamera = { size: SIZE, cell: CELL, yaw: 0, pitch: 0 } as const;

/** Buffer index of the screen-centre pixel. */
function centreIndex(): number {
  const c = Math.floor(SIZE / 2);
  return c * SIZE + c;
}

/** [r, g, b, a] of the pixel at flat index `i`. */
function pixel(data: Uint8ClampedArray, i: number): [number, number, number, number] {
  const o = i * 4;
  return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!];
}

const GREEN = solidCube(3, 0, 200, 0);
const RED = solidCube(3, 200, 0, 0);

describe("renderScene depth compositing", () => {
  // The green cube sits nearer the camera (higher z), the red one farther; both
  // project onto the screen centre. Whichever is nearer must own that pixel.
  const near: PlacedModel = { model: GREEN, position: [0, 0, 6] };
  const far: PlacedModel = { model: RED, position: [0, 0, -6] };

  it("draws the nearer model over the farther one when the far one is submitted last", () => {
    const scene = renderScene([near, far], flatCamera);
    const [r, g] = pixel(scene.data, centreIndex());
    expect(g).toBeGreaterThan(0); // green (near) wins
    expect(r).toBe(0); // red (far) did not overwrite it
  });

  it("gives the same winner when the nearer model is submitted last", () => {
    const scene = renderScene([far, near], flatCamera);
    const [r, g] = pixel(scene.data, centreIndex());
    // Depth, not submission order, decides the pixel.
    expect(g).toBeGreaterThan(0);
    expect(r).toBe(0);
  });

  it("records the winning model's index in the pick buffer", () => {
    const pickInstance = new Int32Array(SIZE * SIZE);
    const pickFace = new Int8Array(SIZE * SIZE);
    // far is index 0, near is index 1; the near cube must win the centre pixel.
    renderScene([far, near], { ...flatCamera, pickInstance, pickFace });
    expect(pickInstance[centreIndex()]).toBe(1);
    expect(pickFace[centreIndex()]).toBeGreaterThanOrEqual(0);
  });

  it("leaves the pick buffer at -1 where nothing solid is drawn", () => {
    const pickInstance = new Int32Array(SIZE * SIZE);
    renderScene([near], { ...flatCamera, pickInstance });
    expect(pickInstance[0]).toBe(-1); // a corner the small cube cannot reach
  });
});

describe("renderScene particle atmosphere", () => {
  const block: PlacedModel = { model: GREEN, position: [0, 0, 0] };

  it("hides a particle that sits behind solid geometry", () => {
    const scene = renderScene([block], {
      ...flatCamera,
      particles: [{ position: [0, 0, -10], r: 255, g: 255, b: 255 }],
    });
    const [r, g, b] = pixel(scene.data, centreIndex());
    // The white flake is occluded, so the centre keeps the green block's colour.
    expect(g).toBeGreaterThan(0);
    expect(r).toBe(0);
    expect(b).toBe(0);
  });

  it("draws a particle that sits in front of solid geometry", () => {
    const scene = renderScene([block], {
      ...flatCamera,
      particles: [{ position: [0, 0, 10], r: 255, g: 255, b: 255, radius: 1 }],
    });
    const [r, g, b, a] = pixel(scene.data, centreIndex());
    expect(a).toBe(255);
    expect(r).toBe(255); // white flake in front overwrites the green block
    expect(g).toBe(255);
    expect(b).toBe(255);
  });
});

describe("renderScene camera origin", () => {
  it("frames the world point at the origin to the screen centre", () => {
    const offset: readonly [number, number, number] = [40, 0, 0];
    // With the camera looking at the origin, a model far to the side is off-screen.
    const away = renderScene([{ model: GREEN, position: offset }], flatCamera);
    expect(pixel(away.data, centreIndex())[3]).toBe(0);

    // Look at that same point and the model lands under the centre pixel.
    const centred = renderScene([{ model: GREEN, position: offset }], {
      ...flatCamera,
      origin: offset,
    });
    expect(pixel(centred.data, centreIndex())[3]).toBe(255);
  });
});
