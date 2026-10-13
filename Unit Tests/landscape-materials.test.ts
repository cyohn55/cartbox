/**
 * Landscape materials (EDITOR_PRO_ROADMAP.md P2b): a terrain layer chosen by
 * the ground's curvature, macro variation and distance tiling on a material —
 * the stored form, the packing, and what each does to a software frame. (The
 * GPU shaders are checked against it by webgl-parity.test.ts and, on a real
 * device, webgpu-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  deserializeMeshAsset,
  farTileBlend,
  macroGain,
  macroUniform,
  newTerrain,
  readTerrain,
  serializeMeshAsset,
  serializeTerrain,
  terrainCurvature,
  terrainLayerWeights,
  terrainMesh,
  viewMatrix,
  type MeshAsset,
  type Terrain,
} from "@cartbox/editor";
import { UNIFORM_FLOATS, resolveMapping, writeInstanceUniform } from "@cartbox/player";

import { SoftwareSceneRenderer, type SceneDraw } from "../packages/player/src/render/sceneRenderer";
import { CLIFF_EYE, CLIFF_TARGET, cliffInstances } from "./helpers/terrainScenes";

/** A 17-sample terrain (hard layer edges) with a gully (a valley along Z) and a ridge beside it. */
function gullyTerrain(): Terrain {
  const t = newTerrain("g", { size: 16, samples: 17 });
  const heights = new Float32Array(17 * 17);
  for (let j = 0; j < 17; j += 1) for (let i = 0; i < 17; i += 1) heights[j * 17 + i] = 0.08 * (i - 5) ** 2 * (i < 9 ? 1 : 0) + (i >= 9 ? 1.28 - 0.08 * (i - 12) ** 2 : 0);
  // Hard layer edges unless a test asks for blending.
  const { blend: _blend, ...rest } = t;
  void _blend;
  return {
    ...rest,
    heights,
    layers: [
      { material: { name: "sand", baseColorFactor: [0.9, 0.8, 0.5, 1], baseColorImage: null }, curvature: [0.02, 1000] },
      { material: { name: "rock", baseColorFactor: [0.4, 0.4, 0.4, 1], baseColorImage: null }, curvature: [-1000, -0.02] },
      { material: { name: "grass", baseColorFactor: [0.3, 0.5, 0.2, 1], baseColorImage: null } },
    ],
  };
}

describe("landscape materials", () => {
  it("measure curvature: positive in a hollow, negative on a crest, zero on a plane however steep", () => {
    const g = gullyTerrain();
    expect(terrainCurvature(g, 5, 8)).toBeGreaterThan(0.02); // the gully's floor
    expect(terrainCurvature(g, 12, 8)).toBeLessThan(-0.02); // the ridge's crest
    const slope = { ...newTerrain("s", { size: 16, samples: 17 }), heights: Float32Array.from({ length: 17 * 17 }, (_, k) => (k % 17) * 0.9) };
    expect(terrainCurvature(slope, 8, 8)).toBeCloseTo(0, 6);
  });

  it("pick a layer by curvature, softly when blending, and keep the rule through storage", () => {
    const g = gullyTerrain();
    expect(terrainLayerWeights(g, 1, 0, 0, 0.1)).toEqual([1, 0, 0]);
    expect(terrainLayerWeights(g, 1, 0, 0, -0.1)).toEqual([0, 1, 0]);
    expect(terrainLayerWeights(g, 1, 0, 0, 0)).toEqual([0, 0, 1]);
    // Hard-edged geometry: the gully floor's triangles go to sand, the crest's to rock.
    const names = terrainMesh(g).primitives.map((p) => p.material.name);
    expect(names).toEqual(expect.arrayContaining(["sand", "rock"]));
    // Blending softens the bound over CURVATURE_BLEND either side.
    const soft = terrainLayerWeights({ ...g, blend: { up: 0.1, height: 1 } }, 1, 0, 0, 0.02);
    expect(soft[0]).toBeGreaterThan(0.2);
    expect(soft[0]).toBeLessThan(0.8);
    expect(readTerrain(serializeTerrain(g))!.layers.map((l) => l.curvature)).toEqual([[0.02, 1000], [-1000, -0.02], undefined]);
  });

  it("store macro variation and distance tiling with the material, clamped", () => {
    const mesh: MeshAsset = {
      name: "m",
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: Uint32Array.from([0, 1, 2]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, macro: { scale: 30, strength: 3 }, farTile: 120 },
        },
      ],
    };
    const back = deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material;
    expect(back.macro).toEqual({ scale: 30, strength: 1 });
    expect(back.farTile).toBe(120);
  });

  it("pack macro variation in terrain0.zw and the tiling distance in maps0.y", () => {
    const mapping = resolveMapping({ macro: { scale: 4, strength: 0.3 }, farTile: 50 });
    expect(mapping).toEqual({ triplanar: 0, blendSharpness: 0, macro: [0.3, 0.25], farTile: 50 });
    expect(resolveMapping({})).toBeNull();
    const target = new Float32Array(UNIFORM_FLOATS).fill(-7);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    writeInstanceUniform(target, 0, {
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
      mapping,
    });
    expect(Array.from(target.subarray(216, 220))).toEqual([0, 0, Math.fround(0.3), 0.25]);
    expect(Array.from(target.subarray(224, 228))).toEqual([0, 50, 0, 0]);
  });

  it("vary the colour by at most the strength, and blend the far tiling in between a quarter of the distance and it", () => {
    expect(macroUniform({})).toEqual([0, 0]);
    for (let k = 0; k < 200; k += 1) {
      const gain = macroGain(0.3, 0.1, k * 1.7, 0, k * 0.9);
      expect(gain).toBeGreaterThanOrEqual(0.7 - 1e-9);
      expect(gain).toBeLessThanOrEqual(1.3 + 1e-9);
    }
    expect(macroGain(0, 1, 3, 4, 5)).toBe(1);
    expect(farTileBlend(10, 100)).toBe(0);
    expect(farTileBlend(25, 100)).toBe(0);
    expect(farTileBlend(62.5, 100)).toBeCloseTo(0.5, 6);
    expect(farTileBlend(100, 100)).toBe(1);
    expect(farTileBlend(500, 0)).toBe(0);
  });

  it("change a software frame of the cliff, in broad patches", () => {
    const frame = (landscape: boolean) => {
      const out = new Uint8ClampedArray(160 * 120 * 4);
      const draw: SceneDraw = {
        width: 160,
        height: 120,
        out,
        depth: new Float32Array(160 * 120),
        view: viewMatrix(CLIFF_EYE, CLIFF_TARGET),
        projection: [1.2, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2002, 0],
        background: [20, 20, 30, 255],
        lightDirection: [0.3, 0.8, -0.5],
      } as SceneDraw;
      new SoftwareSceneRenderer().render(cliffInstances({ triplanar: true, sharpness: 0.8, landscape }), draw);
      return out;
    };
    const plain = frame(false);
    const varied = frame(true);
    let changed = 0;
    for (let i = 0; i < plain.length; i += 4) if (Math.abs(plain[i]! - varied[i]!) > 6) changed += 1;
    expect(changed).toBeGreaterThan(500);
  });
});
