/**
 * Voxel-renderer tests — the voxel core that turns a heightfield of pixels into
 * lit 3D columns for the editor preview. These drive the real renderer with
 * small hand-built albedo/normal/material buffers and assert on the actual
 * output pixels: output sizing, empty columns, that height raises a column above
 * the ground row, that the light re-shades faces, and that emissive pixels stay
 * lit in shadow. No internal state is inspected.
 */

import { describe, expect, it } from "vitest";
import { renderVoxelRgba, directionFromConditions, type VoxelLight } from "@cartbox/editor";

const CELL = 4;

/** A W×H albedo buffer filled with one opaque colour (alpha 255). */
function solidAlbedo(width: number, height: number, r = 200, g = 200, b = 200): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 4] = r;
    buffer[i * 4 + 1] = g;
    buffer[i * 4 + 2] = b;
    buffer[i * 4 + 3] = 255;
  }
  return buffer;
}

/** A flat normal map: every pixel faces the viewer (encoded [128,128,255]). */
function flatNormal(width: number, height: number): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 4] = 128;
    buffer[i * 4 + 1] = 128;
    buffer[i * 4 + 2] = 255;
    buffer[i * 4 + 3] = 255;
  }
  return buffer;
}

/** Material buffer with a per-pixel height (0..255) and optional emissive. */
function material(width: number, height: number, heights: number[], emissive: number[] = []): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 4] = heights[i] ?? 0;
    buffer[i * 4 + 3] = emissive[i] ?? 0;
  }
  return buffer;
}

const overhead: VoxelLight = {
  direction: directionFromConditions({ azimuth: 0, elevation: 90, intensity: 1, ambient: 0.2, color: [1, 1, 1] }),
  color: [1, 1, 1],
  intensity: 1,
  ambient: 0.2,
};

/** Alpha of the output pixel at (px, py). */
function alphaAt(image: { data: Uint8ClampedArray; width: number }, px: number, py: number): number {
  return image.data[(py * image.width + px) * 4 + 3] ?? 0;
}

describe("renderVoxelRgba", () => {
  it("sizes the output to the upscaled grid plus headroom for raised columns", () => {
    const width = 3;
    const height = 2;
    const image = renderVoxelRgba(solidAlbedo(width, height), flatNormal(width, height), width, height, overhead, {
      cell: CELL,
      heightScale: 12,
    });
    expect(image.width).toBe(width * CELL);
    expect(image.height).toBe(height * CELL + 12);
  });

  it("leaves fully transparent pixels as empty columns", () => {
    const width = 2;
    const height = 1;
    const albedo = new Uint8ClampedArray(width * height * 4); // all alpha 0
    const image = renderVoxelRgba(albedo, flatNormal(width, height), width, height, overhead, { cell: CELL });
    const anyOpaque = Array.from({ length: image.width * image.height }, (_v, i) => image.data[i * 4 + 3]).some(
      (a) => (a ?? 0) > 0,
    );
    expect(anyOpaque).toBe(false);
  });

  it("raises a tall column above the ground row that a flat pixel occupies", () => {
    const width = 1;
    const height = 1;
    const heightScale = 12;
    const flat = renderVoxelRgba(solidAlbedo(width, height), flatNormal(width, height), width, height, overhead, {
      cell: CELL,
      heightScale,
      material: material(width, height, [0]),
    });
    const tall = renderVoxelRgba(solidAlbedo(width, height), flatNormal(width, height), width, height, overhead, {
      cell: CELL,
      heightScale,
      material: material(width, height, [255]),
    });
    // The flat pixel paints only the bottom cell (rows >= headroom); the tall
    // column paints all the way up to the top of the image.
    expect(alphaAt(flat, 0, 0)).toBe(0);
    expect(alphaAt(tall, 0, 0)).toBe(255);
  });

  it("lights the top face brighter when the light aligns with the normal", () => {
    const width = 1;
    const height = 1;
    const lit = { ...overhead, ambient: 0 };
    const away: VoxelLight = { ...lit, direction: [0, 0, -1] }; // behind the surface: diffuse 0
    const litImage = renderVoxelRgba(solidAlbedo(width, height), flatNormal(width, height), width, height, lit, {
      cell: CELL,
    });
    const darkImage = renderVoxelRgba(solidAlbedo(width, height), flatNormal(width, height), width, height, away, {
      cell: CELL,
    });
    // Sample the top face (bottom-most row, since height 0 sits on the ground).
    const y = litImage.height - 1;
    const litR = litImage.data[(y * litImage.width) * 4] ?? 0;
    const darkR = darkImage.data[(y * darkImage.width) * 4] ?? 0;
    expect(litR).toBeGreaterThan(darkR);
    expect(darkR).toBe(0); // ambient 0 + light facing away = black
  });

  it("keeps an emissive pixel lit even with a light facing away and no ambient", () => {
    const width = 1;
    const height = 1;
    const away: VoxelLight = { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, ambient: 0 };
    const image = renderVoxelRgba(solidAlbedo(width, height, 180, 180, 180), flatNormal(width, height), width, height, away, {
      cell: CELL,
      material: material(width, height, [0], [255]), // full emissive
    });
    const y = image.height - 1;
    const r = image.data[(y * image.width) * 4] ?? 0;
    expect(r).toBeGreaterThan(0); // self-illumination survives shadow
  });

  it("tints the lit result by the light colour", () => {
    const width = 1;
    const height = 1;
    const red: VoxelLight = { direction: [0, 0, 1], color: [1, 0, 0], intensity: 1, ambient: 0 };
    const image = renderVoxelRgba(solidAlbedo(width, height, 200, 200, 200), flatNormal(width, height), width, height, red, {
      cell: CELL,
    });
    const y = image.height - 1;
    const base = y * image.width * 4;
    expect(image.data[base]).toBeGreaterThan(0); // red channel lit
    expect(image.data[base + 1]).toBe(0); // green killed by colour [1,0,0]
    expect(image.data[base + 2]).toBe(0); // blue killed
  });
});
