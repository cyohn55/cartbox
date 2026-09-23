/**
 * The procedural sky dome + distance fog (Modern tier). Covers the panorama bake
 * (deterministic, sky above / mist below, mountains on the horizon), the camera
 * backdrop fill lining up with the projection, the rig parse, and fog in the
 * software rasteriser — including that a scene without fog is byte-identical.
 */

import { describe, expect, it } from "vitest";

import {
  bakeSkyPanorama,
  defaultProceduralSky,
  downsamplePanorama,
  fogFactor,
  parseSceneLighting,
  projectionMatrix,
  renderMeshScene,
  renderSkyBackground,
  setSceneFog,
  setSceneSky,
  defaultSceneLighting,
  viewMatrix,
  type MeshAsset,
  type ProceduralSky,
} from "@cartbox/editor";

const W = 128;
const H = 64;

function px(map: { width: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number] {
  const o = (y * map.width + x) * 4;
  return [map.data[o]!, map.data[o + 1]!, map.data[o + 2]!];
}

const flatSky: ProceduralSky = {
  ...defaultProceduralSky(),
  clouds: 0,
  mountains: [],
};

describe("bakeSkyPanorama", () => {
  it("is deterministic and opaque", () => {
    const a = bakeSkyPanorama(defaultProceduralSky(), W, H);
    const b = bakeSkyPanorama(defaultProceduralSky(), W, H);
    expect(a.width).toBe(W);
    expect(a.height).toBe(H);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
  });

  it("grades from a deep zenith to a bright horizon, with mist below", () => {
    const map = bakeSkyPanorama(flatSky, W, H);
    // Pick a column facing away from the sun so the glow doesn't interfere.
    const x = 3;
    const zenith = px(map, x, 0);
    const horizon = px(map, x, H / 2 - 1);
    const below = px(map, x, H - 1);
    const sum = (c: number[]) => c[0]! + c[1]! + c[2]!;
    expect(sum(horizon)).toBeGreaterThan(sum(zenith)); // hazy horizon is brighter
    expect(zenith[2]).toBeGreaterThan(zenith[0]); // the zenith is blue
    expect(Math.abs(below[0] - flatSky.below[0] * 255)).toBeLessThan(60); // valley mist
  });

  it("raises mountains above the horizon where the sky was", () => {
    const clear = bakeSkyPanorama(flatSky, 256, 128);
    const peaks = bakeSkyPanorama({ ...flatSky, mountains: defaultProceduralSky().mountains }, 256, 128);
    // A few degrees above the horizon: some columns must now be mountain.
    const row = 64 - 4;
    let changed = 0;
    for (let x = 0; x < 256; x += 1) {
      const a = px(clear, x, row);
      const b = px(peaks, x, row);
      if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 12) changed += 1;
    }
    expect(changed).toBeGreaterThan(20);
    // …but the zenith is untouched.
    expect(px(peaks, 10, 0)).toEqual(px(clear, 10, 0));
  });

  it("downsamples to a small IBL copy by box filtering", () => {
    const map = bakeSkyPanorama(flatSky, 64, 32);
    const small = downsamplePanorama(map, 4);
    expect(small.width).toBe(16);
    expect(small.height).toBe(8);
    const m = px(map, 0, 0);
    expect(Math.abs(px(small, 0, 0)[2] - m[2])).toBeLessThan(20);
  });
});

describe("renderSkyBackground", () => {
  it("shows the zenith looking up and the horizon looking level", () => {
    const map = bakeSkyPanorama(flatSky, 256, 128);
    const out = new Uint8ClampedArray(64 * 48 * 4);
    const projection = projectionMatrix(Math.PI / 3, 64 / 48, 0.1, 100);

    renderSkyBackground(out, 64, 48, viewMatrix([0, 0, 0], [1, 0, 0]), projection, map);
    const level = [out[(24 * 64 + 32) * 4]!, out[(24 * 64 + 32) * 4 + 2]!];

    // Look (almost) straight up.
    renderSkyBackground(out, 64, 48, viewMatrix([0, 0, 0], [0.01, 1, 0]), projection, map);
    const up = [out[(24 * 64 + 32) * 4]!, out[(24 * 64 + 32) * 4 + 2]!];

    expect(level[0]!).toBeGreaterThan(up[0]!); // horizon haze is paler than the zenith
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255); // fully opaque backdrop
  });
});

describe("the lighting rig's sky and fog", () => {
  it("round-trips a sky dome and fog, and omits them when unauthored", () => {
    const base = defaultSceneLighting();
    expect(parseSceneLighting(JSON.parse(JSON.stringify(base)))).toEqual(base);
    const rig = setSceneFog(setSceneSky(base, defaultProceduralSky()), { color: [0.7, 0.8, 0.9], density: 0.05, start: 4, max: 0.5 });
    const parsed = parseSceneLighting(JSON.parse(JSON.stringify(rig)))!;
    expect(parsed.sky).toEqual(rig.sky);
    expect(parsed.fog).toEqual(rig.fog);
  });

  it("clamps a malformed sky/fog instead of trusting it", () => {
    const parsed = parseSceneLighting({
      sky: { clouds: 7, mountains: [{ height: 999, peaks: -3 }, "junk"], zenith: "blue" },
      fog: { density: -1, max: 4 },
    })!;
    expect(parsed.sky!.clouds).toBe(1);
    expect(parsed.sky!.mountains).toHaveLength(1);
    expect(parsed.sky!.mountains[0]!.height).toBe(60);
    expect(parsed.sky!.mountains[0]!.peaks).toBe(1);
    expect(parsed.sky!.zenith).toEqual(defaultProceduralSky().zenith);
    expect(parsed.fog!.density).toBe(0);
    expect(parsed.fog!.max).toBe(1);
  });
});

describe("distance fog", () => {
  const fog = { color: [1, 1, 1] as const, density: 0.5, start: 2, max: 0.75 };

  it("is zero before its start, grows with distance, and caps at max", () => {
    expect(fogFactor(fog, 1)).toBe(0);
    expect(fogFactor(fog, 3)).toBeGreaterThan(0);
    expect(fogFactor(fog, 4)).toBeGreaterThan(fogFactor(fog, 3));
    expect(fogFactor(fog, 1000)).toBe(0.75);
  });

  function quad(pbr: boolean): MeshAsset {
    return {
      name: "q",
      primitives: [
        {
          positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
          normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: pbr
            ? { name: "m", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 }
            : { name: "m", baseColorFactor: [0.2, 0.2, 0.2, 1], baseColorImage: null },
        },
      ],
    };
  }

  function draw(pbr: boolean, withFog: boolean, distance: number): Uint8ClampedArray {
    const w = 16;
    const h = 16;
    const out = new Uint8ClampedArray(w * h * 4);
    renderMeshScene([{ mesh: quad(pbr), model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], {
      width: w,
      height: h,
      out,
      depth: new Float32Array(w * h),
      view: viewMatrix([0, 0, distance], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 100),
      background: [0, 0, 0, 255],
      tonemap: { exposure: 1 },
      ...(withFog ? { fog } : {}),
    });
    return out;
  }

  it("brightens a distant PBR surface toward the fog colour", () => {
    const centre = (8 * 16 + 8) * 4;
    const clear = draw(true, false, 6)[centre]!;
    const fogged = draw(true, true, 6)[centre]!;
    expect(fogged).toBeGreaterThan(clear);
  });

  it("leaves fantasy (non-PBR) materials byte-identical", () => {
    expect(Array.from(draw(false, true, 6))).toEqual(Array.from(draw(false, false, 6)));
  });
});
