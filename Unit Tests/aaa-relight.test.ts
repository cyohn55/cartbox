/**
 * A rig's physical re-light on the AAA tier (AAA_FIDELITY_ROADMAP.md F11a-10):
 * the keys it changes, merged over the rig wherever the frame is linear light,
 * so a map keeps the look it was tuned for on every other tier.
 */

import { describe, expect, it } from "vitest";

import { aaaLighting, aaaRelightKeys, defaultProceduralSky, defaultSceneLighting, parseSceneLighting, type MeshAsset, type SceneLighting } from "@cartbox/editor";
import { MeshOverlaySurface, type SceneRenderer } from "@cartbox/player";

const rig = (): SceneLighting => ({
  ...defaultSceneLighting(),
  exposure: 1.1,
  fog: { color: [0.7, 0.8, 0.9], density: 0.01, start: 10, max: 0.3 },
  aaa: { exposure: 1, fog: null, dynamicGi: {} },
});

describe("the re-light", () => {
  it("keeps the keys it names, read as the rig reads them, and removes only optional parts", () => {
    const parsed = parseSceneLighting({ ...defaultSceneLighting(), aaa: { exposure: 2, ambient: 7, fog: null, lights: null, shafts: { strength: 0.5, length: 0.5 }, bogus: 3, aaa: { exposure: 9 } } })!;
    // Clamped as the rig's own; lights can't be removed; unknown keys and a nested re-light are dropped.
    expect(parsed.aaa).toEqual({ exposure: 2, ambient: 1, fog: null, shafts: { strength: 0.5, length: 0.5 } });
    expect(parseSceneLighting({ ...defaultSceneLighting(), aaa: {} })!.aaa).toBeUndefined();
    expect(parseSceneLighting({ ...defaultSceneLighting(), aaa: [1] })!.aaa).toBeUndefined();
  });

  it("derives a physical re-light from the rig at load, which its other keys then patch", () => {
    const lighting = parseSceneLighting({
      ...defaultSceneLighting(),
      sky: defaultProceduralSky(),
      aaa: { physical: { atmosphere: { altitude: 500, bogus: 1 }, volumetric: { anisotropy: 0.5 } }, exposure: 0.8 },
    })!;
    // Read defensively: the atmosphere's unknown keys dropped, a landscape added only when the re-light derives.
    expect(lighting.aaa).toEqual({ physical: { atmosphere: { altitude: 500 }, volumetric: { anisotropy: 0.5 } }, exposure: 0.8 });
    const relit = aaaLighting(lighting);
    expect(relit.exposure).toBe(0.8);
    expect(relit.sky?.atmosphere).toEqual({ altitude: 500, landscape: true });
    expect(relit.dynamicGi).toBeTruthy();
    expect(aaaRelightKeys(lighting)).toEqual(expect.arrayContaining(["lights", "sky", "exposure", "dynamicGi", "lightProbes"]));
    // A rig without a key light or a sky can't be re-lit physically: the other keys still apply.
    const bare = { ...lighting, sky: null, lights: [] } as SceneLighting;
    expect(aaaLighting(bare).exposure).toBe(0.8);
    expect(aaaLighting(bare).dynamicGi).toBeUndefined();
  });

  it("survives a save", () => {
    const stored = JSON.parse(JSON.stringify(rig()));
    expect(parseSceneLighting(stored)!.aaa).toEqual({ exposure: 1, fog: null, dynamicGi: parseSceneLighting({ ...stored, dynamicGi: {} })!.dynamicGi });
  });

  it("merges over the rig on the AAA tier: replaced, removed, and the same object each time", () => {
    const lighting = parseSceneLighting(rig())!;
    const relit = aaaLighting(lighting);
    expect(relit.exposure).toBe(1);
    expect("fog" in relit).toBe(false);
    expect(relit.dynamicGi).toBeTruthy();
    expect(relit.aaa).toBeUndefined();
    expect(relit.lights).toBe(lighting.lights);
    expect(aaaLighting(lighting)).toBe(relit);
    // Without one, the rig as it is.
    const plain = defaultSceneLighting();
    expect(aaaLighting(plain)).toBe(plain);
  });
});

/** A floor 6 m square facing up. */
const FLOOR = {
  name: "floor",
  primitives: [
    {
      positions: Float32Array.from([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]),
      normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: null,
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      material: { name: "m", baseColorImage: null, baseColorFactor: [0.6, 0.6, 0.6, 1] },
    },
  ],
} as unknown as MeshAsset;

describe("the player", () => {
  const scene = (lighting: SceneLighting) =>
    ({ instances: [{ mesh: FLOOR, model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], bounds: { min: [-3, 0, -3], max: [3, 1, 3], center: [0, 0.5, 0], radius: 4.5 }, lighting }) as never;
  const lit = (surface: MeshOverlaySurface) => (surface as unknown as { scene: { lighting: SceneLighting } }).scene.lighting;

  it("lights the AAA renderer by the re-light, and every other by the rig as authored", async () => {
    const lighting = parseSceneLighting(rig())!;
    const aaa = { backend: "webgpu", sunCascades: true, render: () => {}, dispose: () => {} } as unknown as SceneRenderer;
    const other = { backend: "webgpu", render: () => {}, dispose: () => {} } as unknown as SceneRenderer;
    const inner = { blit() {}, destroy() {} };
    const onAaa = await MeshOverlaySurface.create(inner, 32, 24, scene(lighting), aaa);
    const elsewhere = await MeshOverlaySurface.create(inner, 32, 24, scene(lighting), other);
    expect(lit(onAaa).exposure).toBe(1);
    expect(lit(onAaa).fog).toBeUndefined();
    expect(lit(elsewhere).exposure).toBe(1.1);
    expect(lit(elsewhere).fog).toBeTruthy();
    // An edit from the editor is re-lit the same way.
    expect(await onAaa.applySceneEdits(scene({ ...lighting, aaa: { exposure: 0.5 } }))).toBe(true);
    expect(lit(onAaa).exposure).toBe(0.5);
    expect(lit(onAaa).fog).toBeTruthy();
  });
});
