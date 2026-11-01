/**
 * What the GPU bake lights by (AAA_FIDELITY_ROADMAP.md F3d-4): local and area
 * lights' bounce, metalness and textured albedo, and the sky the player
 * draws. On a real device each bake is held to what can be worked out by
 * hand: a light just above a black floor, under a wide grey ceiling, lights
 * the floor only by the ceiling's bounce, whose integral has a closed form.
 */

import { describe, expect, it } from "vitest";

import {
  buildBvh,
  decodeHdrLightmap,
  decodePngRgba,
  defaultSceneLighting,
  deserializeMeshAsset,
  encodeRgbaPng,
  footprintMean,
  layoutLightmap,
  linearToAuthored,
  type DecodedTexture,
  type EncodedImage,
  type MeshAsset,
  type Occluder,
  type SceneLight,
} from "@cartbox/editor";
import { environmentPanorama, parseMeshScene, sceneSkyEnvironment, type LinearPanorama } from "@cartbox/player";
import { bakeSceneLighting } from "../apps/web/src/lib/lightBake";
import { addMesh, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { bakeLightmapGpu, bakeLights, bakeSurfaces, packBakeLights, packLightmapScene, type BakeLight, type GpuLightBakeOptions } from "../packages/player/src/render/gpuLightmapper";
import { lightmapTexels } from "../packages/editor/src/model/lightmap";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A quad from a corner and two edges, facing `normal`, with UVs over the whole map. */
function quad(corner: number[], u: number[], v: number[], normal: number[], colour: number[], material: Record<string, unknown> = {}): MeshAsset {
  const p = [corner, corner.map((c, i) => c + u[i]!), corner.map((c, i) => c + u[i]! + v[i]!), corner.map((c, i) => c + v[i]!)];
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from(p.flat()),
        normals: Float32Array.from([...normal, ...normal, ...normal, ...normal]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1], ...material },
      },
    ],
  } as unknown as MeshAsset;
}

/** An RGBA texture of `w × h` from a function of the texel. */
function texture(w: number, h: number, at: (x: number, y: number) => readonly number[]): DecodedTexture {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) data.set([...at(x, y), 255].slice(0, 4), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const png = (t: DecodedTexture): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(t.data, t.width, t.height) }) as EncodedImage;
const decodePng = async (image: EncodedImage) => {
  const out = await decodePngRgba(image.bytes);
  return { width: out.width, height: out.height, data: new Uint8ClampedArray(out.data) };
};

