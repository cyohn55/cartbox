/**
 * Light probes (ENGINE_PARITY_ROADMAP.md EP9): planning a grid, storing it,
 * sampling it (trilinear between probes, the ambient cube's faces by the
 * normal), baking it (shade under cover, bounce off a sunlit wall), its effect
 * on a surface without a light map, and Lockout shipping its bake.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_LIGHT_PROBES,
  bakeLightProbes,
  composeModelMatrix,
  decodeLightProbes,
  encodeLightProbes,
  lockoutMeshSidecar,
  parseSceneLighting,
  planProbeGrid,
  probePosition,
  projectionMatrix,
  renderMeshScene,
  sampleLightProbes,
  viewMatrix,
  type LightProbeGrid,
  type MeshAsset,
} from "@cartbox/editor";

import { blockMesh } from "./helpers/localShadowScene";

/** A 2×2×2 grid whose probes differ: face f of probe p holds (p + 1) / 10 + f / 100 in red, and 0.5 elsewhere. */
function synthetic(): LightProbeGrid {
  const values = new Float32Array(8 * 18);
  for (let p = 0; p < 8; p += 1) {
    for (let f = 0; f < 6; f += 1) {
      values.set([(p + 1) / 10 + f / 100, 0.5, 0.5], (p * 6 + f) * 3);
    }
  }
  return { min: [0, 0, 0], max: [2, 2, 2], counts: [2, 2, 2], values };
}

describe("the grid", () => {
  it("plans at least two probes an axis, about the spacing apart, within the cap", () => {
    expect(planProbeGrid([0, 0, 0], [10, 1, 5], 2.5)).toEqual([5, 2, 3]);
    const huge = planProbeGrid([0, 0, 0], [1000, 100, 1000], 1);
    expect(huge[0] * huge[1] * huge[2]).toBeLessThanOrEqual(MAX_LIGHT_PROBES);
    expect(probePosition({ min: [0, 0, 0], max: [10, 1, 5], counts: [5, 2, 3] }, 4, 1, 1)).toEqual([10, 1, 2.5]);
  });

  it("stores as bytes and decodes back, rejecting data that doesn't fit its counts", () => {
    const grid = { ...synthetic(), values: Float32Array.from(synthetic().values, (v) => Math.round((v / 1.5) * 255) / 255 * 1.5) };
    const back = decodeLightProbes(JSON.parse(JSON.stringify(encodeLightProbes(grid))))!;
    expect(back.counts).toEqual([2, 2, 2]);
    for (let i = 0; i < grid.values.length; i += 1) expect(back.values[i]).toBeCloseTo(grid.values[i]!, 6);
    expect(decodeLightProbes({ ...encodeLightProbes(grid), counts: [3, 2, 2] })).toBeNull();
    expect(decodeLightProbes({ min: [0, 0, 0] })).toBeNull();
    // A rig keeps only a grid that decodes.
    expect(parseSceneLighting({ lightProbes: encodeLightProbes(grid) })!.lightProbes).toBeTruthy();
    expect(parseSceneLighting({ lightProbes: { ...encodeLightProbes(grid), data: "!!" } })!.lightProbes).toBeUndefined();
  });

  it("samples a probe's face at the probe, blends between probes, and weighs faces by the normal", () => {
    const g = synthetic();
    // Probe 0 (the corner), facing +X (face 0): 0.1.
    expect(sampleLightProbes(g, 0, 0, 0, 1, 0, 0)[0]).toBeCloseTo(0.1);
    // Facing −Y (face 3) at probe 7 (the far corner): 0.8 + 0.03.
    expect(sampleLightProbes(g, 2, 2, 2, 0, -1, 0)[0]).toBeCloseTo(0.83);
    // Halfway along x between probes 0 and 1, facing +X: the mean of 0.1 and 0.2.
    expect(sampleLightProbes(g, 1, 0, 0, 1, 0, 0)[0]).toBeCloseTo(0.15);
    // A diagonal normal: half +X (0.1), half +Y (0.12) at probe 0.
    expect(sampleLightProbes(g, 0, 0, 0, 1, 1, 0)[0]).toBeCloseTo(0.11);
    // Outside the box clamps to its edge.
    expect(sampleLightProbes(g, -5, -5, -5, 1, 0, 0)[0]).toBeCloseTo(0.1);
    expect(sampleLightProbes(g, 1, 1, 1, 0, 0, 1)[1]).toBeCloseTo(0.5);
  });
});

describe("baking", () => {
  const ground = { mesh: blockMesh(6, 0.05, 6), model: composeModelMatrix([0, -0.05, 0], [0, 0, 0], [1, 1, 1]) };
  const roof = { mesh: blockMesh(2, 0.05, 2), model: composeModelMatrix([-3, 2, 0], [0, 0, 0], [1, 1, 1]) };
  const red: MeshAsset = { ...blockMesh(0.05, 2, 3), primitives: blockMesh(0.05, 2, 3).primitives.map((p) => ({ ...p, material: { ...p.material, baseColorFactor: [1, 0.1, 0.1, 1] as [number, number, number, number] } })) };
  const wall = { mesh: red, model: composeModelMatrix([3.5, 2, 0], [0, 0, 0], [1, 1, 1]) };

  it("darkens the sky face under cover, and tints the face toward a sunlit red wall", () => {
    const grid = bakeLightProbes([-4, 1, -1], [4, 1, 1], [9, 2, 2], [ground, roof, wall], { rays: 64, distance: 6, sun: [-1, 1, 0] });
    const up = (x: number) => sampleLightProbes(grid, x, 1, 0, 0, 1, 0);
    expect(up(-3)[0]).toBeLessThan(up(0)[0] - 0.2); // under the roof vs in the open
    const towardWall = sampleLightProbes(grid, 3, 1, 0, 1, 0, 0);
    expect(towardWall[0]).toBeGreaterThan(towardWall[2] + 0.05); // red bounce
  });
});

describe("shading", () => {
  it("scales a surface's ambient by the grid when it has no light map", () => {
    const S = 24;
    const draw = (lightProbes: LightProbeGrid | null) => {
      const out = new Uint8ClampedArray(S * S * 4);
      renderMeshScene([{ mesh: blockMesh(0.6, 0.6, 0.6), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
        width: S,
        height: S,
        out,
        depth: new Float32Array(S * S),
        view: viewMatrix([0, 0, 3], [0, 0, 0]),
        projection: projectionMatrix(1, 1, 0.1, 10),
        ambient: 1,
        lightDirection: [0, 0, -1], // from behind: only the ambient fill shows
        environment: { sky: [1, 1, 1], horizon: [1, 1, 1], ground: [1, 1, 1], intensity: 0.6, ...(lightProbes ? { lightProbes } : {}) },
        background: [0, 0, 0, 255],
      });
      return out[(12 * S + 12) * 4]!;
    };
    const dim = { ...synthetic(), values: new Float32Array(8 * 18).fill(0.3) };
    const bright = { ...synthetic(), values: new Float32Array(8 * 18).fill(1.2) };
    expect(draw(dim)).toBeLessThan(draw(null) * 0.5);
    expect(draw(bright)).toBeGreaterThan(draw(dim) * 2);
  });

  it("ships Lockout with its baked probes", () => {
    const sidecar = JSON.parse(lockoutMeshSidecar());
    const grid = decodeLightProbes(sidecar.lighting.lightProbes)!;
    expect(grid).toBeTruthy();
    expect(grid.counts[0] * grid.counts[1] * grid.counts[2]).toBeGreaterThan(100);
  });
});
