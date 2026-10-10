/**
 * The sky's sun moves with the cart's (a follow-up to HALO_INFINITE_STYLE_ROADMAP.md
 * I17): the player bakes its sky as a sun layer — no glow, alpha the share of
 * the glow each texel lets through — and draws the glow live toward the
 * frame's sun, on the backdrop and in the reflections. Where the cart's sun is
 * the authored one, the sky looks as it did.
 */

import { describe, expect, it } from "vitest";
import {
  bakeSkyPanorama,
  bakeVistas,
  defaultProceduralSky,
  downsamplePanorama,
  panoramaWithSun,
  projectionMatrix,
  renderSkyBackground,
  serializeMeshAsset,
  skySun,
  sunGlow,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type ProceduralSky,
  type SceneLighting,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { withCartSun } from "../packages/player/src/mesh/dynamicLights";

const W = 256;
const H = 128;
const SKY: ProceduralSky = defaultProceduralSky();
const projection = projectionMatrix(Math.PI / 3, 1, 0.1, 100);

/** The backdrop looking toward `at`, 48 × 48. */
function look(map: DecodedTexture, at: readonly [number, number, number], sun: Parameters<typeof renderSkyBackground>[9] = null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(48 * 48 * 4);
  // A 2-pixel grid: cells of 2.5° (a 720p frame's are under 1°).
  renderSkyBackground(out, 48, 48, viewMatrix([0, 0, 0], [...at]), projection, map, 2, 1, null, sun);
  return out;
}

const luma = (out: Uint8ClampedArray, x: number, y: number) => {
  const o = (y * 48 + x) * 4;
  return 0.2126 * out[o]! + 0.7152 * out[o + 1]! + 0.0722 * out[o + 2]!;
};

/** The panorama texel looking along (dx, dy, dz). */
function texel(map: DecodedTexture, d: readonly [number, number, number]): number {
  const len = Math.hypot(...d);
  const u = Math.atan2(d[2] / len, d[0] / len) / (2 * Math.PI) + 0.5;
  const v = Math.acos(d[1] / len) / Math.PI;
  return (Math.min(map.height - 1, Math.floor(v * map.height)) * map.width + Math.min(map.width - 1, Math.floor(u * map.width))) * 4;
}

describe("the sun's glow", () => {
  it("is the bake's own curve", () => {
    for (const c of [0, 0.3, 0.5, 0.9, 0.99, 0.999, 1]) {
      expect(sunGlow(c)).toBeCloseTo(Math.pow(c, 6) * 0.18 + Math.pow(c, 64) * 0.25 + (c > 0.99 ? Math.pow(c, 1500) * 0.6 : 0), 12);
    }
    expect(sunGlow(-0.5)).toBe(0);
  });
});

describe("a sun layer", () => {
  const baked = bakeSkyPanorama(SKY, W, H);
  const layer = bakeSkyPanorama(SKY, W, H, null, { sunLayer: true });

  it("is the sky without the glow, and keeps how much of it shows: all in clear sky, less under cloud, none on the mist", () => {
    const clear = bakeSkyPanorama({ ...SKY, clouds: 0, mountains: [] }, W, H, null, { sunLayer: true });
    expect(clear.data[texel(clear, [0, 1, 0]) + 3]).toBe(255);
    expect(clear.data[texel(clear, [0.3, -0.6, 0.2]) + 3]).toBe(0);
    // Under the default sky's clouds, somewhere overhead lets less through.
    let least = 255;
    for (let i = 3; i < (H / 3) * W * 4; i += 4) least = Math.min(least, layer.data[i]!);
    expect(least).toBeLessThan(120);
    // Toward the sun the bake is brighter than the layer by the glow.
    const o = texel(baked, SKY.sunDirection);
    expect(baked.data[o]! - layer.data[o]!).toBeGreaterThan(80);
  });

  it("draws, with its sun where the sky put it, as the sky baked with the glow does", () => {
    for (const at of [SKY.sunDirection, [1, 0.1, 0], [-0.3, 0.9, -0.2]] as const) {
      const a = look(baked, at);
      const b = look(layer, at, skySun(SKY));
      let sum = 0, worst = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let k = 0; k < 3; k += 1) {
          const d = Math.abs(a[i + k]! - b[i + k]!);
          sum += d;
          worst = Math.max(worst, d);
        }
      }
      // The live glow is sharper than the bake's texels round the core, the same elsewhere.
      expect(sum / ((a.length / 4) * 3)).toBeLessThan(0.6);
      expect(worst).toBeLessThan(40);
    }
  });

  it("moves the glow with the sun", () => {
    const evening: [number, number, number] = [-0.8, 0.5, 0.4];
    // Looking where the sun was: only the sky. Looking where it is: the sun.
    const old = look(layer, SKY.sunDirection, { direction: evening, color: SKY.sunColor });
    const noon = look(layer, SKY.sunDirection, skySun(SKY));
    expect(luma(noon, 24, 24) - luma(old, 24, 24)).toBeGreaterThan(60);
    const toward = look(layer, evening, { direction: evening, color: SKY.sunColor });
    const without = look(layer, evening, null);
    expect(luma(toward, 24, 24) - luma(without, 24, 24)).toBeGreaterThan(60);
    // A red sun paints a red glow.
    const red = look(layer, evening, { direction: evening, color: [1, 0.3, 0.1] });
    const o = (24 * 48 + 24) * 4;
    expect(red[o]! - without[o]!).toBeGreaterThan((red[o + 2]! - without[o + 2]!) * 3);
  });

  it("hides the glow behind mountains and below the horizon", () => {
    const low: [number, number, number] = [0.3, -0.2, 0.9];
    const lit = look(layer, low, { direction: low, color: SKY.sunColor });
    const dark = look(layer, low, null);
    expect(Math.abs(luma(lit, 24, 24) - luma(dark, 24, 24))).toBeLessThan(1);
    // A sun just above a ridge glows over the sky, not over the rock in front of it.
    const peaks = bakeSkyPanorama({ ...SKY, clouds: 0, mountains: [{ height: 25, peaks: 4, rock: [0.3, 0.3, 0.3], snow: [0.3, 0.3, 0.3], snowLine: 2, haze: 0, seed: 3 }] }, W, H, null, { sunLayer: true });
    let rock = 0, sky = 0;
    for (let i = 3; i < peaks.data.length; i += 4) {
      const y = Math.floor(i / 4 / W);
      if (y > H * 0.36 && y < H * 0.48) {
        if (peaks.data[i]! < 10) rock += 1;
        else if (peaks.data[i]! > 245) sky += 1;
      }
    }
    expect(rock).toBeGreaterThan(100);
    expect(sky).toBeGreaterThan(100);
  });

  it("is none on an imported panorama, which paints its own sun", () => {
    const grey = { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4).fill(128) };
    const imported = bakeSkyPanorama({ ...SKY, panorama: { mime: "image/png", data: "", exposure: 1, yaw: 0 } }, W, H, grey, { sunLayer: true });
    expect(imported.data.filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
    const at = SKY.sunDirection;
    expect(look(imported, at, skySun(SKY))).toEqual(look(imported, at, null));
  });

  it("gives the reflections a sun where it is now, its core's light kept in the small copy", () => {
    const small = downsamplePanorama(layer, 8);
    const evening: [number, number, number] = [-0.8, 0.5, 0.4];
    const noon = panoramaWithSun(small, skySun(SKY), 4);
    const dusk = panoramaWithSun(small, { direction: evening, color: SKY.sunColor }, 4);
    expect(noon.data[texel(noon, SKY.sunDirection)]!).toBeGreaterThan(dusk.data[texel(dusk, SKY.sunDirection)]! + 50);
    expect(dusk.data[texel(dusk, evening)]!).toBeGreaterThan(noon.data[texel(noon, evening)]! + 50);
    // Opaque, like any reflections copy; and the same light as the full map's, downsampled.
    expect(noon.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
    const full = downsamplePanorama(panoramaWithSun(layer, skySun(SKY)), 8);
    let total = 0, fullTotal = 0;
    for (let i = 0; i < noon.data.length; i += 4) {
      total += noon.data[i]!;
      fullTotal += full.data[i]!;
    }
    expect(Math.abs(total - fullTotal) / fullTotal).toBeLessThan(0.01);
  });

  it("is hidden by a vista as it covers the sky, but for what its haze lets through", () => {
    const map = { width: 128, height: 64, data: new Uint8ClampedArray(128 * 64 * 4).fill(200) };
    const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const wall = (distance: number): MeshAsset => ({
      name: "wall",
      primitives: [
        {
          positions: Float32Array.from([distance, -100, -100, distance, -100, 100, distance, 100, 100, distance, 100, -100]),
          normals: Float32Array.from([-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]),
          material: { name: "m", baseColorFactor: [0.3, 0.3, 0.3, 1], baseColorImage: null },
        },
      ],
    });
    const clear = bakeVistas(map, [{ haze: 0, instances: [{ mesh: wall(300), model: identity }] }], [0, 0, 0], {}, undefined, null, true);
    const hazy = bakeVistas(map, [{ haze: 0.5, instances: [{ mesh: wall(1000), model: identity }] }], [0, 0, 0], {}, undefined, null, true);
    const plain = bakeVistas(map, [{ haze: 0, instances: [{ mesh: wall(300), model: identity }] }], [0, 0, 0]);
    expect(clear.data[texel(clear, [1, 0, 0]) + 3]).toBe(0);
    expect(hazy.data[texel(hazy, [1, 0, 0]) + 3]).toBeGreaterThan(80);
    expect(hazy.data[texel(hazy, [1, 0, 0]) + 3]).toBeLessThan(170);
    expect(clear.data[texel(clear, [-1, 0, 0]) + 3]).toBe(200);
    // Without a sun layer, alpha is left alone.
    expect(plain.data[texel(plain, [1, 0, 0]) + 3]).toBe(200);
  });
});

