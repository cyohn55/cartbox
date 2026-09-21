/**
 * Phase 6 — the authored lighting rig (pure). Covers the defensive parse, the
 * immutable edits the lighting editor drives, the mappings into the render
 * pipeline's inputs, and directional shadow fitting.
 */

import { describe, expect, it } from "vitest";

import {
  addSceneLight,
  buildSceneShadow,
  composeModelMatrix,
  defaultSceneLighting,
  parseSceneLighting,
  patchSceneLighting,
  removeSceneLight,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  updateSceneEnvironment,
  updateSceneLight,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5];
  return {
    name: "c",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: null,
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

describe("parseSceneLighting", () => {
  it("returns null for absent input", () => {
    expect(parseSceneLighting(null)).toBeNull();
    expect(parseSceneLighting(undefined)).toBeNull();
    expect(parseSceneLighting("nope")).toBeNull();
  });

  it("fills every missing field from the default rig", () => {
    const parsed = parseSceneLighting({});
    expect(parsed).toEqual(defaultSceneLighting());
  });

  it("clamps colours and drops malformed lights", () => {
    const parsed = parseSceneLighting({
      environment: { sky: [2, -1, 0.5], horizon: "bad", intensity: -3 },
      ambient: 5,
      lights: [{ kind: "point", position: [1, 2, 3], color: [1, 1, 1], intensity: 2, range: 8 }, { kind: "spot" }, {}],
    })!;
    expect(parsed.environment.sky).toEqual([1, 0, 0.5]); // clamped 0..1
    expect(parsed.environment.horizon).toEqual(defaultSceneLighting().environment.horizon); // bad → default
    expect(parsed.environment.intensity).toBe(0); // negative → 0
    expect(parsed.ambient).toBe(1); // clamped 0..1
    expect(parsed.lights).toHaveLength(1); // only the valid point light survives
    expect(parsed.lights[0]!.kind).toBe("point");
  });
});

describe("scene lighting edits", () => {
  it("patches scalars, environment, and lights immutably", () => {
    const base = defaultSceneLighting();
    const lit = patchSceneLighting(base, { ambient: 0.1, tonemap: true, exposure: 2 });
    expect(lit.ambient).toBe(0.1);
    expect(base.ambient).toBe(0.35); // original untouched

    const env = updateSceneEnvironment(lit, { intensity: 1.5 });
    expect(env.environment.intensity).toBe(1.5);

    const added = addSceneLight(env, { kind: "point", position: [0, 1, 0], color: [1, 0, 0], intensity: 3, range: 5 });
    expect(added.lights).toHaveLength(2);

    const updated = updateSceneLight(added, 1, { intensity: 4 });
    expect(updated.lights[1]!.intensity).toBe(4);
    expect(updateSceneLight(added, 9, { intensity: 4 })).toBe(added); // out of range no-op

    const removed = removeSceneLight(updated, 0);
    expect(removed.lights).toHaveLength(1);
    expect(removed.lights[0]!.kind).toBe("point");
  });
});

describe("render-input mappings", () => {
  it("maps environment, tonemap, and key direction", () => {
    const lit = defaultSceneLighting();
    const env = sceneLightingEnvironment(lit);
    expect(env.sky).toEqual(lit.environment.sky);
    expect(env.intensity).toBe(lit.environment.intensity);

    expect(sceneLightingTonemap(lit)).toBeNull(); // off by default
    expect(sceneLightingTonemap(patchSceneLighting(lit, { tonemap: true, exposure: 1.5 }))).toEqual({ exposure: 1.5 });

    expect(sceneLightingKeyDirection(lit)).toEqual([0.4, 0.8, 0.6]);
    expect(sceneLightingKeyDirection(removeSceneLight(lit, 0))).toBeUndefined();
  });
});

describe("buildSceneShadow", () => {
  const instances: MeshSceneInstance[] = [{ mesh: cube(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }];

  it("returns null when shadows are off or there is no directional light", () => {
    const off = defaultSceneLighting();
    expect(buildSceneShadow(instances, off, [0, 0, 0], 1, { size: 64, depth: new Float32Array(64 * 64) })).toBeNull();

    const noKey = patchSceneLighting(removeSceneLight(off, 0), { shadows: true });
    expect(buildSceneShadow(instances, noKey, [0, 0, 0], 1, { size: 64, depth: new Float32Array(64 * 64) })).toBeNull();
  });

  it("renders a depth map when shadows are on with a directional light", () => {
    const lit = patchSceneLighting(defaultSceneLighting(), { shadows: true });
    const depth = new Float32Array(64 * 64);
    const shadow = buildSceneShadow(instances, lit, [0, 0, 0], 1, { size: 64, depth });
    expect(shadow).not.toBeNull();
    expect(shadow!.size).toBe(64);
    // Something was rasterised into the map: at least one finite depth.
    expect(depth.some((d) => Number.isFinite(d))).toBe(true);
  });
});
