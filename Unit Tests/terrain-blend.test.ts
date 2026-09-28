/**
 * Terrain blending and shadows (HALO2_STYLE_ROADMAP.md, H4): layers blending
 * per vertex across a soft band instead of per triangle, the blend surface in
 * the renderers and its stored form, terrain casting into the play space's
 * shadow map, and Lockout's use of both.
 */

import { describe, expect, it } from "vitest";

import {
  buildSceneShadow,
  composeModelMatrix,
  defaultSceneLighting,
  deserializeMeshAsset,
  lockoutMeshSidecar,
  lockoutTerrain,
  projectionMatrix,
  readTerrain,
  renderMeshScene,
  serializeMeshAsset,
  serializeTerrain,
  terrainLayerWeights,
  terrainMesh,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshMaterial,
  type Terrain,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { UNIFORM_FLOATS, resolveSurface, writeInstanceUniform } from "../packages/player/src/render/scenePacking";

const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const SNOW: MeshMaterial = { name: "snow", baseColorFactor: [0.9, 0.9, 0.95, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 };
const ROCK: MeshMaterial = { name: "rock", baseColorFactor: [0.2, 0.2, 0.22, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };

/** A ramp: flat on the left, steepening to the right, so snow gives way to rock along X. */
function ramp(blend?: Terrain["blend"]): Terrain {
  const n = 33;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights[j * n + i] = Math.pow(Math.max(0, i - 8) / 24, 2) * 30;
  return {
    id: "ramp",
    name: "Ramp",
    origin: [-16, 0, -16],
    size: [32, 32],
    samples: n,
    heights,
    layers: [{ material: SNOW, up: [0.7, 1] }, { material: ROCK }],
    ...(blend ? { blend } : {}),
  };
}

describe("layer weights", () => {
  it("are hard without a blend band, and soft across it", () => {
    const hard = ramp();
    expect(terrainLayerWeights(hard, 0.75, 0)).toEqual([1, 0]);
    expect(terrainLayerWeights(hard, 0.65, 0)).toEqual([0, 1]);
    const soft = ramp({ up: 0.2, height: 0 });
    const [s, r] = terrainLayerWeights(soft, 0.7, 0);
    expect(s).toBeCloseTo(0.5, 6); // on the edge: half and half
    expect(s! + r!).toBeCloseTo(1, 9);
    expect(terrainLayerWeights(soft, 0.95, 0)[0]).toBe(1);
    expect(terrainLayerWeights(soft, 0.5, 0)[0]).toBe(0);
  });

  it("let noise wander the edge", () => {
    const soft = ramp({ up: 0.2, height: 0, noise: 1 });
    expect(terrainLayerWeights(soft, 0.7, 0, 1)[0]).toBeGreaterThan(terrainLayerWeights(soft, 0.7, 0, -1)[0]!);
  });
});

describe("blended terrain mesh", () => {
  it("keeps hard per-triangle layers when blend is off", () => {
    const mesh = terrainMesh(ramp());
    expect(mesh.primitives.map((p) => p.material.name)).toEqual(["snow", "rock"]);
    expect(mesh.primitives.every((p) => !p.blend)).toBe(true);
  });

  it("puts the band where layers meet into blended primitives with per-vertex weights", () => {
    const mesh = terrainMesh(ramp({ up: 0.2, height: 0 }));
    const blended = mesh.primitives.filter((p) => p.blend);
    expect(blended.length).toBeGreaterThan(0);
    for (const p of blended) {
      expect(p.blend!.length).toBe(p.positions.length / 3);
      expect(p.blend!.every((w) => w >= 0 && w <= 1)).toBe(true);
      // The blend surface is the other layer's.
      const other = p.material.name.startsWith("snow") ? ROCK : SNOW;
      expect(p.material.blendColor).toEqual(other.baseColorFactor.slice(0, 3));
      expect(p.material.blendRoughness).toBe(other.roughnessFactor);
    }
    // The same triangles, just regrouped.
    const tris = (m: MeshAsset) => m.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(tris(mesh)).toBe(tris(terrainMesh(ramp())));
  });

  it("stores the blend band and shadow casting with the terrain", () => {
    const t = { ...ramp({ up: 0.2, height: 1.5, noise: 0.5 }), castShadows: true };
    const back = readTerrain(JSON.parse(JSON.stringify(serializeTerrain(t))))!;
    expect(back.blend).toEqual({ up: 0.2, height: 1.5, noise: 0.5 });
    expect(back.castShadows).toBe(true);
    const plain = readTerrain(JSON.parse(JSON.stringify(serializeTerrain(ramp()))))!;
    expect(plain.blend).toBeUndefined();
    expect(plain.castShadows).toBeUndefined();
  });

  it("round-trips a blended primitive through the mesh format", () => {
    const mesh = terrainMesh(ramp({ up: 0.2, height: 0 }));
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    back.primitives.forEach((p, i) => {
      const src = mesh.primitives[i]!;
      if (src.blend) expect(Array.from(p.blend!)).toEqual(Array.from(src.blend));
      else expect(p.blend).toBeUndefined();
      expect(p.material.blendColor).toEqual(src.material.blendColor);
    });
  });
});

describe("rasteriser blend surface", () => {
  const SIZE = 16;
  const quad = (weight: number, tex = false): MeshAsset => ({
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        blend: Float32Array.from([weight, weight, weight, weight]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { ...ROCK, blendColor: tex ? [1, 1, 1] : [0.9, 0.9, 0.95], blendRoughness: 0.8, blendImage: tex ? { mime: "image/png", bytes: new Uint8Array(1) } : null },
      },
    ],
  });
  const centre = (mesh: MeshAsset, blendTex?: DecodedTexture) => {
    const out = new Uint8ClampedArray(SIZE * SIZE * 4);
    renderMeshScene([{ mesh, model: IDENTITY, ...(blendTex ? { blendTextures: [blendTex] } : {}) }], {
      width: SIZE,
      height: SIZE,
      out,
      depth: new Float32Array(SIZE * SIZE),
      view: viewMatrix([0, 0, 2.5], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      lightDirection: [0, 0, 1],
      ambient: 0.3,
    });
    const o = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
    return out[o]!;
  };

  it("mixes the albedo toward the blend surface by the vertex weight", () => {
    const rock = centre(quad(0));
    const half = centre(quad(0.5));
    const snow = centre(quad(1));
    expect(snow).toBeGreaterThan(rock + 100);
    expect(half).toBeGreaterThan(rock + 30);
    expect(half).toBeLessThan(snow - 30);
  });

  it("samples the blend surface's texture when it has one", () => {
    const red: DecodedTexture = { width: 1, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255]) };
    const black: DecodedTexture = { width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255]) };
    expect(centre(quad(1, true), red)).toBeGreaterThan(centre(quad(1, true), black) + 100);
  });

  it("packs the blend surface into the uniforms (surface1.zw, surface3)", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    const material = quad(1).primitives[0]!.material;
    writeInstanceUniform(data, 0, {
      mvp: IDENTITY,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1],
      hasTexture: false,
      light: { direction: [0, 1, 0], ambient: 0.3 },
      viewDir: [0, 0, 1],
      pbr: { metallic: 0, roughness: 1, isPbr: true, emissive: [0, 0, 0] },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: IDENTITY,
      lightCount: 0,
      surface: resolveSurface(material, 0, false, false, { weights: true, textured: false }),
    });
    expect(Array.from(data.subarray(512 / 4 + 2, 512 / 4 + 4))).toEqual([1, 0]);
    expect(Array.from(data.subarray(544 / 4, 560 / 4)).map((v) => +v.toFixed(3))).toEqual([0.9, 0.9, 0.95, 0.8]);
    expect(resolveSurface(material, 0, false, false).blend).toBeNull(); // no weights: no blend
  });
});

describe("terrain shadows", () => {
  it("backs the light off by `reach` so distant casters stay in front of it", () => {
    const lighting = { ...defaultSceneLighting(), shadows: true };
    const near = buildSceneShadow([], lighting, [0, 0, 0], 10, { size: 8, depth: new Float32Array(64) })!;
    const far = buildSceneShadow([], lighting, [0, 0, 0], 10, { size: 8, depth: new Float32Array(64), reach: 100 })!;
    expect(near.lightViewProj).not.toEqual(far.lightViewProj);
  });

  it("flags a casting terrain's blocks, and only then", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const blocks = scene.instances.filter((i) => i.terrain);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.casts === true)).toBe(true);
    expect(scene.instances.filter((i) => !i.terrain).some((i) => i.casts)).toBe(false);
  });
});

describe("Lockout", () => {
  it("blends snow into rock with a wandering edge, and lets the gorge walls cast", () => {
    const t = lockoutTerrain();
    expect(t.blend?.up).toBeGreaterThan(0);
    expect(t.blend?.noise).toBeGreaterThan(0);
    expect(t.castShadows).toBe(true);
    expect(terrainMesh(t).primitives.some((p) => p.blend)).toBe(true);
  });
});
