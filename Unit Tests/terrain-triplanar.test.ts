/**
 * Living terrain (BEAVER_CREEK_ROADMAP.md B6): triplanar mapping and
 * height-blended layer edges — the shared maths, the material and terrain
 * fields, the GPU packing, and what they do to a software-rendered frame.
 * (The GPU shaders are checked against these frames by webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  heightBlend,
  projectionMatrix,
  readSurfaceEffects,
  readTerrain,
  renderMeshScene,
  serializeTerrain,
  terrainMesh,
  triplanarUvs,
  triplanarWeights,
  viewMatrix,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { UNIFORM_FLOATS, resolveMapping, writeInstanceUniform } from "@cartbox/player";

import { CLIFF_EYE, CLIFF_TARGET, cliffInstances, cliffTerrain } from "./helpers/terrainScenes";

const W = 192;
const H = 144;

function render(instances: MeshSceneInstance[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix(CLIFF_EYE, CLIFF_TARGET),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [20, 20, 30, 255],
    lightDirection: [0.3, 0.8, -0.5],
  });
  return out;
}

/** Pixels differing between two frames, within rows [y0, y1). */
const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray, y0 = 0, y1 = H): number => {
  let n = 0;
  for (let i = y0 * W * 4; i < y1 * W * 4; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n += 1;
  return n;
};

describe("triplanar maths", () => {
  it("weighs the axis a surface faces, summing to one", () => {
    expect(triplanarWeights(0, 1, 0)).toEqual([0, 1, 0]);
    expect(triplanarWeights(0, -3, 0)).toEqual([0, 1, 0]);
    expect(triplanarWeights(1, 0, 0)).toEqual([1, 0, 0]);
    const [x, y, z] = triplanarWeights(0.3, 0.8, -0.5);
    expect(x + y + z).toBeCloseTo(1, 12);
    expect(y).toBeGreaterThan(z);
    expect(z).toBeGreaterThan(x);
  });

  it("lays the top projection exactly as a terrain's planar UVs", () => {
    const [, top] = triplanarUvs(3, 7, -5, 2);
    expect(top).toEqual([1.5, -2.5]);
  });
});

describe("height blending", () => {
  it("leaves the weight alone at zero sharpness", () => {
    for (const w of [0, 0.3, 0.5, 1]) expect(heightBlend(w, 0.2, 0.9, 0)).toBe(w);
  });

  it("lets the higher surface through first, and tightens the edge", () => {
    expect(heightBlend(0.5, 0.2, 0.8, 0.6)).toBeGreaterThan(0.5);
    expect(heightBlend(0.5, 0.8, 0.2, 0.6)).toBeLessThan(0.5);
    expect(heightBlend(0.6, 0.5, 0.5, 1)).toBe(1);
    expect(heightBlend(0.4, 0.5, 0.5, 1)).toBe(0);
    expect(heightBlend(0, 0.5, 0.5, 0.7)).toBe(0);
    expect(heightBlend(1, 0.5, 0.5, 0.7)).toBe(1);
  });
});

describe("the fields", () => {
  it("read and clamp on a material", () => {
    expect(readSurfaceEffects({ triplanar: 0.5, blendSharpness: 3 })).toEqual({ triplanar: 0.5, blendSharpness: 1 });
    expect(readSurfaceEffects({ triplanar: 0, blendSharpness: -1 })).toEqual({});
  });

  it("survive a terrain's save and load, and reach its layers' materials", () => {
    const t = cliffTerrain({ triplanar: true, sharpness: 0.6 });
    const loaded = readTerrain(JSON.parse(JSON.stringify(serializeTerrain(t))))!;
    expect(loaded.triplanar).toBe(true);
    expect(loaded.blend?.sharpness).toBe(0.6);
    const mesh = terrainMesh(loaded);
    expect(mesh.primitives.every((p) => p.material.triplanar === 0.5)).toBe(true);
    const pairs = mesh.primitives.filter((p) => p.blend);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => p.material.blendSharpness === 0.6)).toBe(true);
    expect(terrainMesh(cliffTerrain()).primitives.some((p) => p.material.triplanar !== undefined || p.material.blendSharpness !== undefined)).toBe(false);
  });
});

describe("on the GPU", () => {
  it("resolves as the rasteriser does and packs at byte 864", () => {
    expect(resolveMapping({})).toBeNull();
    expect(resolveMapping({ triplanar: 2, blendSharpness: 1.5 })).toEqual({ triplanar: 2, blendSharpness: 1 });
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
    writeInstanceUniform(target, 0, { ...uniform, mapping: { triplanar: 0.5, blendSharpness: 0.25 } });
    expect(Array.from(target.subarray(216, 220))).toEqual([0.5, 0.25, 0, 0]);
    writeInstanceUniform(target, 0, uniform);
    expect(Array.from(target.subarray(216, 220))).toEqual([0, 0, 0, 0]);
  });
});

describe("in a frame", () => {
  it("unstretches the cliff and leaves flat ground exactly as planar mapping draws it", () => {
    const planar = render(cliffInstances());
    const triplanar = render(cliffInstances({ triplanar: true }));
    // The cliff's face (the frame's upper half) changes a great deal…
    expect(differing(planar, triplanar, 0, H / 2)).toBeGreaterThan(1500);
    // …and the flat grass in the foreground not at all.
    expect(differing(planar, triplanar, H - 24, H)).toBe(0);
  });

  it("height-blends the layers' edge at the cliff's foot", () => {
    const even = render(cliffInstances({ triplanar: true }));
    const sharp = render(cliffInstances({ triplanar: true, sharpness: 0.8 }));
    expect(differing(even, sharp)).toBeGreaterThan(50);
  });
});