describe("the cart's sun", () => {
  const lighting = {
    ambient: 0.3,
    lights: [{ kind: "directional", direction: [0.4, 0.8, 0.6], color: [1, 0.9, 0.8], intensity: 2 }],
    environment: { sky: [0.5, 0.6, 0.8], horizon: [0.7, 0.7, 0.7], ground: [0.3, 0.3, 0.3], intensity: 1 },
    tonemap: { exposure: 1, mode: "aces" },
    shadows: false,
    sky: { ...SKY, clouds: 0, mountains: [] },
  } as unknown as SceneLighting;

  it("moves the sky's sun, coloured as it compares with the key it replaces", () => {
    const dusk = withCartSun(lighting, { direction: [-2, 1, 0], color: [2, 0.9, 0.4] });
    expect(dusk.sky!.sunDirection[0]).toBeCloseTo(-2 / Math.sqrt(5), 9);
    // Red as bright as the key's, green half, blue a quarter.
    expect(dusk.sky!.sunColor[0]).toBeCloseTo(SKY.sunColor[0], 9);
    expect(dusk.sky!.sunColor[1]).toBeCloseTo(SKY.sunColor[1] * 0.5, 9);
    expect(dusk.sky!.sunColor[2]).toBeCloseTo(SKY.sunColor[2] * 0.25, 9);
    expect(withCartSun({ ...lighting, sky: null }, { direction: [0, 1, 0], color: [1, 1, 1] }).sky).toBeNull();
  });

  it("is the sun the player's backdrop and reflections show", async () => {
    const floor: MeshAsset = {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: null,
          indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
          material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null },
        },
      ],
    };
    const sidecar = JSON.stringify({ version: 2, meshes: [{ id: "floor", name: "floor", mesh: serializeMeshAsset(floor), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], lighting });
    const scene = parseMeshScene(sidecar)!;
    const draws: { draw: SceneDraw; out: Uint8ClampedArray }[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (_i, d: SceneDraw) => void draws.push({ draw: d, out: new Uint8ClampedArray(d.out) }), dispose: () => {} };
    const size = 32;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, size, size, scene, renderer);
    surface.setHudMode(true);
    surface.setCameraOverride({ yaw: 0.6, pitch: -0.5, distance: 3, target: [0, 0.5, 0], fov: null, hud: true } as never);
    const frame = () => surface.blit(new Uint8Array(size * size * 4));
    frame();
    const first = draws.at(-1)!;
    const v = first.draw.view;
    // Put the cart's sun straight ahead of the camera.
    const ahead: [number, number, number] = [-v[2]!, -v[6]!, -v[10]!];
    const centre = (out: Uint8ClampedArray) => {
      const o = ((size / 2) * size + size / 2) * 4;
      return 0.2126 * out[o]! + 0.7152 * out[o + 1]! + 0.0722 * out[o + 2]!;
    };
    surface.setCartLights([{ position: ahead, range: 0, color: [2, 1.8, 1.6], sun: true }]);
    frame();
    const after = draws.at(-1)!;
    expect(centre(after.out) - centre(first.out)).toBeGreaterThan(60);
    // The reflections were redrawn, their sun ahead now.
    const map = after.draw.environment!.map!;
    expect(map).not.toBe(first.draw.environment!.map);
    expect(map.data[texel(map, ahead)]!).toBeGreaterThan(first.draw.environment!.map!.data[texel(map, ahead)]! + 40);
    // Unmoved, the same copy is kept.
    frame();
    expect(draws.at(-1)!.draw.environment!.map).toBe(map);
    surface.destroy();
  }, 60_000);
});
