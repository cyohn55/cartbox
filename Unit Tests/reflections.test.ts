/**
 * Screen-space reflections (HALO_INFINITE_STYLE_ROADMAP.md I3), the parts
 * without a GPU: the pass's uniforms, the scene shader's reflection variant,
 * the cap, the quality presets, the overlay asking for them, and Lockout's
 * polished deck. What the pass does to a picture is measured on real GPUs in
 * webgpu-parity.test.ts and webgl-parity.test.ts.
 */

import { describe, expect, it } from "vitest";

import { lockoutMeshSidecar, multiplyMat4, projectionMatrix, type Mat4 } from "@cartbox/editor";
import { MODELS, MeshOverlaySurface, QUALITY_PRESETS, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { SSR_MAX_ROUGHNESS, SSR_UNIFORM_FLOATS, reflectionUniforms } from "../packages/player/src/render/reflections";
import { sceneShader } from "../packages/player/src/render/WebgpuSceneRenderer";

describe("the pass's uniforms", () => {
  it("carry the projection and its inverse, and how depth is stored", () => {
    const projection = projectionMatrix(1, 4 / 3, 0.1, 100);
    const u = reflectionUniforms(projection, "ndc");
    expect(u).toHaveLength(SSR_UNIFORM_FLOATS);
    const product = multiplyMat4(Array.from(u.subarray(0, 16)) as unknown as Mat4, Array.from(u.subarray(16, 32)) as unknown as Mat4);
    product.forEach((v, i) => expect(v).toBeCloseTo(i % 5 === 0 ? 1 : 0, 4));
    expect(u[35]).toBe(0);
    expect(reflectionUniforms(projection, "unit")[35]).toBe(1);
    expect(u[36]).toBeCloseTo(SSR_MAX_ROUGHNESS, 6);
  });
});

describe("the scene shader", () => {
  it("writes the two reflection targets only in its reflection variant", () => {
    const plain = sceneShader();
    const reflecting = sceneShader(null, true);
    expect(plain).not.toContain("reflectOut");
    expect(plain).toContain("fn fs(in: VSOut) -> @location(0) vec4<f32>");
    expect(reflecting).toContain("@location(1) reflect: vec4<f32>");
    expect(reflecting).toContain("@location(2) env: vec4<f32>");
    expect(reflecting).toContain("fn shade(in: VSOut) -> vec4<f32>");
  });
});

describe("the cap, the presets and the overlay", () => {
  it("is on for the Xbox 360 and Modern tiers, and the high and medium presets", () => {
    expect(MODELS.xbox360.renderCaps.reflections).toBe(true);
    expect(MODELS.modern.renderCaps.reflections).toBe(true);
    for (const id of ["classic", "pro", "portrait", "voxel", "ps1", "n64"] as const) expect(MODELS[id].renderCaps.reflections).not.toBe(true);
    expect(QUALITY_PRESETS.high.reflections).toBe(true);
    expect(QUALITY_PRESETS.medium.reflections).toBe(true);
    expect(QUALITY_PRESETS.low.reflections).toBe(false);
  });

  it("asks the renderer for them only when the cap and the quality both allow it", async () => {
    const lockout = JSON.parse(lockoutMeshSidecar());
    const raw = JSON.stringify({ version: 2, meshes: [lockout.meshes[1]], library: lockout.library, lighting: null });
    const drawWith = async (reflections: boolean | undefined, quality: keyof typeof QUALITY_PRESETS) => {
      const seen: SceneDraw[] = [];
      const renderer: SceneRenderer = { backend: "software", render: (_, draw) => void seen.push(draw), dispose: () => {} };
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, parseMeshScene(raw)!, renderer, reflections === undefined ? {} : { reflections });
      surface.setQuality(QUALITY_PRESETS[quality]);
      surface.blit(new Uint8Array(16 * 16 * 4));
      return seen.at(-1)!.reflections;
    };
    expect(await drawWith(true, "high")).toBe(true);
    expect(await drawWith(true, "medium")).toBe(true);
    expect(await drawWith(true, "low")).toBe(false);
    expect(await drawWith(false, "high")).toBe(false);
    expect(await drawWith(undefined, "high")).toBe(false);
  });
});

describe("Lockout", () => {
  it("polishes the deck plates smooth enough to reflect in screen space", () => {
    const map = parseMeshScene(lockoutMeshSidecar())!.instances.find((i) => i.id === "lockout-map")!.mesh;
    const deck = map.primitives.find((p) => p.material.name === "forerunner-deck")!.material;
    // The plates' baked roughness is 0.5; the factor scales it.
    expect(0.5 * (deck.roughnessFactor ?? 1)).toBeLessThan(SSR_MAX_ROUGHNESS * 0.6);
    expect(deck.reflectionMask).toBe(true);
  });
});
