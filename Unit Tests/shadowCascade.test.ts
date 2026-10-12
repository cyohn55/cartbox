/**
 * The near shadow cascade (ENGINE_PARITY_ROADMAP.md EP8b): which map a point
 * tests against, and the mesh overlay's near map — the same scene as a
 * from-scratch render round the camera, redrawn only as the camera crosses a
 * cell, and only on the high quality preset.
 */

import { describe, expect, it } from "vitest";

import {
  NEAR_CASCADE_BLEND,
  NEAR_CASCADE_EDGE,
  shadowVisibility,
  buildSceneShadow,
  cameraPositionFromView,
  composeModelMatrix,
  defaultSceneLighting,
  orthographicMatrix,
  patchSceneLighting,
  sunShadowVisibility,
  viewMatrix,
  type MeshAsset,
  type ShadowInput,
} from "@cartbox/editor";
import { MeshOverlaySurface, QUALITY_PRESETS, type SceneDraw, type SceneRenderer } from "@cartbox/player";

describe("choosing a map", () => {
  // Main map: everything lit (depth 1). Near map: everything shadowed (depth −1, so any point is behind it).
  const view = viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]);
  const near = orthographicMatrix(-2, 2, -2, 2, 0.1, 20);
  const nearMvp = Float64Array.from({ length: 16 }, (_, i) => {
    let v = 0;
    for (let k = 0; k < 4; k += 1) v += near[(i % 4) + k * 4]! * view[k + Math.floor(i / 4) * 4]!;
    return v;
  });
  const shadow: ShadowInput = {
    lightViewProj: nearMvp,
    depth: new Float32Array(16).fill(1),
    size: 4,
    near: { lightViewProj: nearMvp, depth: new Float32Array(16).fill(-1), bias: 0.001, slopeBias: 0 },
  };

  it("tests a point well inside the near cascade against it, and one near its edge or outside against the main map", () => {
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, 0, 0, 0, 1)).toBe(0); // inside: the near map shadows it
    const edge = 2 * NEAR_CASCADE_EDGE + 0.02; // just past the near map's inner edge (world units here)
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, edge, 0, 0, 1)).toBe(1); // main map: lit
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, 5, 0, 5, 1)).toBe(1);
    expect(sunShadowVisibility({ ...shadow, near: null }, 0, 0, 0.5, 0, 0, 0, 1)).toBe(1);
  });
  it("fades from the near map to the main one toward the near map's edge, leaving no seam (B7)", () => {
    const at = (x: number) => sunShadowVisibility(shadow, 0, 0, 0.5, x, 0, 0, 1);
    // World x maps to the near map's NDC as x / 2 here.
    expect(at(2 * NEAR_CASCADE_BLEND)).toBe(0); // still the near map's alone
    expect(at(2 * ((NEAR_CASCADE_BLEND + NEAR_CASCADE_EDGE) / 2))).toBeCloseTo(0.5, 6); // halfway through the fade
    expect(at(2 * NEAR_CASCADE_EDGE - 1e-4)).toBeCloseTo(1, 2); // all but the main map's at the edge
    let last = -1;
    for (let x = 0; x < 2 * NEAR_CASCADE_EDGE; x += 0.01) {
      const v = at(x);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      last = v;
    }
  });
});

describe("soft shadows (B7)", () => {
  // A 16² map: the left half at depth −1 (an occluder over everything), the right half clear.
  const depth = new Float32Array(16 * 16);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) depth[y * 16 + x] = x < 8 ? -1 : 1;
  const map: ShadowInput = { lightViewProj: new Float64Array(16), depth, size: 16, bias: 0 };
  const across = (s: ShadowInput) => Array.from({ length: 9 }, (_, i) => shadowVisibility(s, (i - 4) / 16, 0, 0.5, 1));

  it("widens the penumbra from one texel to four", () => {
    const hard = across(map);
    const pcf = across({ ...map, pcf: true });
    const soft = across({ ...map, pcf: true, soft: true });
    const partial = (vs: number[]) => vs.filter((v) => v > 0 && v < 1).length;
    expect(partial(hard)).toBe(0);
    expect(partial(soft)).toBeGreaterThan(partial(pcf));
    // Every filter agrees far from the edge.
    for (const vs of [hard, pcf, soft]) {
      expect(vs[0]).toBe(0);
      expect(vs[8]).toBe(1);
    }
  });

  it("is what a lighting rig with softShadows builds", () => {
    const built = buildSceneShadow(scene().instances, patchSceneLighting(lighting, { softShadows: true }), [0, 0, 0], 10, { size: 32, depth: new Float32Array(32 * 32) });
    expect(built?.pcf).toBe(true);
    expect(built?.soft).toBe(true);
    expect(buildSceneShadow(scene().instances, lighting, [0, 0, 0], 10, { size: 32, depth: new Float32Array(32 * 32) })?.soft).toBeUndefined();
  });
});