describe("a surface's albedo and metalness for the bake", () => {
  // Left half red, right half blue, as the renderers read it (v up from the bottom row).
  const halves = texture(8, 8, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255]));

  it("reads a map's mean over a triangle's footprint, in linear light", () => {
    // The whole map: its mean, half red and half blue.
    const whole = footprintMean(halves, true, [0, 0], [1, 0], [0, 1]);
    const all = footprintMean(halves, true, [0, 0], [2, 0], [0, 2]);
    expect(all[0]).toBeCloseTo(0.5, 2);
    expect(all[2]).toBeCloseTo(0.5, 2);
    expect(whole[0]! + whole[2]!).toBeCloseTo(1, 2);
    // A sliver in the red half reads red; tiled many times over, the mean.
    footprintMean(halves, true, [0.1, 0.1], [0.15, 0.1], [0.1, 0.15]).forEach((c, i) => expect(c).toBeCloseTo([1, 0, 0, 1][i]!, 6));
    const tiled = footprintMean(halves, true, [0, 0], [9, 0], [0, 9]);
    expect(tiled[0]).toBeCloseTo(0.5, 3);
    // A base-colour map is decoded from sRGB; a data map is not.
    const grey = texture(4, 4, () => [128, 128, 128]);
    expect(footprintMean(grey, true, [0, 0], [1, 0], [0, 1])[0]).toBeCloseTo(srgb(128 / 255), 4);
    expect(footprintMean(grey, false, [0, 0], [1, 0], [0, 1])[0]).toBeCloseTo(128 / 255, 4);
    expect(linearToAuthored(srgb(0.6))).toBeCloseTo(0.6, 6);
  });

  it("gives each triangle its map's albedo and metalness, and leaves the plain bake as it was", () => {
    // Two triangles: the first over the red half's corner, the second across both.
    const mesh = quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 1, 1], { baseColorImage: png(halves) });
    const prim = mesh.primitives[0]!;
    (prim as { uvs: Float32Array }).uvs = Float32Array.from([0, 0, 0.2, 0, 0.2, 0.2, 1.3, 0.9]);
    const plain = buildBvh([{ mesh, model: IDENTITY }]);
    // Without its decoded map, the factor × 0.55 as before, no metal and full roughness.
    expect([...plain.col.subarray(0, 3)].map((c) => +c.toFixed(4))).toEqual([0.55, 0.55, 0.55]);
    expect([...plain.mr]).toEqual([0, 1, 0, 1]);
    expect([...plain.channels]).toEqual([1, 1]);
    const mr = texture(2, 2, () => [0, 128, 255]); // G roughness ½, B metal 1
    const occluder: Occluder = { mesh, model: IDENTITY, surfaces: [{ base: halves, metallic: 0.6, roughness: 0.8, metallicRoughness: mr }], lightChannels: 6 };
    const read = buildBvh([occluder]);
    const tri = (t: number) => [...read.col.subarray(t * 3, t * 3 + 3)].map((c) => srgb(c));
    const order = [...read.order];
    // The BVH keeps its triangles in input order in col (order is the leaf order).
    expect(order.sort()).toEqual([0, 1]);
    expect(tri(0)[0]).toBeCloseTo(1, 3);
    expect(tri(0)[2]).toBeCloseTo(0, 3);
    expect(tri(1)[0]).toBeGreaterThan(0.2);
    expect(tri(1)[2]).toBeGreaterThan(0.2);
    expect(read.mr[0]).toBeCloseTo(0.6, 5);
    expect(read.mr[1]).toBeCloseTo(0.8 * (128 / 255), 5);
    expect([...read.channels]).toEqual([6, 6]);
  });

  it("bounces the renderer's diffuse share, and a metal's colour as far as it is rough", () => {
    const mesh = quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 1, 1]);
    const share = (metallic: number, roughness: number) => packLightmapScene([{ mesh, model: IDENTITY, surfaces: [{ metallic, roughness }] }]).mats[0];
    expect(share(0, 0)).toBeCloseTo(1, 6);
    expect(share(1, 0)).toBeCloseTo(0, 6);
    expect(share(1, 0.5)).toBeCloseTo(0.5, 6);
    expect(share(0.5, 0)).toBeCloseTo(0.5, 6);
    // The triangle's channels ride in the albedo's w, as u32 bits.
    const scene = packLightmapScene([{ mesh, model: IDENTITY, lightChannels: 5 }]);
    expect(new Uint32Array(scene.mats.buffer)[3]).toBe(5);
  });

  it("resolves a mesh's surfaces as the renderer does, decoding its maps", async () => {
    const mesh: MeshAsset = {
      name: "two",
      primitives: [
        { ...quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 1, 1]).primitives[0]! },
        { ...quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], [1, 1, 1], { metallicFactor: 0.7, roughnessFactor: 0.3, baseColorImage: png(halves), metallicRoughnessImage: png(halves) }).primitives[0]! },
      ],
    } as unknown as MeshAsset;
    const asked: boolean[] = [];
    const surfaces = await bakeSurfaces(mesh, (image, data) => {
      asked.push(data);
      return decodePng(image);
    });
    // A plain material isn't shaded as PBR: no metal.
    expect(surfaces[0]).toMatchObject({ base: null, metallicRoughness: null, metallic: 0, roughness: 1 });
    expect(surfaces[1]).toMatchObject({ metallic: 0.7, roughness: 0.3 });
    expect(surfaces[1]!.base!.width).toBe(8);
    // The base colour as colour, the metal/roughness map as data.
    expect(asked.sort()).toEqual([false, true]);
  });
});

