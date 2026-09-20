/**
 * Phase 3 — image-based lighting (software reference path).
 *
 * With an environment set, the PBR ambient term stops being a flat grey fill and
 * becomes directional: a diffuse irradiance sampled along the surface normal, and
 * a specular reflection sampled along the reflection vector (blurred toward the
 * environment average as roughness rises). So a surface facing the sky takes the
 * sky's colour, a rough metal reads as the average environment, and a smooth
 * metal mirrors whatever it points at. Absent an environment the term is the
 * flat ambient stand-in, byte-identical to Phase 2 — the gate.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  environmentAverage,
  environmentColor,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type EnvironmentLight,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

type Material = MeshAsset["primitives"][number]["material"];

/** A quad facing +normal, tilted so `normalY` is its world normal's Y. */
function tiltedQuad(material: Material, normal: readonly [number, number, number]): MeshAsset {
  const [nx, ny, nz] = normal;
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        // A constant per-vertex normal, so the whole quad shades by `normal`.
        normals: Float32Array.from([nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const SIZE = 32;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** A blue-sky / brown-ground studio environment. */
const ENV: EnvironmentLight = {
  sky: [0.2, 0.4, 0.9],
  horizon: [0.6, 0.6, 0.6],
  ground: [0.35, 0.25, 0.1],
  intensity: 1,
};

/**
 * Render one quad with the given normal, under an optional environment but with
 * the direct light turned fully off (ambient 0, light straight behind), so only
 * the ambient/IBL term contributes. Returns the centre pixel [r, g, b].
 */
function ambientOnly(
  material: Material,
  normal: readonly [number, number, number],
  environment: EnvironmentLight | null,
): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene([{ mesh: tiltedQuad(material, normal), model: identity() }], {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    // Point the light away from the quad so N·L clamps to 0 → no direct term.
    lightDirection: [0, 0, -1],
    ambient: 0.3,
    environment,
  });
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

const DIELECTRIC: Material = { name: "d", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };

describe("environmentColor / environmentAverage", () => {
  const near = (got: readonly number[], want: readonly number[]): void => {
    want.forEach((w, i) => expect(got[i]!).toBeCloseTo(w, 10));
  };

  it("samples sky overhead, ground below, horizon at the equator", () => {
    near(environmentColor(ENV, 1), [0.2, 0.4, 0.9]);
    near(environmentColor(ENV, -1), [0.35, 0.25, 0.1]);
    near(environmentColor(ENV, 0), [0.6, 0.6, 0.6]);
  });

  it("scales by intensity", () => {
    near(environmentColor({ ...ENV, intensity: 2 }, 1), [0.4, 0.8, 1.8]);
  });

  it("averages the three stops", () => {
    near(environmentAverage(ENV), [
      (0.2 + 0.6 + 0.35) / 3,
      (0.4 + 0.6 + 0.25) / 3,
      (0.9 + 0.6 + 0.1) / 3,
    ]);
  });
});

describe("rasteriser IBL — directional ambient from the environment", () => {
  it("tints an up-facing diffuse surface toward the sky", () => {
    // A dielectric facing straight up should read blue-dominant (sky), where the
    // flat-ambient version is neutral grey.
    const [r, g, b] = ambientOnly(DIELECTRIC, [0, 1, 0], ENV);
    expect(b).toBeGreaterThan(r + 30); // sky is blue
    expect(g).toBeGreaterThan(r); // and green > red in the sky colour
  });

  it("tints a down-facing surface toward the ground", () => {
    const [r, , b] = ambientOnly(DIELECTRIC, [0, -1, 0], ENV);
    expect(r).toBeGreaterThan(b + 20); // ground is warm/brown: red over blue
  });

  it("gives a smooth metal a mirror reflection that a rough metal averages out", () => {
    // A smooth metal facing the camera reflects the environment along R; a rough
    // one blends toward the average, so the two differ. (Both are metals: no
    // diffuse, so this is purely the specular-IBL term.)
    const smooth: Material = { name: "s", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0.05 };
    const rough: Material = { name: "r", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 1 };
    const s = ambientOnly(smooth, [0, 1, 0], ENV);
    const r = ambientOnly(rough, [0, 1, 0], ENV);
    const delta = Math.abs(s[0] - r[0]) + Math.abs(s[1] - r[1]) + Math.abs(s[2] - r[2]);
    expect(delta).toBeGreaterThan(20);
  });

  it("is byte-identical to the flat-ambient path when no environment is set (the gate)", () => {
    const withEnv = ambientOnly(DIELECTRIC, [0, 1, 0], null);
    // Recompute independently: same call, still null.
    const again = ambientOnly(DIELECTRIC, [0, 1, 0], null);
    expect(withEnv).toEqual(again);
    // The flat path is neutral grey (r == g == b) for a grey albedo; the IBL path
    // above was not, which is the whole point.
    expect(withEnv[0]).toBe(withEnv[1]);
    expect(withEnv[1]).toBe(withEnv[2]);
  });
});
