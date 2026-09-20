/**
 * Phase 3 — equirectangular environment map for IBL (software reference path).
 *
 * Beyond the analytic gradient, an environment can carry a decoded panorama
 * (`map`) sampled by the full 3D direction: longitude = atan2(z, x),
 * latitude = acos(y). Metals then mirror a real scene, not a vertical gradient.
 * The rough-reflection fall-off blends toward the map's mean (`average`). A
 * gradient-only environment is unchanged (the map is optional).
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  computeEnvironmentAverage,
  projectionMatrix,
  renderMeshScene,
  sampleEnvironmentDir,
  viewMatrix,
  type DecodedTexture,
  type EnvironmentLight,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

/** A 4×2 equirect map with a distinct colour per column. */
function fourColumnMap(): DecodedTexture {
  const cols: [number, number, number][] = [
    [200, 0, 0], // col 0 red
    [0, 200, 0], // col 1 green
    [0, 0, 200], // col 2 blue
    [255, 255, 255], // col 3 white
  ];
  const data = new Uint8ClampedArray(4 * 2 * 4);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const at = (y * 4 + x) * 4;
      data[at] = cols[x]![0];
      data[at + 1] = cols[x]![1];
      data[at + 2] = cols[x]![2];
      data[at + 3] = 255;
    }
  }
  return { width: 4, height: 2, data };
}

/** A solid-colour 1×1 map. */
function solidMap(r: number, g: number, b: number): DecodedTexture {
  return { width: 1, height: 1, data: Uint8ClampedArray.from([r, g, b, 255]) };
}

function mapEnv(map: DecodedTexture): EnvironmentLight {
  return { sky: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0], intensity: 1, map, average: computeEnvironmentAverage(map) };
}

describe("equirectangular environment sampling", () => {
  it("projects cardinal directions to the right columns", () => {
    const env = mapEnv(fourColumnMap());
    // longitude = atan2(z, x)/2π + 0.5, ×4 columns:
    // +X → u 0.5 → col 2 (blue); +Z → 0.75 → col 3 (white);
    // −X → wraps to 0 → col 0 (red); −Z → 0.25 → col 1 (green).
    expect(sampleEnvironmentDir(env, 1, 0, 0)).toEqual([0, 0, 200 / 255]);
    expect(sampleEnvironmentDir(env, 0, 0, 1)).toEqual([1, 1, 1]);
    expect(sampleEnvironmentDir(env, -1, 0, 0)).toEqual([200 / 255, 0, 0]);
    expect(sampleEnvironmentDir(env, 0, 0, -1)).toEqual([0, 200 / 255, 0]);
  });

  it("scales samples by intensity", () => {
    const env = { ...mapEnv(solidMap(100, 100, 100)), intensity: 2 };
    const [r] = sampleEnvironmentDir(env, 1, 0, 0);
    expect(r).toBeCloseTo((100 / 255) * 2, 10);
  });

  it("computes the mean radiance of a map", () => {
    const avg = computeEnvironmentAverage(fourColumnMap());
    // Column means of R: (200+0+0+255)/4 = 113.75 → /255.
    expect(avg[0]).toBeCloseTo((200 + 0 + 0 + 255) / 4 / 255, 10);
    expect(avg[1]).toBeCloseTo((0 + 200 + 0 + 255) / 4 / 255, 10);
    expect(avg[2]).toBeCloseTo((0 + 0 + 200 + 255) / 4 / 255, 10);
  });

  it("falls back to the gradient when there is no map", () => {
    const gradient: EnvironmentLight = { sky: [0.2, 0.4, 0.9], horizon: [0.5, 0.5, 0.5], ground: [0.1, 0.1, 0.1], intensity: 1 };
    // No map → the Y-only gradient: straight up returns the sky exactly.
    expect(sampleEnvironmentDir(gradient, 0, 1, 0)).toEqual([0.2, 0.4, 0.9]);
  });
});

const SIZE = 32;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** A camera-facing metal quad (reflects the environment; no diffuse). */
function metalQuad(): MeshAsset {
  return {
    name: "metal",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.95, 0.95, 0.95, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0.2 },
      },
    ],
  };
}

function centre(env: EnvironmentLight): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene([{ mesh: metalQuad(), model: identity() }], {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    lightDirection: [0, 0, -1], // behind: no direct term, isolate the reflection
    ambient: 0.1,
    environment: env,
  });
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

describe("rasteriser IBL — a metal mirrors the environment map", () => {
  it("takes the colour of the map it reflects", () => {
    const blue = centre(mapEnv(solidMap(20, 40, 230)));
    const red = centre(mapEnv(solidMap(230, 40, 20)));
    expect(blue[2]).toBeGreaterThan(blue[0] + 30); // blue map → blue reflection
    expect(red[0]).toBeGreaterThan(red[2] + 30); // red map → red reflection
  });
});
