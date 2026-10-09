/**
 * The light and colour pass (HALO_INFINITE_STYLE_ROADMAP.md I8): a rig's own
 * team colours, the "Infinite daylight" preset, and Lockout re-lit for bright
 * noon on snow. (The grading LUT has its own tests: grading-lut.test.ts and
 * postfx-lut-webgl.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  INFINITE_TINTS,
  LOCKOUT_FX,
  LOCKOUT_LIGHTING,
  MAX_SCENE_TINTS,
  defaultSceneLighting,
  infiniteDaylightLighting,
  lockoutMeshSidecar,
  parseSceneLighting,
  type MeshAsset,
} from "@cartbox/editor";
import { TINT_PALETTE, parseMeshScene, parsePostFxSettings, uniformsFromSettings } from "@cartbox/player";
import { tintMesh } from "../packages/player/src/mesh/MeshOverlaySurface";

const saturation = (c: readonly number[]) => Math.max(...c) - Math.min(...c);
const elevation = (d: readonly number[]) => (Math.asin(d[1]! / Math.hypot(d[0]!, d[1]!, d[2]!)) * 180) / Math.PI;

describe("a rig's team colours", () => {
  it("are read clamped, nulls kept in place, at most sixteen, and dropped when none is set", () => {
    const read = parseSceneLighting({ ...defaultSceneLighting(), tints: [null, [2, -1, 0.5], "red", null, [0.1, 0.2, 0.3]] })!;
    expect(read.tints).toEqual([null, [1, 0, 0.5], null, null, [0.1, 0.2, 0.3]]);
    expect(parseSceneLighting({ ...defaultSceneLighting(), tints: Array.from({ length: 30 }, () => [0.5, 0.5, 0.5]) })!.tints).toHaveLength(MAX_SCENE_TINTS);
    expect(parseSceneLighting({ ...defaultSceneLighting(), tints: [null, null] })!.tints).toBeUndefined();
    expect(parseSceneLighting(defaultSceneLighting())!.tints).toBeUndefined();
  });

  it("recolour armour in place of the built-in palette, entry by entry", () => {
    const mesh: MeshAsset = {
      name: "m",
      primitives: [
        { positions: new Float32Array(9), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "paint", baseColorFactor: [1, 1, 1, 0.5], baseColorImage: null, tintable: true } },
        { positions: new Float32Array(9), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "visor", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null } },
      ],
    };
    const overrides = [null, [0.9, 0, 0]] as const;
    expect(tintMesh(mesh, 1, overrides).primitives[0]!.material.baseColorFactor).toEqual([0.9, 0, 0, 0.5]);
    expect(tintMesh(mesh, 2, overrides).primitives[0]!.material.baseColorFactor).toEqual([...TINT_PALETTE[2]!, 0.5]);
    expect(tintMesh(mesh, 1, overrides).primitives[1]!.material).toBe(mesh.primitives[1]!.material);
  });

  it("saturate every hue past the built-in palette's", () => {
    expect(INFINITE_TINTS).toHaveLength(TINT_PALETTE.length);
    for (const k of [1, 2, 3, 4, 5, 6, 8, 12]) expect(saturation(INFINITE_TINTS[k]!), String(k)).toBeGreaterThan(saturation(TINT_PALETTE[k]!));
  });
});

describe("the Infinite daylight preset", () => {
  const rig = infiniteDaylightLighting();

  it("is a warm, strong high sun over a bright blue sky fill, tone-mapped and shadowed", () => {
    const [sun, fill] = rig.lights;
    expect(sun!.kind).toBe("directional");
    expect(sun!.intensity).toBeGreaterThanOrEqual(2.5);
    expect(sun!.color[0]).toBeGreaterThan(sun!.color[2]); // warm
    expect(elevation((sun as { direction: number[] }).direction)).toBeGreaterThan(45);
    expect(fill!.color[2]).toBeGreaterThan(fill!.color[0]); // cool sky fill
    expect(rig.environment.sky[2]).toBeGreaterThan(rig.environment.sky[0]);
    expect(rig.tonemap && rig.shadows).toBe(true);
    // The dome's sun is the key light's.
    expect(rig.sky!.sunDirection).toEqual((sun as { direction: number[] }).direction);
    expect(rig.tints).toBe(INFINITE_TINTS);
  });

  it("survives a save and load", () => {
    expect(parseSceneLighting(JSON.parse(JSON.stringify(rig)))!.tints).toEqual(INFINITE_TINTS);
  });
});

describe("Lockout, re-lit", () => {
  it("is bright noon: a strong warm sun high overhead, the dome's sun the same", () => {
    const sun = LOCKOUT_LIGHTING.lights[0]! as { direction: [number, number, number]; color: [number, number, number]; intensity: number };
    expect(elevation(sun.direction)).toBeGreaterThan(45);
    expect(sun.intensity).toBeGreaterThanOrEqual(3);
    expect(sun.color[0] - sun.color[2]).toBeGreaterThan(0.2);
    expect(LOCKOUT_LIGHTING.sky!.sunDirection).toEqual(sun.direction);
    // A clear blue noon sky.
    const z = LOCKOUT_LIGHTING.sky!.zenith;
    expect(z[2] - z[0]).toBeGreaterThan(0.4);
  });

  it("wears saturated team colours, and they reach the loaded scene", () => {
    expect(LOCKOUT_LIGHTING.tints).toBe(INFINITE_TINTS);
    expect(parseMeshScene(lockoutMeshSidecar())!.lighting!.tints).toEqual(INFINITE_TINTS);
  });

  it("grades through the Infinite LUT", () => {
    const fx = parsePostFxSettings(LOCKOUT_FX)!;
    expect(fx.enabled.lut).toBe(true);
    const u = uniformsFromSettings(fx);
    expect(u.lutStrength).toBeGreaterThan(0.5);
    expect(u.lut).not.toBeNull();
    expect(fx.values["lut.look"]).toBe(0);
  });
});
