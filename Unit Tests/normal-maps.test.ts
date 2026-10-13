/**
 * Normal maps on the GPU (EDITOR_PRO_ROADMAP.md P1a): the packing, the
 * per-primitive texture the batches bind, the texture-unit budget WebGL2
 * holds the scene shader to, and what a normal map does to a software frame.
 * (The GPU shaders are checked against it by webgl-parity.test.ts and, on a
 * real device, webgpu-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import { composeModelMatrix, projectionMatrix, renderMeshScene, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { UNIFORM_FLOATS, writeInstanceUniform } from "@cartbox/player";

import { batchInstances } from "../packages/player/src/render/gpuFrame";
import { sceneFragmentGlsl } from "../packages/player/src/render/WebglSceneRenderer";
import { NORMAL_ENVIRONMENT, NORMAL_LIGHT, normalMapInstances, panelNormalMap } from "./helpers/normalMapScenes";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

function quad(material: Material = {}, uvs = true): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: uvs ? Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]) : null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

const W = 128;
const H = 96;

function render(instances: MeshSceneInstance[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 0, 4], [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [0, 0, 0, 255],
    lightDirection: NORMAL_LIGHT,
    environment: NORMAL_ENVIRONMENT,
  });
  return out;
}

describe("normal maps on the GPU", () => {
  it("flag the map at byte 896", () => {
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
    writeInstanceUniform(target, 0, { ...uniform, hasNormalMap: true });
    expect(Array.from(target.subarray(224, 228))).toEqual([1, 0, 0, 0]);
    writeInstanceUniform(target, 0, uniform);
    expect(target[224]).toBe(0);
  });

  it("bind a primitive's map, and none for one without UVs (no tangent frame)", () => {
    const map = panelNormalMap();
    const geometry = { indexCount: 6 };
    const batches = (mesh: MeshAsset) =>
      batchInstances([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), normalTextures: [map] }], () => [geometry], [0, 0, 4]).batches;
    expect(batches(quad())[0]!.textures.normal).toBe(map);
    expect(batches(quad({}, false))[0]!.textures.normal).toBeNull();
  });

  it("keep the WebGL2 scene shader within the 16 texture units every device gives", () => {
    for (const reflect of [false, true]) {
      const glsl = sceneFragmentGlsl(false, null, reflect);
      const samplers = glsl.match(/^\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?[iu]?sampler(?:2D|3D|Cube|2DArray)\s+\w+;/gm) ?? [];
      expect(samplers.length, samplers.join("\n")).toBeLessThanOrEqual(16);
      expect(glsl).toContain("uniform sampler2D nrmTex;");
    }
  });
});

describe("normal maps in a frame", () => {
  it("light the panels' bevels, and change nothing without a map", () => {
    const bumpy = render(normalMapInstances(quad));
    const flat = render(normalMapInstances(quad, false));
    let changed = 0;
    for (let i = 0; i < bumpy.length; i += 4) if (Math.abs(bumpy[i]! - flat[i]!) + Math.abs(bumpy[i + 1]! - flat[i + 1]!) > 20) changed += 1;
    expect(changed).toBeGreaterThan(300);
    // A flat map (every texel straight out, +Z) shades exactly as no map does.
    const up = { width: 1, height: 1, data: Uint8ClampedArray.from([128, 128, 255, 255]) };
    const withFlatMap = normalMapInstances(quad, false).map((i) => ({ ...i, normalTextures: [up] }));
    let off = 0;
    const a = render(withFlatMap);
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - flat[i]!) > 2) off += 1;
    expect(off).toBeLessThanOrEqual(5);
  });
});
