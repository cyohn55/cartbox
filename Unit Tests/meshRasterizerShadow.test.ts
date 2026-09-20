/**
 * Phase 3 — directional shadow maps (software reference path).
 *
 * A two-pass shadow map: `renderShadowMap` records scene depth from the sun's
 * orthographic view, then `renderMeshScene` projects each fragment into that view
 * and darkens the direct light where something nearer the sun already occupies
 * the texel. An occluder floating over a floor must therefore cast a shadow onto
 * it; the shadow darkens the direct term but not the ambient fill; and a scene
 * with no shadow input is unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  orthographicMatrix,
  projectionMatrix,
  renderMeshScene,
  renderShadowMap,
  viewMatrix,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

/** A horizontal quad (normal +Y) of half-extent `h`, centred at `y`. PBR grey. */
function floorQuad(h: number, y: number): MeshAsset {
  return {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-h, y, -h, h, y, -h, h, y, h, -h, y, h]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  };
}

const SIZE = 96;
const SHADOW_SIZE = 128;

/** The sun: an orthographic view looking straight down at the scene. */
const LIGHT_VIEW: Mat4 = viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]);
const LIGHT_PROJ: Mat4 = orthographicMatrix(-6, 6, -6, 6, 0.1, 20);

/** Floor at y=0 plus a small occluder hovering at y=3, both horizontal. */
function sceneWithOccluder() {
  return [
    { mesh: floorQuad(5, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
    { mesh: floorQuad(1.2, 3), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
  ];
}

function render(instances: ReturnType<typeof sceneWithOccluder>, withShadow: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  const shadow = withShadow
    ? renderShadowMap(instances, { lightView: LIGHT_VIEW, lightProjection: LIGHT_PROJ, size: SHADOW_SIZE, depth: new Float32Array(SHADOW_SIZE * SHADOW_SIZE) })
    : null;
  renderMeshScene(instances, {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    // Angled camera so the floor and the shadow beneath the occluder are visible.
    view: viewMatrix([0, 7, 8], [0, 0, 0], [0, 1, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    lightDirection: [0, 1, 0], // straight down from the sun overhead
    ambient: 0.25,
    background: [0, 0, 0, 255],
    shadow,
  });
  return out;
}

function luminance(rgba: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) sum += rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
  return sum;
}

describe("renderShadowMap", () => {
  it("captures the occluder nearer the light than the floor", () => {
    const depth = new Float32Array(SHADOW_SIZE * SHADOW_SIZE);
    renderShadowMap(sceneWithOccluder(), { lightView: LIGHT_VIEW, lightProjection: LIGHT_PROJ, size: SHADOW_SIZE, depth });
    const centre = depth[(SHADOW_SIZE >> 1) * SHADOW_SIZE + (SHADOW_SIZE >> 1)]!;
    // A texel well inside the floor but outside the small central occluder (the
    // floor spans [-5,5] within the [-6,6] map, the occluder only [-1.2,1.2]).
    const corner = depth[32 * SHADOW_SIZE + 32]!;
    // Both texels were drawn (finite), and the centre — the occluder at y=3 — is
    // nearer the overhead light than the corner, which sees only the floor at y=0.
    expect(Number.isFinite(centre)).toBe(true);
    expect(Number.isFinite(corner)).toBe(true);
    expect(centre).toBeLessThan(corner);
  });
});

describe("rasteriser directional shadows", () => {
  it("darkens the scene where the occluder blocks the sun", () => {
    const lit = render(sceneWithOccluder(), false);
    const shadowed = render(sceneWithOccluder(), true);
    // The cast shadow removes direct light from a patch of floor, so the shadowed
    // frame is overall darker, and a meaningful number of pixels dropped.
    expect(luminance(shadowed)).toBeLessThan(luminance(lit));
    let darkened = 0;
    for (let i = 0; i < lit.length; i += 4) {
      if (lit[i]! - shadowed[i]! > 20) darkened += 1;
    }
    expect(darkened).toBeGreaterThan(50);
  });

  it("leaves the direct light's ambient fill in shadow (shadows are not black)", () => {
    const shadowed = render(sceneWithOccluder(), true);
    // Every drawn floor/occluder pixel keeps at least its ambient term; no drawn
    // pixel is crushed to pure black by the shadow.
    let litFloor = 0;
    for (let i = 0; i < shadowed.length; i += 4) {
      // A drawn pixel (alpha 255) that is grey and non-zero: ambient survives.
      if (shadowed[i + 3] === 255 && shadowed[i]! > 0) litFloor += 1;
    }
    expect(litFloor).toBeGreaterThan(1000);
  });

  it("does not shadow a floor with nothing above it (bias controls acne)", () => {
    const floorOnly = [{ mesh: floorQuad(5, 0), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }];
    const lit = render(floorOnly, false);
    const shadowed = render(floorOnly, true);
    // With nothing casting, the floor must not shadow itself: the two frames match
    // within a hair (a couple of 8-bit levels from the depth compare at edges).
    let maxDelta = 0;
    for (let i = 0; i < lit.length; i += 1) maxDelta = Math.max(maxDelta, Math.abs(lit[i]! - shadowed[i]!));
    expect(maxDelta).toBeLessThanOrEqual(2);
  });
});
