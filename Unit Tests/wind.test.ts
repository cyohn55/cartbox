/**
 * Wind (BEAVER_CREEK_ROADMAP.md B6): the scene's wind, the shared sway maths,
 * the sway foliage carries, the GPU packing, and what wind does to a
 * software-rendered frame. (The GPU shaders are checked against these frames
 * by webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  WIND_PERIOD,
  foliageBlocks,
  foliagePreset,
  foliageSway,
  parseSceneLighting,
  parseWind,
  projectionMatrix,
  readFoliage,
  renderMeshScene,
  serializeFoliage,
  viewMatrix,
  windOffset,
  windUniform,
  type MeshSceneInstance,
  type SceneWind,
} from "@cartbox/editor";
import { UNIFORM_FLOATS, writeInstanceUniform } from "@cartbox/player";

import { WIND, WIND_EYE, WIND_TARGET, WIND_TIME, windGround, windInstances } from "./helpers/windScenes";

const W = 160;
const H = 120;

function render(instances: MeshSceneInstance[], wind: SceneWind | null, time = WIND_TIME): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix(WIND_EYE, WIND_TARGET),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [20, 20, 30, 255],
    lightDirection: [0.3, 0.8, -0.5],
    wind,
    time,
  });
  return out;
}

const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n += 1;
  return n;
};

describe("the scene's wind", () => {
  it("reads and clamps, and rides on the lighting", () => {
    expect(parseWind({ direction: 9, strength: 5, gust: -1 })).toEqual({ direction: Math.PI, strength: 2, gust: 0 });
    expect(parseWind({ direction: 1 })).toBeNull();
    expect(parseSceneLighting({ wind: WIND })?.wind).toEqual(WIND);
    expect(parseSceneLighting({})?.wind).toBeUndefined();
  });

  it("wraps its phase on the CPU", () => {
    expect(windUniform(null, 3)).toEqual([0, 0, 0, 0]);
    expect(windUniform({ ...WIND, strength: 0 }, 3)).toEqual([0, 0, 0, 0]);
    const [x, z, phase, gust] = windUniform(WIND, 1e6 + 5);
    expect(Math.hypot(x, z)).toBeCloseTo(WIND.strength, 9);
    expect(gust).toBe(WIND.gust);
    expect(phase).toBeCloseTo(((1e6 + 5) / WIND_PERIOD) % 1, 6);
  });
});

describe("swaying", () => {
  it("never moves a stiff vertex, and leans the rest downwind, more in a gust", () => {
    const u = windUniform(WIND, WIND_TIME);
    expect(windOffset(u, 1, 2, 0)).toEqual([0, 0]);
    expect(windOffset([0, 0, 0.3, 1], 1, 2, 1)).toEqual([0, 0]);
    for (let t = 0; t < WIND_PERIOD; t += 0.37) {
      const [dx, dz] = windOffset(windUniform(WIND, t), 0.3, -0.8, 0.5);
      expect(dx * Math.cos(WIND.direction) + dz * Math.sin(WIND.direction)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(0.5 * WIND.strength * (1 + WIND.gust) + 1e-9);
    }
  });

  it("moves with time, and repeats exactly over its period", () => {
    const a = windOffset(windUniform(WIND, 2), 0.3, -0.8, 0.5);
    expect(windOffset(windUniform(WIND, 2.2), 0.3, -0.8, 0.5)).not.toEqual(a);
    const b = windOffset(windUniform(WIND, 2 + WIND_PERIOD * 3), 0.3, -0.8, 0.5);
    expect(b[0]).toBeCloseTo(a[0], 6);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it("bends a plant nothing at its root and more toward its tip", () => {
    expect(foliageSway(0, 3)).toBe(0);
    expect(foliageSway(1, 0)).toBe(0);
    expect(foliageSway(0.5, 3)).toBeLessThan(foliageSway(1, 3));
    expect(foliageSway(1, 3)).toBeLessThan(foliageSway(1, 4));
  });
});

describe("foliage", () => {
  it("carries sway by height when its layer is flexible, and none when it's stiff", () => {
    const t = windGround();
    const { mesh, settings } = foliagePreset("grass");
    expect(settings.wind).toBeGreaterThan(0);
    const copies = [{ x: 1, z: 1, yaw: 0, scale: 1 }];
    const [block] = foliageBlocks(t, { id: "g", name: "g", terrain: t.id, ...settings, copies }, mesh, copies);
    const p = block!.mesh.primitives[0]!;
    expect(p.sway).toBeDefined();
    for (let v = 0; v < p.positions.length / 3; v += 1) {
      const local = mesh.primitives[0]!.positions[v * 3 + 1]!;
      expect(p.sway![v]).toBeCloseTo(foliageSway(local, settings.wind!), 6);
    }
    const [stiff] = foliageBlocks(t, { id: "g", name: "g", terrain: t.id, ...settings, wind: undefined, copies }, mesh, copies);
    expect(stiff!.mesh.primitives[0]!.sway).toBeUndefined();
    expect(foliagePreset("boulder").settings.wind).toBeUndefined();
  });

  it("stores its layer's flexibility", () => {
    const t = windGround();
    const layer = { id: "r", name: "reeds", terrain: t.id, ...foliagePreset("reeds").settings, copies: [] };
    const read = readFoliage(JSON.parse(JSON.stringify(serializeFoliage(t, layer, "mesh"))), [t]);
    expect(read?.layer.wind).toBe(4);
  });
});

describe("on the GPU", () => {
  it("packs the wind at byte 880", () => {
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
    writeInstanceUniform(target, 0, { ...uniform, wind: [0.5, -0.25, 0.75, 1] });
    expect(Array.from(target.subarray(220, 224))).toEqual([0.5, -0.25, 0.75, 1]);
    writeInstanceUniform(target, 0, uniform);
    expect(Array.from(target.subarray(220, 224))).toEqual([0, 0, 0, 0]);
  });
});

describe("in a frame", () => {
  it("sways the plants, moves them with time, and leaves the still scene alone", () => {
    const calm = render(windInstances(), null);
    const breezy = render(windInstances(), WIND);
    expect(differing(calm, breezy)).toBeGreaterThan(100);
    expect(differing(breezy, render(windInstances(), WIND, WIND_TIME + 0.3))).toBeGreaterThan(50);
    // Stiff plants don't move in any wind, at any time.
    expect(differing(render(windInstances(true), WIND), render(windInstances(true), null, 7))).toBe(0);
  });
});