describe("the bake's lights", () => {
  it("packs the directional lights first, then the point, spot and area ones", () => {
    const lights: BakeLight[] = [
      { kind: "point", position: [1, 2, 3], radiance: [1, 1, 1], range: 4, falloff: "inverseSquare", channels: 2 },
      { direction: [0, 2, 0], radiance: [3, 2, 1] },
      { kind: "spot", position: [0, 1, 0], direction: [0, -2, 0], radiance: [1, 0, 0], outerAngle: 40, innerAngle: 20 },
      { kind: "area", shape: "disk", position: [0, 3, 0], direction: [0, -1, 0], size: [2, 1], radiance: [5, 5, 5] },
    ];
    const { data, directional, local } = packBakeLights(lights);
    expect([directional, local]).toEqual([1, 3]);
    const rec = (i: number, k: number) => [...data.subarray((i * 5 + k) * 4, (i * 5 + k) * 4 + 4)];
    expect(rec(0, 0)).toEqual([0, 1, 0, 0]);
    expect(rec(0, 1)).toEqual([3, 2, 1, 1]);
    expect(rec(1, 0)).toEqual([1, 2, 3, 1]);
    expect(rec(1, 1)[3]).toBe(2);
    expect(rec(1, 2)).toEqual([4, 0, 0, 1]);
    expect(rec(2, 0)[3]).toBe(2);
    expect(rec(2, 2)[1]).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 5);
    expect(rec(2, 2)[2]).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 5);
    expect(rec(2, 3).slice(0, 3)).toEqual([0, -1, 0]);
    // A disk's half widths are its radius; it faces down, a tangent across it.
    expect(rec(3, 0)[3]).toBe(4);
    expect(rec(3, 2)).toEqual([0, 1, 1, 1]);
    expect(rec(3, 3).slice(0, 3)).toEqual([0, -1, 0]);
    expect(Math.abs(rec(3, 4)[1]!)).toBeLessThan(1e-6);
  });

  it("takes a rig's lights in linear light, their temperature laid over them", () => {
    const lights: SceneLight[] = [
      { kind: "point", position: [0, 1, 0], color: [0.5, 0.5, 0.5], intensity: 4 },
      { kind: "area", position: [0, 1, 0], color: [1, 1, 1], intensity: 10, temperature: 3000 },
    ];
    const baked = bakeLights(lights);
    expect(baked[0]!.radiance[0]).toBeCloseTo(srgb(0.5) * 4, 5);
    expect(baked[0]!.kind).toBe("point");
    // Warm: more red than blue.
    expect(baked[1]!.radiance[0]).toBeGreaterThan(baked[1]!.radiance[2]);
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

/** Wait on a promise the device settles, ticking it meanwhile. */
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

/**
 * The analytic floor: a black floor's texel at the origin under a grey
 * Lambertian ceiling (linear albedo ρ) 1 m up, lit by a light at the floor
 * whose light reaching the ceiling at distance d is `toCeiling(d)` (its
 * cosine there, 1/d, included by the caller's falloff). The floor's
 * irradiance over π is 2ρ ∫ r · toCeiling(d) / d⁴ dr: the ceiling's radiance
 * seen at the texel's cosine, over the ceiling's own cosine and d².
 */
function underCeiling(rho: number, toCeiling: (d: number) => number): number {
  let sum = 0;
  const dr = 0.0005;
  for (let r = dr / 2; r < 20; r += dr) {
    const d = Math.hypot(r, 1);
    sum += (r * toCeiling(d)) / d ** 4;
  }
  return 2 * rho * sum * dr;
}

/** A panorama's irradiance over π on a floor facing up: its cosine-weighted mean over the upper hemisphere, texel by texel. */
function upIrradiance(pano: LinearPanorama): number[] {
  const out = [0, 0, 0];
  for (let y = 0; y < pano.height; y += 1) {
    const theta = (Math.PI * (y + 0.5)) / pano.height;
    if (theta >= Math.PI / 2) break;
    const weight = (Math.cos(theta) * Math.sin(theta) * (Math.PI / pano.height) * ((2 * Math.PI) / pano.width)) / Math.PI;
    for (let x = 0; x < pano.width; x += 1) for (let c = 0; c < 3; c += 1) out[c]! += pano.data[(y * pano.width + x) * 4 + c]! * weight;
  }
  return out;
}

describe.skipIf(!device)("the GPU bake's lights, metals and maps, on a real device", { timeout: 300_000 }, () => {
  const RHO = 0.5;
  const floor = quad([-0.1, 0, -0.1], [0.2, 0, 0], [0, 0, 0.2], [0, 1, 0], [0, 0, 0]);
  const ceilingMesh = (material: Record<string, unknown> = {}) => quad([-20, 1, -20], [40, 0, 0], [0, 0, 40], [0, -1, 0], [linearToAuthored(RHO), linearToAuthored(RHO), linearToAuthored(RHO)], material);
  const ceiling = (extra: Partial<Occluder> = {}, material: Record<string, unknown> = {}): Occluder => ({ mesh: ceilingMesh(material), model: IDENTITY, ...extra });
  const AT = [0, 0.001, 0] as [number, number, number];

  /** The floor's irradiance at its centre (RGB), baked with one bounce under a black sky. */
  async function lit(lights: BakeLight[], occluder: Occluder = ceiling(), options: GpuLightBakeOptions = {}): Promise<number[]> {
    const layout = layoutLightmap(floor, IDENTITY, { density: 20 });
    device.pushErrorScope("validation");
    const result = await settled(bakeLightmapGpu(device, layout, [{ mesh: layout.mesh, model: IDENTITY }, occluder], { samples: 512, bounces: 1, denoise: false, lights, ...options }));
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const texels = lightmapTexels(layout);
    let best = 0, bestD = Infinity;
    for (let j = 0; j < texels.index.length; j += 1) {
      const d = Math.hypot(texels.position[j * 3]!, texels.position[j * 3 + 2]!);
      if (d < bestD) [best, bestD] = [texels.index[j]!, d];
    }
    return [0, 1, 2].map((c) => result.hdr.irradiance[best * 3 + c]!);
  }

  it("bounces a point light off the ceiling by its inverse square, and by its range when it has one", async () => {
    const I = 2;
    const square = (await lit([{ kind: "point", position: AT, radiance: [I, I, I], falloff: "inverseSquare" }]))[1]!;
    // ∫ r / d⁷ dr = 1/5: 0.4 ρ I.
    expect(underCeiling(RHO, (d) => I / d ** 3)).toBeCloseTo(0.4 * RHO * I, 3);
    expect(square / (0.4 * RHO * I)).toBeGreaterThan(0.96);
    expect(square / (0.4 * RHO * I)).toBeLessThan(1.04);
    // The default falloff, (1 − d/range)², flat at the light.
    const ranged = (await lit([{ kind: "point", position: AT, radiance: [I, I, I], range: 3 }]))[1]!;
    const expected = underCeiling(RHO, (d) => (I * Math.max(0, 1 - d / 3) ** 2) / d);
    expect(ranged / expected).toBeGreaterThan(0.96);
    expect(ranged / expected).toBeLessThan(1.04);
  });

  it("narrows a spot light's bounce to its cone, and gives none pointed away", async () => {
    const I = 2;
    const cosOuter = Math.cos((30 * Math.PI) / 180);
    const up = (await lit([{ kind: "spot", position: AT, direction: [0, 1, 0], radiance: [I, I, I], falloff: "inverseSquare", outerAngle: 30, innerAngle: 0 }]))[1]!;
    const expected = underCeiling(RHO, (d) => {
      const ct = Math.min(1, Math.max(0, (1 / d - cosOuter) / (1 - cosOuter)));
      return ((I / d ** 2) * ct * ct * (3 - 2 * ct)) / d;
    });
    expect(up / expected).toBeGreaterThan(0.95);
    expect(up / expected).toBeLessThan(1.05);
    const down = (await lit([{ kind: "spot", position: AT, direction: [0, -1, 0], radiance: [I, I, I], falloff: "inverseSquare", outerAngle: 30, innerAngle: 0 }]))[1]!;
    expect(down).toBeLessThan(1e-4);
  });

  it("bounces an area light's luminance by its area, from its lit face only", async () => {
    // A small rectangle facing the ceiling: a Lambertian emitter, L·A·cos θ / π, so ρ L A / 3π at the floor.
    const L = 100;
    const A = 0.01;
    const rect = (direction: [number, number, number]): BakeLight => ({ kind: "area", shape: "rect", position: AT, direction, size: [0.1, 0.1], radiance: [L, L, L] });
    const up = (await lit([rect([0, 1, 0])]))[1]!;
    const expected = (RHO * L * A) / (3 * Math.PI);
    // Its intensity L·A·cos θ / π (cos θ = 1/d) over d², at the ceiling's cosine 1/d.
    expect(underCeiling(RHO, (d) => (L * A) / (Math.PI * d ** 4))).toBeCloseTo(expected, 4);
    expect(up / expected).toBeGreaterThan(0.95);
    expect(up / expected).toBeLessThan(1.05);
    expect((await lit([rect([0, -1, 0])]))[1]!).toBeLessThan(1e-4);
    // A disk of the same area, the same.
    const disk = (await lit([{ kind: "area", shape: "disk", position: AT, direction: [0, 1, 0], size: [2 * Math.sqrt(A / Math.PI), 0], radiance: [L, L, L] }]))[1]!;
    expect(disk / expected).toBeGreaterThan(0.95);
    expect(disk / expected).toBeLessThan(1.05);
  });

  it("lights only what shares one of its channels", async () => {
    const light: BakeLight = { kind: "point", position: AT, radiance: [2, 2, 2], falloff: "inverseSquare", channels: 2 };
    expect((await lit([light]))[1]!).toBeLessThan(1e-4);
    const shared = (await lit([light], ceiling({ lightChannels: 3 })))[1]!;
    expect(shared / (0.4 * RHO * 2)).toBeGreaterThan(0.96);
  });

  it("picks among many lights without bias", async () => {
    // One bright, seven dim and one out of reach: the bright one is picked most, the sum is what all of them give.
    const at = (x: number): [number, number, number] => [x, 0.001, 0];
    const lights: BakeLight[] = [
      { kind: "point", position: at(0), radiance: [1.75, 1.75, 1.75], falloff: "inverseSquare" },
      ...Array.from({ length: 7 }, (_, i): BakeLight => ({ kind: "point", position: at(0.01 * (i - 3)), radiance: [0.25 / 7, 0.25 / 7, 0.25 / 7], falloff: "inverseSquare" })),
      { kind: "point", position: [10, 0.5, 0], radiance: [5, 5, 5], range: 0.5 },
    ];
    const many = (await lit(lights))[1]!;
    expect(many / (0.4 * RHO * 2)).toBeGreaterThan(0.95);
    expect(many / (0.4 * RHO * 2)).toBeLessThan(1.05);
  });

  it("bounces a metal only as far as it is rough", async () => {
    const light: BakeLight = { kind: "point", position: AT, radiance: [2, 2, 2], falloff: "inverseSquare" };
    const dielectric = (await lit([light], ceiling({ surfaces: [{ metallic: 0, roughness: 0.2 }] })))[1]!;
    const mirror = (await lit([light], ceiling({ surfaces: [{ metallic: 1, roughness: 0 }] })))[1]!;
    const rough = (await lit([light], ceiling({ surfaces: [{ metallic: 1, roughness: 0.5 }] })))[1]!;
    expect(mirror).toBeLessThan(1e-4);
    expect(rough / dielectric).toBeCloseTo(0.5, 2);
  });

  it("bleeds a textured ceiling's own colour, where its factor × 0.55 bled grey", async () => {
    const red = png(texture(4, 4, () => [255, 0, 0]));
    const mesh = ceilingMesh({ baseColorImage: red, baseColorFactor: [1, 1, 1, 1] });
    const light: BakeLight = { kind: "point", position: AT, radiance: [2, 2, 2], falloff: "inverseSquare" };
    const surfaces = await bakeSurfaces(mesh, decodePng);
    const mapped = await lit([light], { mesh, model: IDENTITY, surfaces });
    expect(mapped[0]! / (0.4 * 1 * 2)).toBeGreaterThan(0.96);
    expect(mapped[1]!).toBeLessThan(1e-4);
    const flat = await lit([light], { mesh, model: IDENTITY });
    expect(flat[0]!).toBeCloseTo(flat[1]!, 6);
    expect(flat[0]! / (0.4 * srgb(0.55) * 2)).toBeGreaterThan(0.96);
  });

  it("bakes the editor's scene under the sky the player draws, not the rig's gradient", async () => {
    // An orange procedural sky over a rig whose gradient is blue.
    const lighting = {
      ...defaultSceneLighting(),
      lights: [],
      sky: { zenith: [0.95, 0.5, 0.2], horizon: [0.9, 0.6, 0.3], below: [0.4, 0.3, 0.2], sunDirection: [0, -1, 0], sunColor: [0, 0, 0], clouds: 0, cloudColor: [1, 1, 1], mountains: [], seed: 1 },
    };
    let sidecar = { ...emptyMeshSidecar(), lighting } as ReturnType<typeof emptyMeshSidecar>;
    sidecar = addMesh(sidecar, quad([-3, 0, -3], [6, 0, 0], [0, 0, 6], [0, 1, 0], [0.6, 0.6, 0.6]), "floor").sidecar;
    const scene = parseMeshScene(encodeMeshSidecar(sidecar)!)!;
    const environment = (await sceneSkyEnvironment(scene))!;
    expect(environment.map).toBeTruthy();
    const drawn = upIrradiance(environmentPanorama(environment));
    const gradient = upIrradiance(environmentPanorama({ sky: lighting.environment.sky, horizon: lighting.environment.horizon, ground: lighting.environment.ground, intensity: 1 } as Parameters<typeof environmentPanorama>[0]));
    expect(gradient[2]!).toBeGreaterThan(gradient[0]!);
    const baked = await settled(bakeSceneLighting(sidecar, { density: 2, rays: 64, bounces: 1, probeSpacing: 0, device }));
    const prim = deserializeMeshAsset(baked.meshes[0]!.mesh).primitives[0]!;
    const hdr = await decodeHdrLightmap(prim.material.lightmapHdrImage!.bytes);
    // The floor's middle, through its second UV set (v up from the atlas's bottom row).
    const uv = [0, 1].map((a) => (prim.uvs2![a]! + prim.uvs2![4 + a]!) / 2);
    const centre = (Math.floor((1 - uv[1]!) * hdr.height) * hdr.width + Math.floor(uv[0]! * hdr.width)) * 3;
    // Orange, as the drawn sky lights it.
    for (let c = 0; c < 3; c += 1) {
      expect(hdr.irradiance[centre + c]! / drawn[c]!).toBeGreaterThan(0.95);
      expect(hdr.irradiance[centre + c]! / drawn[c]!).toBeLessThan(1.05);
    }
    expect(hdr.irradiance[centre]!).toBeGreaterThan(2 * hdr.irradiance[centre + 2]!);
  });
});
