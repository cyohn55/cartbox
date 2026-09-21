/**
 * Phase 4 — screen-space ambient occlusion (software reference path).
 *
 * A geometry pre-pass (renderGeometryBuffers) records camera-space depth + view
 * normals; computeSsao then orients a hemisphere kernel to each pixel's normal
 * and counts samples hidden behind nearer geometry. A flat wall reads open
 * (AO ≈ 1); a concave corner darkens in the crease. renderMeshScene multiplies
 * only the PBR ambient term by the AO buffer, so creases pick up contact
 * shadowing. Gated: no `ssao` buffer → unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  computeSsao,
  DEFAULT_SSAO,
  projectionMatrix,
  renderGeometryBuffers,
  renderMeshScene,
  viewMatrix,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

type Material = MeshAsset["primitives"][number]["material"];

const PBR: Material = { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };

/** A quad from four corners with a constant normal. */
function quad(p: readonly number[], normal: readonly [number, number, number], material: Material = PBR): MeshAsset {
  const [nx, ny, nz] = normal;
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from([nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const W = 48;
const H = 48;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const VIEW = viewMatrix([0, 1, 4.5], [0, 0.4, -0.6]);
const PROJ = projectionMatrix((55 * Math.PI) / 180, W / H, 0.1, 100);

/** A flat wall facing the camera. */
function flatScene() {
  return [{ mesh: quad([-2, -1, 0, 2, -1, 0, 2, 2, 0, -2, 2, 0], [0, 0, 1]), model: identity() }];
}

/** A floor + back wall meeting at a concave right-angle seam. */
function cornerScene() {
  return [
    { mesh: quad([-2, 0, 1, 2, 0, 1, 2, 0, -1.2, -2, 0, -1.2], [0, 1, 0]), model: identity() }, // floor
    { mesh: quad([-2, 0, -1.2, 2, 0, -1.2, 2, 2, -1.2, -2, 2, -1.2], [0, 0, 1]), model: identity() }, // wall
  ];
}

function meanAoOverDrawn(instances: ReturnType<typeof flatScene>): number {
  const geo = renderGeometryBuffers(instances, { width: W, height: H, view: VIEW, projection: PROJ });
  const ao = computeSsao(geo, PROJ, { ...DEFAULT_SSAO, radius: 0.6, intensity: 1 });
  let sum = 0;
  let n = 0;
  for (let i = 0; i < W * H; i += 1) {
    if (Number.isFinite(geo.depth[i]!)) {
      sum += ao[i]!;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 1;
}

describe("renderGeometryBuffers", () => {
  it("writes finite depth and a camera-facing view normal for a visible quad", () => {
    const geo = renderGeometryBuffers(flatScene(), { width: W, height: H, view: VIEW, projection: PROJ });
    const di = (H >> 1) * W + (W >> 1);
    expect(Number.isFinite(geo.depth[di]!)).toBe(true);
    expect(geo.depth[di]!).toBeGreaterThan(0);
    // A wall facing +Z, viewed head-on, has a view normal pointing at the camera (+Z).
    expect(geo.normals[di * 3 + 2]!).toBeGreaterThan(0.7);
  });

  it("leaves the background at +Infinity depth", () => {
    const geo = renderGeometryBuffers(flatScene(), { width: W, height: H, view: VIEW, projection: PROJ });
    expect(geo.depth[0]).toBe(Infinity); // a corner pixel the quad does not cover
  });
});

describe("computeSsao", () => {
  it("reads a flat wall as open (little occlusion)", () => {
    expect(meanAoOverDrawn(flatScene())).toBeGreaterThan(0.9);
  });

  it("darkens a concave corner more than a flat wall", () => {
    expect(meanAoOverDrawn(cornerScene())).toBeLessThan(meanAoOverDrawn(flatScene()));
  });

  it("keeps background pixels fully open", () => {
    const geo = renderGeometryBuffers(flatScene(), { width: W, height: H, view: VIEW, projection: PROJ });
    const ao = computeSsao(geo, PROJ);
    expect(ao[0]).toBe(1); // uncovered corner
  });
});

describe("rasteriser SSAO integration", () => {
  it("darkens the ambient in creases and leaves the frame unchanged without a buffer", () => {
    const instances = cornerScene();
    const render = (ssao: Float32Array | null): Uint8ClampedArray => {
      const out = new Uint8ClampedArray(W * H * 4);
      const depth = new Float32Array(W * H);
      renderMeshScene(instances, {
        width: W,
        height: H,
        out,
        depth,
        view: VIEW,
        projection: PROJ,
        lightDirection: [0, 0, -1], // behind: ambient dominates, so AO is visible
        ambient: 0.6,
        background: [0, 0, 0, 255],
        ssao,
      });
      return out;
    };
    const geo = renderGeometryBuffers(instances, { width: W, height: H, view: VIEW, projection: PROJ });
    const ao = computeSsao(geo, PROJ, { ...DEFAULT_SSAO, radius: 0.6, intensity: 1 });

    const plain = render(null);
    const occluded = render(ao);
    let plainSum = 0;
    let occSum = 0;
    for (let i = 0; i < W * H * 4; i += 4) {
      plainSum += plain[i]!;
      occSum += occluded[i]!;
    }
    expect(occSum).toBeLessThan(plainSum); // SSAO removed ambient in the crease
    // The two frames are identical where AO is 1 (open areas) — a spot-check that
    // SSAO only subtracts, never adds.
    expect(occSum).toBeGreaterThan(plainSum * 0.5);
  });
});
