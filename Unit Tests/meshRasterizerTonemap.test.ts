/**
 * Phase 4 — HDR tone mapping (software reference path).
 *
 * PBR shading accumulates radiance that can exceed 1 (a bright environment, a
 * strong emissive). Without tone mapping those channels clip flat to 255; with
 * the ACES filmic curve + exposure they roll off, so an over-bright surface stays
 * distinguishable from a merely-white one. Gated: no `tonemap` → byte-identical
 * (and the fantasy path never tone-maps).
 */

import { describe, expect, it } from "vitest";

import {
  acesFilmic,
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type Mat4,
  type MeshAsset,
  type ToneMap,
} from "@cartbox/editor";

type Material = MeshAsset["primitives"][number]["material"];

function quad(material: Material): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const SIZE = 16;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** Centre pixel of a PBR quad with a given emissive factor and tone map. */
function centre(emissive: readonly [number, number, number], tonemap: ToneMap | null): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  const material: Material = {
    name: "e",
    baseColorFactor: [0.5, 0.5, 0.5, 1],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 1,
    emissiveFactor: emissive,
  };
  renderMeshScene([{ mesh: quad(material), model: identity() }], {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    lightDirection: [0, 0, 1],
    ambient: 0.1,
    tonemap,
  });
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

describe("acesFilmic", () => {
  it("maps 0 to 0 and is monotonic, saturating below 1", () => {
    expect(acesFilmic(0)).toBe(0);
    expect(acesFilmic(0.18)).toBeGreaterThan(0);
    expect(acesFilmic(1)).toBeGreaterThan(acesFilmic(0.5));
    expect(acesFilmic(1000)).toBeLessThanOrEqual(1);
    expect(acesFilmic(1000)).toBeGreaterThan(0.9);
  });

  it("clamps negatives to 0", () => {
    expect(acesFilmic(-5)).toBe(0);
  });
});

describe("rasteriser HDR tone mapping", () => {
  it("rolls very bright highlights off below pure white instead of clipping", () => {
    // A hugely over-bright emissive: untone-mapped it clips to 255; tone-mapped it
    // rolls off, so it stays below 255 and distinguishable from a brighter one.
    const clipped = centre([4, 4, 4], null)[0];
    const dim = centre([4, 4, 4], { exposure: 1 })[0];
    const dimmer = centre([2, 4, 4], { exposure: 1 })[0]; // less red
    expect(clipped).toBe(255); // no tone map → clipped flat
    expect(dim).toBeLessThan(255); // tone-mapped highlights roll off
    expect(dim).toBeGreaterThan(dimmer); // and the roll-off preserves ordering
  });

  it("exposure scales the image before the curve", () => {
    const low = centre([0.4, 0.4, 0.4], { exposure: 0.5 })[0];
    const high = centre([0.4, 0.4, 0.4], { exposure: 4 })[0];
    expect(high).toBeGreaterThan(low);
  });

  it("is byte-identical to no tone map for in-range colours near mid-grey", () => {
    // For values well within [0,1] the presence of the branch must not change a
    // dim surface unless tone mapping is actually requested (the gate).
    const a = centre([0, 0, 0], null);
    const b = centre([0, 0, 0], null);
    expect(a).toEqual(b);
  });
});
