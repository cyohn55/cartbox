/**
 * Physical lights (AAA_FIDELITY_ROADMAP.md F2e-1): a light's colour
 * temperature in kelvin, and lighting channels that say which lights light
 * which objects — in the model, the software rasteriser, the GPU packing and
 * batching, and a save.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  defaultSceneLighting,
  lightChannelMask,
  lightColor,
  lightsChannel,
  lightsOnChannels,
  parseSceneLighting,
  planckianXy,
  projectionMatrix,
  renderMeshScene,
  temperatureTint,
  tintToTemperature,
  viewMatrix,
  MAX_LIGHT_TEMPERATURE,
  MIN_LIGHT_TEMPERATURE,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLight,
} from "@cartbox/editor";
import { LIGHT_FLOATS, packLights } from "@cartbox/player";

import { batchInstances } from "../packages/player/src/render/gpuFrame";
import { bounceLightsFor, withCartSun } from "../packages/player/src/mesh/dynamicLights";

const luminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

describe("colour temperature", () => {
  it("follows the Planckian locus", () => {
    // CIE illuminant A, (0.4476, 0.4074): 2856 K under the old second radiation constant, 2848 K under today's;
    // and the black body near D65 (6500 K).
    const [ax, ay] = planckianXy(2848);
    expect(ax).toBeCloseTo(0.4476, 3);
    expect(ay).toBeCloseTo(0.4074, 3);
    const [wx, wy] = planckianXy(6500);
    expect(wx).toBeCloseTo(0.3135, 3);
    expect(wy).toBeCloseTo(0.3236, 3);
  });

  it("is white at 6500 K, warm below and cool above, always at unit luminance", () => {
    const white = temperatureTint(6500);
    for (const c of white) expect(c).toBeCloseTo(1, 10);
    const warm = temperatureTint(2700);
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
    const cool = temperatureTint(10000);
    expect(cool[2]).toBeGreaterThan(cool[1]);
    expect(cool[1]).toBeGreaterThan(cool[0]);
    for (const k of [1667, 1900, 2700, 4000, 5500, 8000, 12000, 25000]) expect(luminance(temperatureTint(k))).toBeCloseTo(1, 10);
    // Outside the fit it holds to the fit's ends.
    expect(temperatureTint(500)).toEqual(temperatureTint(MIN_LIGHT_TEMPERATURE));
    expect(temperatureTint(90000)).toEqual(temperatureTint(MAX_LIGHT_TEMPERATURE));
  });

  it("tints an authored colour in linear light, so the linear renderer gets the tint exactly", () => {
    const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const color: [number, number, number] = [0.8, 0.6, 0.4];
    const tinted = tintToTemperature(color, 3200);
    const tint = temperatureTint(3200);
    for (let k = 0; k < 3; k += 1) expect(decode(tinted[k]!)).toBeCloseTo(decode(color[k]!) * tint[k]!, 6);
    // A warm light's red can rise past 1, and a light without a temperature keeps its colour as it is.
    expect(tintToTemperature([1, 1, 1], 2000)[0]).toBeGreaterThan(1);
    const plain: SceneLight = { kind: "point", position: [0, 0, 0], color: [0.3, 0.2, 0.1], intensity: 1 };
    expect(lightColor(plain)).toBe(plain.color);
  });

  it("packs the tinted colour for the GPU loops", () => {
    const light: SceneLight = { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 2, range: 4, temperature: 2700 };
    const packed = packLights([light]);
    const tinted = lightColor(light);
    for (let k = 0; k < 3; k += 1) expect(packed[4 + k]).toBeCloseTo(tinted[k]!, 5);
    expect(packed[7]).toBe(2);
  });
});

describe("lighting channels", () => {
  it("lights an object when their masks share a channel, the first for both by default", () => {
    const light = (channels?: number): SceneLight => ({ kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1, ...(channels !== undefined ? { channels } : {}) });
    expect(lightsChannel(light(), undefined)).toBe(true);
    expect(lightsChannel(light(2), undefined)).toBe(false);
    expect(lightsChannel(light(2), 6)).toBe(true);
    expect(lightsChannel(light(), 6)).toBe(false);
    expect(lightsChannel(light(0), 255)).toBe(false);
    const all = [light(), light(1)];
    expect(lightsOnChannels(all, 1)).toBe(all);
    expect(lightsOnChannels([light(), light(4)], 4)).toHaveLength(1);
    expect(lightChannelMask(3.2)).toBe(3);
    expect(lightChannelMask(0x1ff)).toBe(0xff);
    expect(lightChannelMask("x")).toBe(1);
  });

  it("packs a light's channels above its falloff bit", () => {
    const packed = packLights([
      { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, channels: 5 },
      { kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1, range: 3, falloff: "inverseSquare", channels: 2 },
    ]);
    expect(packed[LIGHT_FLOATS - 1]).toBe(10);
    expect(packed[2 * LIGHT_FLOATS - 1]).toBe(5);
  });

  it("splits a primitive's copies into one batch a channel mask", () => {
    const mesh = floor();
    const geometry = { indexCount: 6 };
    const at = (x: number, lightChannels?: number): MeshSceneInstance => ({ mesh, model: composeModelMatrix([x, 0, 0], [0, 0, 0], [1, 1, 1]), ...(lightChannels !== undefined ? { lightChannels } : {}) });
    const { batches } = batchInstances([at(0), at(1, 2), at(2), at(3, 2), at(4, 1)], () => [geometry]);
    expect(batches.map((b) => [b.channels, b.models.length])).toEqual([
      [1, 3],
      [2, 2],
    ]);
  });

  it("darkens in the software rasteriser what no light's channel reaches, and leaves the ambient", () => {
    const W = 48;
    const H = 32;
    const shade = (lightChannels: number | undefined, lights: readonly SceneLight[]) => {
      const out = new Uint8ClampedArray(W * H * 4);
      renderMeshScene([{ mesh: floor(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), ...(lightChannels !== undefined ? { lightChannels } : {}) }], {
        width: W,
        height: H,
        out,
        depth: new Float32Array(W * H),
        view: viewMatrix([0, 3, 3], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, W / H, 0.1, 50),
        ambient: 0.2,
        lights,
      });
      const i = ((H >> 1) * W + (W >> 1)) * 4;
      return [out[i]!, out[i + 1]!, out[i + 2]!];
    };
    const sun: SceneLight = { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, channels: 2 };
    const lit = shade(2, [sun]);
    const unlit = shade(undefined, [sun]);
    const ambientOnly = shade(undefined, [{ ...sun, intensity: 0 }]);
    expect(lit[1]).toBeGreaterThan(unlit[1]! + 20);
    expect(unlit).toEqual(ambientOnly);
    // A warm light shades warm.
    const warm = shade(undefined, [{ kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, temperature: 2700 }]);
    expect(warm[0]).toBeGreaterThan(warm[2]! + 20);
  });
});

describe("in the rig", () => {
  it("keeps a light's temperature and channels through a save, holding them in range", () => {
    const rig = {
      ...defaultSceneLighting(),
      lights: [
        { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4, temperature: 2700, channels: 6 },
        { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, temperature: 400, channels: 1 },
        { kind: "spot", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, temperature: "warm", channels: 0 },
      ],
    };
    const back = parseSceneLighting(JSON.parse(JSON.stringify(rig)))!;
    expect(back.lights[0]).toMatchObject({ temperature: 2700, channels: 6 });
    expect(back.lights[1]!.temperature).toBe(MIN_LIGHT_TEMPERATURE);
    expect(back.lights[1]!.channels).toBeUndefined();
    expect(back.lights[2]!.temperature).toBeUndefined();
    expect(back.lights[2]!.channels).toBe(0);
  });

  it("brings a light's temperature into the bounce lights, and lets the cart's sun replace the key's", () => {
    const rig = { ...defaultSceneLighting(), lights: [{ kind: "directional" as const, direction: [0, 1, 0] as const, color: [1, 1, 1] as const, intensity: 1, temperature: 3000 }] };
    const frame = withCartSun(rig, { direction: [0, 1, 0], color: [1, 1, 1] });
    expect(frame.lights[0]!.temperature).toBeUndefined();
    const lamp: SceneLight = { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4, temperature: 2000 };
    const bounce = bounceLightsFor(rig, rig, [lamp]);
    expect(bounce.points[0]!.color[0]).toBeGreaterThan(bounce.points[0]!.color[2]!);
    // The authored key is the reference, so its own colour bounces white.
    for (const c of bounce.sun!.color) expect(c).toBeCloseTo(1, 6);
  });
});

function floor(): MeshAsset {
  return {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  };
}
