/**
 * Per-face material tests — the layer that lets one voxel wear a different tile
 * on its top, sides and bottom (grass capping dirt, rings on a log's ends). They
 * exercise the pure face→tile selector and then drive the real renderer with a
 * material atlas, asserting that the top face and a side face of the *same* voxel
 * sample *different* tiles. Also covers the sprite→tile adapter that drops
 * authored art straight into an atlas slot. No internals are inspected.
 */

import { describe, expect, it } from "vitest";
import {
  VoxelGrid,
  voxelGridToModel,
  renderVoxelModel,
  faceTile,
  spriteToFaceTexture,
  MATERIAL_TOP_THRESHOLD,
  type FaceTexture,
  type TextureAtlas,
  type VoxelModel,
} from "@cartbox/editor";

/** A solid square tile of one colour. */
function solidTile(r: number, g: number, b: number, a = 255): FaceTexture {
  const size = 4;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { size, data };
}

/** A 3×3×3 white cube whose every voxel carries material/tile index `tile`. */
function cube(tile: number): VoxelModel {
  const grid = new VoxelGrid(3, 3, 3);
  for (let z = 0; z < 3; z += 1) {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) grid.set(x, y, z, 255, 255, 255, 0);
    }
  }
  return voxelGridToModel(grid, { center: "content", tileForCell: () => tile });
}

// Distinct tiles per face group so a sampled colour names which face it came from.
const RED = 0;
const GREEN = 1;
const BLUE = 2;
const materialAtlas: TextureAtlas = {
  tiles: [solidTile(255, 0, 0), solidTile(0, 255, 0), solidTile(0, 0, 255)],
  materials: [{ top: RED, side: GREEN, bottom: BLUE }],
};

describe("faceTile selection", () => {
  it("picks top/side/bottom by the face's upward component", () => {
    expect(faceTile(materialAtlas, 0, 1)).toBe(materialAtlas.tiles[RED]);
    expect(faceTile(materialAtlas, 0, 0)).toBe(materialAtlas.tiles[GREEN]);
    expect(faceTile(materialAtlas, 0, -1)).toBe(materialAtlas.tiles[BLUE]);
  });

  it("treats the threshold as the top/side boundary", () => {
    const justAbove = MATERIAL_TOP_THRESHOLD + 0.01;
    const justBelow = MATERIAL_TOP_THRESHOLD - 0.01;
    expect(faceTile(materialAtlas, 0, justAbove)).toBe(materialAtlas.tiles[RED]);
    expect(faceTile(materialAtlas, 0, justBelow)).toBe(materialAtlas.tiles[GREEN]);
  });

  it("falls back to a plain tile lookup when the atlas has no materials", () => {
    const plain: TextureAtlas = { tiles: [solidTile(9, 9, 9)] };
    // No materials: every facing resolves to the one indexed tile.
    expect(faceTile(plain, 0, 1)).toBe(plain.tiles[0]);
    expect(faceTile(plain, 0, 0)).toBe(plain.tiles[0]);
  });

  it("draws flat for a negative index or an absent material slot", () => {
    expect(faceTile(materialAtlas, -1, 1)).toBeUndefined();
    const holed: TextureAtlas = { tiles: [solidTile(1, 1, 1)], materials: [{ top: -1, side: 0, bottom: 0 }] };
    expect(faceTile(holed, 0, 1)).toBeUndefined(); // top slot is a flat face
    expect(faceTile(holed, 0, 0)).toBe(holed.tiles[0]);
  });
});

describe("per-face material rendering", () => {
  it("skins the top and side of one voxel with different tiles", () => {
    // Tip the cube toward the viewer so its top face shows above its front face,
    // then read a high pixel (top → red) and a low pixel (front side → green).
    const size = 60;
    const render = renderVoxelModel(cube(0), {
      size,
      cell: 8,
      yaw: 0,
      pitch: 0.9, // steep enough that the top face is clearly visible
      light: { direction: [0, 0, 1], color: [1, 1, 1], intensity: 0, ambient: 1 },
      atlas: materialAtlas,
    });

    const dominant = (px: number, py: number): "red" | "green" | "blue" | "none" => {
      const o = (py * size + px) * 4;
      if ((render.data[o + 3] ?? 0) === 0) return "none";
      const r = render.data[o]!;
      const g = render.data[o + 1]!;
      const b = render.data[o + 2]!;
      if (r > g && r > b) return "red";
      if (g > r && g > b) return "green";
      if (b > r && b > g) return "blue";
      return "none";
    };

    // Scan a central column top-to-bottom; the upper opaque band is the top face,
    // the lower opaque band is the front side face. They must differ in colour.
    const mid = Math.floor(size / 2);
    let top: string | null = null;
    let front: string | null = null;
    for (let py = 0; py < size; py += 1) {
      const d = dominant(mid, py);
      if (d === "none") continue;
      if (top === null) top = d;
      front = d;
    }
    expect(top).toBe("red"); // upward faces sampled the top tile
    expect(front).toBe("green"); // sideways faces sampled the side tile
    expect(top).not.toBe(front);
  });
});

describe("spriteToFaceTexture", () => {
  it("wraps square RGBA into a tile that owns its buffer", () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    pixels.fill(120);
    const tile = spriteToFaceTexture(pixels, 2, 2);
    expect(tile.size).toBe(2);
    expect(Array.from(tile.data)).toEqual(Array.from(pixels));
    pixels[0] = 0; // mutate the source
    expect(tile.data[0]).toBe(120); // the tile kept its own copy
  });

  it("keeps emissive only when some texel glows", () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    expect(spriteToFaceTexture(pixels, 2, 2, new Uint8Array(4)).emissive).toBeUndefined();
    const glow = new Uint8Array([0, 200, 0, 0]);
    expect(spriteToFaceTexture(pixels, 2, 2, glow).emissive).toBeDefined();
  });

  it("rejects non-square art (a face samples a square tile)", () => {
    expect(() => spriteToFaceTexture(new Uint8ClampedArray(2 * 3 * 4), 2, 3)).toThrow(/square/);
  });
});