function box(name: string): MeshAsset {
  const p: number[] = [];
  const idx: number[] = [];
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const) {
    const base = p.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = [0, 0, 0];
      v[a] = 0.5;
      v[b] = 0.5 * s!;
      v[c] = 0.5 * t!;
      p.push(...v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // …and the opposite faces.
  const n = p.length / 3;
  for (let i = 0; i < n; i += 1) p.push(-p[i * 3]!, -p[i * 3 + 1]!, -p[i * 3 + 2]!);
  for (let i = 0, m = idx.length; i < m; i += 1) idx.push(idx[i]! + n);
  return { name, primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name, baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 } }] };
}

const lighting = patchSceneLighting(defaultSceneLighting(), { shadows: true });
const bounds = { min: [-12, 0, -12] as [number, number, number], max: [12, 3, 12] as [number, number, number], center: [0, 1.5, 0] as [number, number, number], radius: 17 };
const scene = () => ({
  instances: [
    { mesh: box("floor"), model: composeModelMatrix([0, -0.5, 0], [0, 0, 0], [24, 1, 24]) },
    { mesh: box("pillar"), model: composeModelMatrix([-2, 1, -1], [0, 0, 0], [1, 2, 1]) },
    { mesh: box("crate"), model: composeModelMatrix([3, 0.5, 2], [0, 0, 0], [1, 1, 1]) },
  ],
  bounds,
  lighting,
});

function spy(): SceneRenderer & { draws: { view: SceneDraw["view"]; shadow: ShadowInput | null; near: Float32Array | null }[] } {
  const draws: { view: SceneDraw["view"]; shadow: ShadowInput | null; near: Float32Array | null }[] = [];
  return {
    backend: "webgpu",
    draws,
    render: (_i, draw) => draws.push({ view: draw.view, shadow: draw.shadow ?? null, near: draw.shadow?.near ? Float32Array.from(draw.shadow.near.depth) : null }),
    dispose: () => {},
  };
}
const camera = (x: number, z: number) => ({ yaw: 0.6, pitch: 0.4, distance: 3, target: [x, 0, z] as [number, number, number], fov: null, hud: false });

describe("the mesh overlay's near cascade", () => {
  it("renders the scene round the camera — matching a from-scratch map — sharper than the main one", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const frame = s.draws.at(-1)!;
    expect(frame.shadow?.near).toBeTruthy();
    // Rebuild what the overlay should have drawn: radius 17 × 0.3 = 5.1, its centre snapped to 2.55.
    const r = 17 * 0.3;
    const step = r / 2;
    const eye = cameraPositionFromView(frame.view);
    const c: [number, number, number] = [Math.round(eye[0] / step) * step, Math.round(eye[1] / step) * step, Math.round(eye[2] / step) * step];
    const reference = buildSceneShadow(scene().instances, lighting, c, r, { size: 1024, depth: new Float32Array(1024 * 1024), reach: 17 * 2 })!;
    let mismatched = 0;
    for (let k = 0; k < reference.depth.length; k += 1) if (frame.near![k] !== reference.depth[k]) mismatched += 1;
    expect(mismatched).toBe(0);
    expect(Array.from(frame.shadow!.near!.lightViewProj)).toEqual(Array.from(reference.lightViewProj));
  });

  it("is redrawn only when the camera crosses into another cell", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    surface.setCameraOverride(camera(1.05, 1.02)); // a step: same cell
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow!.near!.dirty).not.toBeNull(); // an update, not a redraw
    surface.setCameraOverride(camera(9, -7)); // across the arena
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow!.near!.dirty).toBeNull(); // redrawn in full
  });

  it("is a high-quality feature: medium keeps the single map", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setQuality(QUALITY_PRESETS.medium);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow).toBeTruthy();
    expect(s.draws.at(-1)!.shadow!.near ?? null).toBeNull();
  });
});
