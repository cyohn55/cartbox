/**
 * The painted landscape in front of a physical sky (AAA_FIDELITY_ROADMAP.md
 * F11a-9): a physical sky (F5a) can keep its painted valley mist and mountain
 * ranges, so a map re-lit under one keeps the horizon it was drawn with. On
 * every tier they are painted into the sky's 8-bit copy; on the AAA tier the
 * presenter lays them over its per-pixel sky, as the painted sky shows.
 */

import { describe, expect, it } from "vitest";

import { atmosphereLuts, bakeSkyPanorama, defaultProceduralSky, parseAtmosphere, projectionMatrix, resolveAtmosphere, sunDiscRadiance, viewMatrix, type DecodedTexture, type ProceduralSky } from "@cartbox/editor";
import { GpuPresenter, packAtmosphereSkyUniforms } from "@cartbox/player";
import { ruinLighting } from "../packages/editor/src/model/ruinScene";

const W = 256;
const H = 128;
const BASE = [80, 120, 200] as const;
/** A uniform panorama standing in for the atmosphere's exposed copy. */
const flat = (): DecodedTexture => {
  const data = new Uint8ClampedArray(16 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...BASE, 255], i);
  return { width: 16, height: 8, data };
};
const physical = (landscape: boolean, haze?: number): ProceduralSky => {
  const sky = defaultProceduralSky();
  return {
    ...sky,
    objects: [],
    ...(haze !== undefined ? { mountains: sky.mountains.map((m) => ({ ...m, haze })) } : {}),
    atmosphere: landscape ? { landscape: true } : {},
  };
};
const elevationOf = (y: number) => Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
const at = (map: DecodedTexture, x: number, y: number) => Array.from(map.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

describe("the setting", () => {
  it("is kept only when it is true, and survives a save", () => {
    expect(parseAtmosphere({ landscape: true })).toEqual({ landscape: true });
    expect(parseAtmosphere({ landscape: "yes" })).toEqual({});
    expect(parseAtmosphere(JSON.parse(JSON.stringify({ mie: 2, landscape: true })))).toEqual({ mie: 2, landscape: true });
  });

  it("leaves the F11b ruin's physical sky as it was", () => {
    expect(ruinLighting().sky?.atmosphere?.landscape).toBeUndefined();
  });
});

describe("the bake over a physical sky", () => {
  it("paints nothing over the air without it: the landscape stays hidden, and nothing is covered", () => {
    const map = bakeSkyPanorama(physical(false), W, H, flat(), { sunLayer: true, coverage: true });
    for (let y = 0; y < H; y += 7) for (let x = 0; x < W; x += 11) expect(at(map, x, y)).toEqual([...BASE, 0]);
  });

  it("with it, lays the valley mist below the horizon and the ranges along it, and says what they cover", () => {
    const map = bakeSkyPanorama(physical(true), W, H, flat(), { sunLayer: true, coverage: true });
    // Overhead: the air as it was, uncovered.
    for (let x = 0; x < W; x += 9) expect(at(map, x, 4)).toEqual([...BASE, 0]);
    // Straight down: the mist, fully covering.
    const bottom = at(map, 40, H - 2);
    expect(bottom[3]).toBe(255);
    expect(bottom.slice(0, 3)).not.toEqual([...BASE]);
    // Just above the horizon, the ranges cover a good share of the columns.
    const y = Math.floor(H / 2) - 2;
    expect(elevationOf(y)).toBeGreaterThan(0);
    let covered = 0;
    for (let x = 0; x < W; x += 1) if (at(map, x, y)[3]! > 230) covered += 1;
    expect(covered / W).toBeGreaterThan(0.5);
    // Without coverage, alpha is the sun layer's (none: an imported panorama paints its own sun).
    const plain = bakeSkyPanorama(physical(true), W, H, flat(), { sunLayer: true });
    expect(at(plain, 40, H - 2)[3]).toBe(0);
    expect(at(plain, 40, H - 2).slice(0, 3)).toEqual(bottom.slice(0, 3));
  });

  it("fades the ranges toward the air behind them, not the painted horizon", () => {
    // Haze 1: a range is all aerial perspective, so it takes the panorama's horizon colour.
    const map = bakeSkyPanorama({ ...physical(true, 1), horizon: [1, 0, 0] }, W, H, flat(), { sunLayer: true, coverage: true });
    const y = Math.floor(H / 2) - 2;
    let seen = 0;
    for (let x = 0; x < W; x += 1) {
      const texel = at(map, x, y);
      if (texel[3]! < 250) continue;
      seen += 1;
      for (let c = 0; c < 3; c += 1) expect(Math.abs(texel[c]! - BASE[c]!)).toBeLessThanOrEqual(2);
    }
    expect(seen).toBeGreaterThan(W / 2);
  });
});

describe("the AAA sky pass's uniforms", () => {
  const EARTH = resolveAtmosphere({});
  const sun = [0, 1, 0] as [number, number, number];
  const base = {
    map: flat(),
    view: viewMatrix([0, 1, 0], [0, 1, -1]),
    projection: projectionMatrix(Math.PI / 3, 2, 0.1, 100),
    sun: null,
    clouds: [],
    time: 0,
  };
  const atmosphere = { atmosphere: EARTH, sun, sunRadiance: [1, 1, 1] as [number, number, number], disc: sunDiscRadiance(atmosphereLuts(EARTH), sun, [1, 1, 1]) };
  it("carry the exposure the features are undone under, and whether there are any", () => {
    expect(Array.from(packAtmosphereSkyUniforms({ ...base, atmosphere }, 8, 4).subarray(38, 40))).toEqual([0, 0]);
    const features = flat();
    expect(Array.from(packAtmosphereSkyUniforms({ ...base, atmosphere: { ...atmosphere, features } }, 8, 4, undefined, 1.5).subarray(38, 40))).toEqual([1.5, 1]);
    expect(Array.from(packAtmosphereSkyUniforms({ ...base, atmosphere: { ...atmosphere, features } }, 8, 4, undefined, 0.5, true).subarray(38, 40))).toEqual([0.5, 2]);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 40_000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

describe.skipIf(!device)("the AAA backdrop, on a real device", { timeout: 120_000 }, () => {
  const PW = 64;
  const PH = 32;
  const EARTH = resolveAtmosphere({});
  const LUTS = atmosphereLuts(EARTH);
  const sun: [number, number, number] = [Math.cos(0.6), Math.sin(0.6), 0];
  const view = viewMatrix([0, 1, 0], [0, 1.3, -1]);
  const projection = projectionMatrix(Math.PI / 3, PW / PH, 0.1, 100);
  const read = async (texture: any): Promise<Uint8Array> => {
    const bytesPerRow = 256;
    const buffer = device.createBuffer({ size: bytesPerRow * PH, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: PH }, { width: PW, height: PH });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const rows = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    const out = new Uint8Array(PW * PH * 4);
    for (let y = 0; y < PH; y += 1) out.set(rows.subarray(y * bytesPerRow, y * bytesPerRow + PW * 4), y * PW * 4);
    return out;
  };
  /** A feature layer: the lower half of the panorama covered by a painted colour, the upper half clear. */
  const features = (colour: readonly number[]): DecodedTexture => {
    const w = 32;
    const h = 16;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = h / 2; y < h; y += 1) for (let x = 0; x < w; x += 1) data.set([...colour, 255], (y * w + x) * 4);
    return { width: w, height: h, data };
  };

  it("lays the painted features over the air as the painted sky shows them, under either curve and any exposure", async () => {
    const presenter = new GpuPresenter(device, PW, PH, { hdr: true });
    const out = device.createTexture({ size: { width: PW, height: PH }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    const painted = [150, 120, 90];
    const atmosphere = { atmosphere: EARTH, sun, sunRadiance: [1, 1, 1], disc: sunDiscRadiance(LUTS, sun, [1, 1, 1]) };
    const sky = (withFeatures: boolean) => ({ map: features(painted), view, projection, sun: null, clouds: [], time: 0, atmosphere: { ...atmosphere, features: withFeatures ? features(painted) : null } });
    for (const authored of [false, true]) {
      for (const exposure of [1.1, 0.4]) {
        device.pushErrorScope("validation");
        presenter.present({ base: { kind: "sky", sky: sky(false) }, scene: null, tonemap: { exposure, authored } } as any, out, "rgba8unorm");
        const bare = await read(out);
        presenter.present({ base: { kind: "sky", sky: sky(true) }, scene: null, tonemap: { exposure, authored } } as any, out, "rgba8unorm");
        const laid = await read(out);
        const error = await settled(device.popErrorScope());
        expect(error ? String((error as any).message ?? error) : null).toBeNull();
        // The view looks up at 17°: the top rows are clear air, the bottom rows look below the horizon.
        let worstCovered = 0;
        let worstClear = 0;
        for (let x = 4; x < PW; x += 8) {
          for (let k = 0; k < 3; k += 1) {
            worstClear = Math.max(worstClear, Math.abs(laid[(1 * PW + x) * 4 + k]! - bare[(1 * PW + x) * 4 + k]!));
            worstCovered = Math.max(worstCovered, Math.abs(laid[((PH - 2) * PW + x) * 4 + k]! - painted[k]!));
          }
        }
        // Clear air is the atmosphere's as it was; a covered pixel shows as painted.
        expect(worstClear).toBe(0);
        expect(worstCovered).toBeLessThanOrEqual(3);
      }
    }
    out.destroy();
    presenter.dispose();
  });
});
