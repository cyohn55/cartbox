/**
 * Water (BEAVER_CREEK_ROADMAP.md B5): the stored field, the shared ripple
 * maths, the GPU packing, and what moving water does to a software-rendered
 * frame. (The GPU shaders are checked against these frames by webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  WATER_PERIOD,
  composeModelMatrix,
  deserializeMeshAsset,
  materialHasWater,
  projectionMatrix,
  readSurfaceEffects,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  waterTilt,
  waterUniform,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { UNIFORM_FLOATS, resolvePbr, writeInstanceUniform } from "@cartbox/player";

import { WATER, WATER_ENVIRONMENT, WATER_TIME, waterInstances } from "./helpers/waterScenes";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

function quad(material: Material = {}): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

const W = 160;
const H = 120;

function render(instances: MeshSceneInstance[], time = WATER_TIME): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 2.6, 2.4], [0, -0.3, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [20, 20, 30, 255],
    environment: WATER_ENVIRONMENT,
    time,
  });
  return out;
}

const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 12) n += 1;
  return n;
};

describe("the water field", () => {
  it("reads, clamps and drops malformed water", () => {
    expect(readSurfaceEffects({ water: { strength: 5, scale: 100, speed: -1, flow: 9 } }).water).toEqual({ strength: 2, scale: 8, speed: 0, flow: Math.PI });
    expect(readSurfaceEffects({ water: { strength: 0, scale: 1, speed: 1, flow: 0 } }).water).toBeUndefined();
    expect(readSurfaceEffects({ water: { strength: 1, scale: "x", speed: 1, flow: 0 } }).water).toBeUndefined();
    expect(readSurfaceEffects({ water: 3 }).water).toBeUndefined();
  });

  it("survives a save and load", () => {
    const loaded = deserializeMeshAsset(JSON.parse(JSON.stringify(serializeMeshAsset(quad({ water: WATER })))));
    expect(loaded.primitives[0]!.material.water).toEqual(WATER);
    expect(materialHasWater(loaded.primitives[0]!.material)).toBe(true);
    expect(materialHasWater(quad().primitives[0]!.material)).toBe(false);
  });
});

describe("the ripples", () => {
  it("wraps the drift phase on the CPU, so a GPU never sees a large time", () => {
    expect(waterUniform({}, 5)).toEqual([0, 0, 0, 0]);
    const [strength, scale, phase, flow] = waterUniform({ water: { strength: 0.5, scale: 2, speed: 1, flow: 1 } }, 1e6 + 3);
    expect([strength, scale, flow]).toEqual([0.5, 2, 1]);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
    expect(phase).toBeCloseTo(((1e6 + 3) / WATER_PERIOD) % 1, 6);
  });

  it("tilts the normal by an amount that varies over the surface and over time", () => {
    expect(waterTilt([0, 3, 0.2, 0], 1, 1)).toEqual([0, 0]);
    const u = waterUniform({ water: WATER }, 0.3);
    const tilts = [0, 0.37, 0.81, 1.4].map((x) => waterTilt(u, x, 0.5));
    expect(new Set(tilts.map((t) => t[0].toFixed(4))).size).toBe(4);
    for (const [tx, tz] of tilts) expect(Math.hypot(tx, tz)).toBeLessThan(WATER.strength * 2);
    const later = waterTilt(waterUniform({ water: WATER }, 1.3), 0.37, 0.5);
    expect(later).not.toEqual(tilts[1]);
  });

  it("drifts forever without a jump where a layer restarts", () => {
    const at = (phase: number) => waterTilt([0.6, 3, phase, 0.4], 0.31, -0.72);
    const end = at(1 - 1e-7);
    const start = at(0);
    expect(end[0]).toBeCloseTo(start[0], 4);
    expect(end[1]).toBeCloseTo(start[1], 4);
    // …and changes smoothly through the period.
    for (let p = 0; p < 1; p += 0.05) {
      const a = at(p);
      const b = at(p + 0.001);
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.05);
    }
  });
});

describe("water on the GPU", () => {
  it("takes the PBR path", () => {
    expect(resolvePbr({ water: WATER }, false, false, false).isPbr).toBe(true);
    expect(resolvePbr({ water: { ...WATER, strength: 0 } }, false, false, false).isPbr).toBe(false);
  });

  it("writes the ripples at byte 848", () => {
    const target = new Float32Array(UNIFORM_FLOATS).fill(-7);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const uniform = {
      mvp: identity,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1] as const,
      hasTexture: false,
      light: { direction: [0, 1, 0] as const, ambient: 0.3 },
      viewDir: [0, 0, 1] as const,
      pbr: { isPbr: true, metallic: 0, roughness: 1, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: null,
      lightCount: 0,
    };
    writeInstanceUniform(target, 0, { ...uniform, water: [0.5, 2, 0.25, 1] });
    expect(Array.from(target.subarray(212, 216))).toEqual([0.5, 2, 0.25, 1]);
    writeInstanceUniform(target, 0, uniform);
    expect(Array.from(target.subarray(212, 216))).toEqual([0, 0, 0, 0]);
  });
});

describe("water in a frame", () => {
  it("ripples the pool's reflections and bends the creek bed, and moves with time", () => {
    const rippled = render(waterInstances(quad));
    const still = render(waterInstances(quad, null));
    expect(differing(rippled, still)).toBeGreaterThan(300);
    // Still water doesn't change with time; moving water does.
    expect(differing(render(waterInstances(quad, null), 2.1), still)).toBe(0);
    expect(differing(render(waterInstances(quad), 2.1), rippled)).toBeGreaterThan(100);
  });

  it("leaves everything else in the frame alone", () => {
    const wall = { mesh: quad({ metallicFactor: 0, roughnessFactor: 0.6 }), model: composeModelMatrix([0, 0.6, -1.2], [0, 0, 0], [2, 0.5, 1]) };
    const a = render([...waterInstances(quad), wall]);
    const b = render([...waterInstances(quad, null), wall]);
    const top = (f: Uint8ClampedArray) => f.slice(0, W * 30 * 4);
    expect(differing(top(a), top(b))).toBe(0);
  });
});
